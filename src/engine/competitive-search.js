import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { MATE_SCORE, personalityMoveBonus } from './evaluation.js';
import { StrongSearchEngine } from './strong-search.js';
import { cheapVolatility, rootTacticalRisk, staticExchangeEval } from './tactics.js';

const MATE_RISK = 99_000;

function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

/**
 * Competitive Vanta search.
 *
 * The 50-game 1650 audit showed that the faster StrongSearchEngine solved the
 * raw depth bottleneck but still lost too many games to two families of error:
 * forcing checks just beyond the quiet horizon, and objectively attractive
 * root moves that the existing tactical verifier already knew were dangerous.
 *
 * This layer stays deliberately selective. It extends qsearch by one ply of
 * quiet checks and lets a catastrophic root-risk signal widen the rescue
 * window. Normal sacrifices and ordinary positional choices remain governed by
 * the objective alpha-beta score.
 */
export class CompetitiveSearchEngine extends StrongSearchEngine {
  /**
   * Search one layer of quiet checks at the qsearch frontier. Checks are a tiny
   * subset of legal quiet moves and are exactly the moves most likely to turn a
   * harmless-looking leaf into mate, a fork, or a forced material sequence.
   */
  quiescence(position, alpha, beta, ply, qply = 0) {
    this.qnodes++;
    if (position.halfmove >= 100 || position.isInsufficientMaterial()) return 0;

    const inCheck = position.isInCheck();
    let moves = inCheck ? position.legalMoves() : position.legalMoves({ capturesOnly: true });
    if (inCheck && moves.length === 0) return -MATE_SCORE + ply;

    const stand = this.staticEval(position);
    if (!inCheck) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }

    if (qply >= 7 || ply > 22 || this.timeUp()) return inCheck ? alpha : Math.max(alpha, stand);

    // The previous strong path only searched quiet checks when a promotion or
    // current check made cheapVolatility high. The audit's 141 quiet-horizon
    // mistakes show that was too restrictive. Search quiet checks at qply 0 in
    // every position, but only that first frontier so qsearch cannot explode.
    if (!inCheck && qply === 0) {
      const existing = new Set(moves.map(moveToUci));
      for (const move of position.legalMoves()) {
        const uci = moveToUci(move);
        if (existing.has(uci) || (move.flags & FLAGS.CAPTURE) || move.promotion) continue;
        if (position.makeMove(move).isInCheck()) {
          moves.push(move);
          existing.add(uci);
        }
      }
    }

    // In promotion races keep the original volatility behavior available for
    // future extensions without broadening ordinary qsearch beyond checks.
    const volatile = cheapVolatility(position) >= 48;

    moves = [...moves].sort((a, b) => {
      const av = PIECE_VALUES[typeOf(a.captured)] || 0;
      const bv = PIECE_VALUES[typeOf(b.captured)] || 0;
      const aa = PIECE_VALUES[typeOf(a.piece)] || 0;
      const ba = PIECE_VALUES[typeOf(b.piece)] || 0;
      const aCheck = !(a.flags & FLAGS.CAPTURE) && !a.promotion && position.makeMove(a).isInCheck() ? 1 : 0;
      const bCheck = !(b.flags & FLAGS.CAPTURE) && !b.promotion && position.makeMove(b).isInCheck() ? 1 : 0;
      return (bCheck * 70_000 + bv * 12 - ba) - (aCheck * 70_000 + av * 12 - aa);
    });

    for (const move of moves) {
      if (this.timeUp()) break;
      const next = position.makeMove(move);
      const givesCheck = next.isInCheck();
      if (!inCheck && (move.flags & FLAGS.CAPTURE) && !move.promotion && !givesCheck) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
        if (stand + victim + (volatile ? 145 : 110) < alpha) continue;
        if (attacker > victim + 130) {
          const see = staticExchangeEval(position, move, this.seeMemo);
          if (see < -100) continue;
        }
      }
      const score = -this.quiescence(next, -beta, -alpha, ply + 1, qply + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  /**
   * The tactical verifier is allowed to overrule the normal eight-centipawn
   * style window only when it has already identified a major concrete danger.
   * This is a seatbelt, not a second personality system.
   */
  personalitySelect(position, lines, bestFallback) {
    const initial = super.personalitySelect(position, lines, bestFallback);
    if (!initial?.move || !lines?.length || initial.risk < 700) return initial;

    const exact = lines.filter(line => line.exact !== false);
    const objectivePool = exact.length ? exact : lines;
    const bestScore = Math.max(...objectivePool.map(line => line.score));
    const catastrophic = initial.risk >= MATE_RISK;
    const rescueWindow = catastrophic ? 900 : initial.risk >= 850 ? 260 : 140;
    const targetRisk = catastrophic ? 700 : Math.min(650, initial.risk - 220);

    const candidates = lines
      .filter(line => line.score >= bestScore - rescueWindow)
      .map(line => {
        const risk = rootTacticalRisk(position, line.move, this.seeMemo);
        const personality = cheapVolatility(position) >= 55
          ? 0
          : clamp(personalityMoveBonus(position, line.move), -4, 4);
        return { ...line, risk, personality };
      })
      .filter(line => line.risk < targetRisk);

    if (!candidates.length) return initial;

    // Prefer an exact searched rescue when available. If every exact line is
    // the tactical collapse, a fail-low line is still preferable to a known
    // mate/major-piece catastrophe, provided it stayed inside the bounded
    // rescue window above.
    candidates.sort((a, b) => {
      if ((a.exact !== false) !== (b.exact !== false)) return a.exact === false ? 1 : -1;
      const ar = a.score + a.personality - Math.max(0, a.risk - 250) * 0.18;
      const br = b.score + b.personality - Math.max(0, b.risk - 250) * 0.18;
      return br - ar;
    });

    const pick = candidates[0];
    return {
      move: pick.move,
      score: pick.score + pick.personality,
      objectiveScore: pick.score,
      pv: pick.pv,
      risk: pick.risk,
      tacticalRescue: {
        from: moveToUci(initial.move),
        fromRisk: initial.risk,
        to: moveToUci(pick.move),
        toRisk: pick.risk,
        rescueWindow,
      },
    };
  }
}

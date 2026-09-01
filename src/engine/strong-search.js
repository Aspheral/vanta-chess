import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { SearchEngine } from './search.js';
import { MATE_SCORE, personalityMoveBonus } from './evaluation.js';
import { fastEvaluate } from './fast-evaluation.js';
import { cheapVolatility, rootTacticalRisk, staticExchangeEval } from './tactics.js';

const INF = 1_000_000;
const MATE_RISK = 99_000;

function nowMs() {
  return typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now();
}

function clamp(value, lo, hi) { return Math.max(lo, Math.min(hi, value)); }

/**
 * Search path used by competitive Vanta play.
 *
 * The original evaluator/personality system is intentionally retained for UI
 * analysis and style, but it was far too expensive inside alpha-beta. A 50-game
 * 1650 stress run showed a median completed depth of only 3 and 70% unstable
 * moves. This class keeps the same legal move generator, TT, PVS/LMR core and
 * tactical seatbelts while making the hot path dramatically cheaper.
 */
export class StrongSearchEngine extends SearchEngine {
  resetStats() {
    super.resetStats();
    this.lastClockCheckNodes = -256;
    this.clockExpired = false;
  }

  /** Avoid calling performance.now() thousands of times per move. */
  timeUp() {
    if (this.stopped || this.clockExpired) return true;
    const visited = this.nodes + this.qnodes;
    if (visited >= this.config.nodeLimit) return true;
    if (!this.deadline) return false;
    if (visited - this.lastClockCheckNodes < 256) return false;
    this.lastClockCheckNodes = visited;
    if (nowMs() >= this.deadline) this.clockExpired = true;
    return this.clockExpired;
  }

  /** Fast, stable leaf evaluation with the same hash cache contract. */
  staticEval(position, perspective = position.turn) {
    const key = `f:${position.hash.toString()}:${perspective}:${Math.min(position.fullmove, 15)}`;
    const cached = this.evalCache.get(key);
    if (cached !== undefined) return cached;
    const score = fastEvaluate(position, perspective);
    this.evalCache.set(key, score);
    if (this.evalCache.size > 50000) {
      let removed = 0;
      for (const k of this.evalCache.keys()) {
        this.evalCache.delete(k);
        if (++removed >= 10000) break;
      }
    }
    return score;
  }

  /**
   * Root PVS without recomputing expensive personality attack maps for every
   * candidate on every iterative-deepening pass. Style is applied once, after
   * objective search has completed.
   */
  searchRoot(position, depth, options = {}) {
    const excluded = new Set(options.excludeMoves || []);
    let moves = this.orderMoves(position, position.legalMoves(), 0, null)
      .filter(move => !excluded.has(moveToUci(move)));

    if (this.rootOrder.length) {
      const rank = new Map(this.rootOrder.map((uci, index) => [uci, index]));
      moves = [...moves].sort((a, b) => {
        const ar = rank.has(moveToUci(a)) ? rank.get(moveToUci(a)) : 999;
        const br = rank.has(moveToUci(b)) ? rank.get(moveToUci(b)) : 999;
        return ar - br;
      });
    }

    if (!moves.length) {
      const score = position.isInCheck() ? -MATE_SCORE : 0;
      return { bestMove: null, score, pv: [], lines: [], complete: true };
    }

    const lines = [];
    const path = [position.hash];
    const verifyWindow = Math.min(8, Math.max(0, this.config.selectionWindow ?? 0));
    let bestMove = null;
    let bestScore = -INF;
    let bestPv = [];
    let complete = true;

    for (const move of moves) {
      if (this.timeUp()) { complete = false; break; }
      const next = position.makeMove(move);
      let score;
      let pv = [];
      let exact = true;

      if (bestMove == null) {
        score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
      } else {
        const threshold = bestScore - verifyWindow;
        score = -this.negamax(next, depth - 1, -threshold - 1, -threshold, 1, pv, path);
        if (this.timeUp()) { complete = false; break; }
        if (score >= threshold) {
          pv = [];
          score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
        } else {
          exact = false;
        }
      }

      if (this.timeUp()) { complete = false; break; }
      const line = { move, score, pv: [move, ...pv], personality: 0, exact };
      lines.push(line);
      if (exact && score > bestScore) {
        bestScore = score;
        bestMove = move;
        bestPv = line.pv;
      }
    }

    lines.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return b.score - a.score;
    });
    if (bestMove == null && lines.length) {
      bestMove = lines[0].move;
      bestScore = lines[0].score;
      bestPv = lines[0].pv;
    }
    return {
      bestMove,
      score: bestScore,
      pv: bestPv,
      lines,
      complete: complete && lines.length === moves.length,
    };
  }

  /**
   * Lean quiescence. Legal SEE is still used when a capture looks materially
   * suspicious, but not for every capture in every q-node.
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

    if (!inCheck && qply === 0 && cheapVolatility(position) >= 48) {
      const existing = new Set(moves.map(moveToUci));
      for (const move of position.legalMoves()) {
        if (existing.has(moveToUci(move)) || (move.flags & FLAGS.CAPTURE) || move.promotion) continue;
        if (position.makeMove(move).isInCheck()) moves.push(move);
      }
    }

    // MVV-LVA first without root-level recursive SEE cost.
    moves = [...moves].sort((a, b) => {
      const av = PIECE_VALUES[typeOf(a.captured)] || 0;
      const bv = PIECE_VALUES[typeOf(b.captured)] || 0;
      const aa = PIECE_VALUES[typeOf(a.piece)] || 0;
      const ba = PIECE_VALUES[typeOf(b.piece)] || 0;
      return (bv * 12 - ba) - (av * 12 - aa);
    });

    for (const move of moves) {
      if (this.timeUp()) break;
      const next = position.makeMove(move);
      const givesCheck = next.isInCheck();
      if (!inCheck && (move.flags & FLAGS.CAPTURE) && !move.promotion && !givesCheck) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
        if (stand + victim + 110 < alpha) continue;
        // Only pay for recursive legal SEE on obviously dubious exchanges.
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
   * Personality is a tie-breaker, never a license to give away objective
   * strength. Only moves within eight centipawns of the best searched line can
   * receive a tiny style nudge.
   */
  personalitySelect(position, lines, bestFallback) {
    if (!lines?.length) {
      return {
        move: bestFallback.bestMove,
        score: bestFallback.score,
        objectiveScore: bestFallback.score,
        pv: bestFallback.pv,
        risk: bestFallback.bestMove ? rootTacticalRisk(position, bestFallback.bestMove, this.seeMemo) : 0,
      };
    }

    const exact = lines.filter(line => line.exact !== false);
    const pool = exact.length ? exact : lines;
    const bestScore = Math.max(...pool.map(line => line.score));
    if (Math.abs(bestScore) >= MATE_SCORE - 1000) {
      const forced = pool.find(line => line.score === bestScore) || pool[0];
      return { move: forced.move, score: bestScore, objectiveScore: bestScore, pv: forced.pv, risk: 0 };
    }

    const window = Math.min(8, Math.max(0, this.config.selectionWindow ?? 0));
    const eligible = pool.filter(line => line.score >= bestScore - window);
    const danger = cheapVolatility(position);
    const scored = eligible.map(line => {
      const personality = danger >= 55 ? 0 : clamp(personalityMoveBonus(position, line.move), -6, 6);
      const risk = rootTacticalRisk(position, line.move, this.seeMemo);
      const riskPenalty = risk >= MATE_RISK
        ? 1_000_000
        : risk >= 700
          ? 260 + (risk - 700) * 0.35
          : risk >= 300
            ? 65 + (risk - 300) * 0.12
            : 0;
      return { ...line, personality, risk, composite: line.score + personality - riskPenalty };
    }).sort((a, b) => b.composite - a.composite);

    const pick = scored[0] || pool[0];
    return {
      move: pick.move,
      score: pick.composite ?? pick.score,
      objectiveScore: pick.score,
      pv: pick.pv,
      risk: pick.risk || 0,
    };
  }
}

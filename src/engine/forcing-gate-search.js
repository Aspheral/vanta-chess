import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { MATE_SCORE } from './evaluation.js';
import { GateSearchEngine } from './gate-search.js';
import { cheapVolatility, staticExchangeEval } from './tactics.js';

const MAX_CHAINED_QUIET_CHECKS = 4;
const INITIAL_CHECK_VOLATILITY = 40;

/**
 * Gate-search experiment that lets a small number of quiet checking moves cross
 * the quiescence horizon. The previous frontier only considered quiet checks at
 * q-ply zero, so a forcing check, forced evasion, second quiet check sequence
 * could disappear exactly where mate threats became concrete.
 *
 * This remains deliberately bounded: normal capture qsearch is unchanged,
 * initial quiet checks still require tactical volatility, and only the position
 * immediately after a checked side's first evasion (q-ply two) gets a second
 * quiet-check probe. We cap added checks so this cannot become a second full
 * alpha-beta search hidden inside quiescence.
 */
export class ForcingGateSearchEngine extends GateSearchEngine {
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

    const probeInitialChecks = !inCheck && qply === 0 && cheapVolatility(position) >= INITIAL_CHECK_VOLATILITY;
    const probeContinuationChecks = !inCheck && qply === 2;
    if (probeInitialChecks || probeContinuationChecks) {
      const existing = new Set(moves.map(moveToUci));
      const quietChecks = [];
      for (const move of position.legalMoves()) {
        const uci = moveToUci(move);
        if (existing.has(uci) || (move.flags & FLAGS.CAPTURE) || move.promotion) continue;
        const next = position.makeMove(move);
        if (!next.isInCheck()) continue;
        quietChecks.push(move);
        if (quietChecks.length >= MAX_CHAINED_QUIET_CHECKS) break;
      }
      moves.push(...quietChecks);
    }

    // MVV-LVA first without root-level recursive SEE cost. Quiet checks sort
    // behind captures; their tactical value is established by recursion rather
    // than an artificial static bonus.
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
}

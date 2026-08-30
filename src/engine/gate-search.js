import { FLAGS, moveToUci } from '../chess/position.js';
import { MATE_SCORE } from './evaluation.js';
import { StrongSearchEngine } from './strong-search.js';

const INF = 1_000_000;

function rootCap(depth) {
  if (depth <= 3) return Infinity;
  if (depth === 4) return 16;
  if (depth === 5) return 12;
  return 8;
}

function isForcingRootMove(position, move) {
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
  return position.makeMove(move).isInCheck();
}

/**
 * Search variant dedicated to the 1650 literal-win gate.
 *
 * Vanta's primary 650 ms bottleneck is root breadth. It was spending most of
 * the clock re-searching every legal root move at every iterative-deepening
 * level, then dying with only depth 2-3 completed. This engine verifies every
 * legal move through depth three, then progressively narrows only the deeper
 * iterations to the candidates that survived that real search. A few forcing
 * moves are retained even when they fall outside the cap.
 *
 * Unlike the old practical-safety filter, nothing is discarded before it has
 * actually been searched. If a narrowed deeper iteration times out, the normal
 * SearchEngine contract automatically falls back to the last fully completed
 * broad iteration.
 */
export class GateSearchEngine extends StrongSearchEngine {
  search(position, options = {}) {
    // rootOrder is useful inside one iterative-deepening search, but UCI strings
    // from the previous *position* are arbitrary move-order noise. Keep the TT,
    // history and killers persistent while resetting stale root ordering.
    if (this.lastRootHash !== position.hash) this.rootOrder = [];
    this.lastRootHash = position.hash;
    return super.search(position, options);
  }

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

    const cap = rootCap(depth);
    if (Number.isFinite(cap) && moves.length > cap && this.rootOrder.length) {
      const kept = moves.slice(0, cap);
      const keptUci = new Set(kept.map(moveToUci));
      let forcingExtras = 0;
      for (const move of moves.slice(cap)) {
        if (forcingExtras >= 4) break;
        if (!isForcingRootMove(position, move)) continue;
        const uci = moveToUci(move);
        if (keptUci.has(uci)) continue;
        kept.push(move);
        keptUci.add(uci);
        forcingExtras++;
      }
      moves = kept;
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
}

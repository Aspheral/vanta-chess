import { FLAGS, moveToUci } from '../chess/position.js';
import { MATE_SCORE } from './evaluation.js';
import { GateSearchEngine } from './gate-search.js';
import { positionCriticality } from './tactics.js';

const INF = 1_000_000;

function normalRootCap(depth) {
  if (depth <= 2) return Infinity;
  if (depth === 3) return 10;
  if (depth === 4) return 7;
  if (depth === 5) return 5;
  if (depth === 6) return 4;
  return 3;
}

/**
 * Preserve candidates already admitted by the normal depth-three audition.
 * Critical positions stop collapsing that 10-move beam as aggressively, while
 * normal positions pay exactly the same root-search cost as GateSearchEngine.
 */
export function criticalRootCap(depth, criticality = 0) {
  const base = normalRootCap(depth);
  if (!Number.isFinite(base) || depth <= 3) return base;

  const c = Math.max(0, Math.min(100, Number(criticality) || 0));
  if (c >= 90) {
    if (depth === 4) return 10;
    if (depth === 5) return 8;
    if (depth === 6) return 6;
    return 5;
  }
  if (c >= 75) {
    if (depth === 4) return 9;
    if (depth === 5) return 7;
    if (depth === 6) return 5;
    return 4;
  }
  return base;
}

function isForcingRootMove(position, move) {
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
  return position.makeMove(move).isInCheck();
}

/**
 * GateSearchEngine with criticality-aware root preservation.
 *
 * The underlying alpha-beta, TT, qsearch, reductions, personality and safety
 * behavior are unchanged. Every legal move still receives the normal depth-two
 * audition. The only difference is that high-criticality positions preserve
 * more of the top ten roots during later iterations instead of pruning quiet
 * defensive resources before the tactical horizon resolves.
 */
export class CriticalSearchEngine extends GateSearchEngine {
  search(position, options = {}) {
    this.rootCriticality = positionCriticality(position);
    const result = super.search(position, options);
    return { ...result, rootCriticality: this.rootCriticality };
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

    const cap = criticalRootCap(depth, this.rootCriticality);
    if (Number.isFinite(cap) && moves.length > cap && this.rootOrder.length) {
      const kept = moves.slice(0, cap);
      const keptUci = new Set(kept.map(moveToUci));
      let forcingExtras = 0;
      for (const move of moves.slice(cap)) {
        if (forcingExtras >= 5) break;
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

    if (depth <= 2 && complete && lines.length === moves.length) {
      this.broadRootLines = lines.map(line => ({ ...line, pv: [...line.pv] }));
    }

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

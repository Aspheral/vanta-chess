import { FLAGS, moveToUci } from '../chess/position.js';
import { MATE_SCORE } from './evaluation.js';
import { GateSearchEngine } from './gate-search.js';
import { positionCriticality } from './tactics.js';
import { VANTA_PERSONALITY } from './personality.js';
import { isSeriouslyLosing, materialLead } from './draw-policy.js';

const INF = 1_000_000;
const STALEMATE_OBJECTIVE_THRESHOLD = -450;
const DESPERATE_STALEMATE_THRESHOLD = -700;
const STALEMATE_MATERIAL_DEFICIT = 500;
const STALEMATE_TRAP_WINDOW = 90;

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
 * The 1650 A/B therefore changes candidate retention only, not search rules.
 * The registered stress gate supplies Vanta's 420k production-minimum nodes.
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

function isStalemate(position) {
  return !position.isInCheck() && position.legalMoves().length === 0;
}

function shouldSeekStalemate(position, objectiveScore) {
  const numeric = Number(objectiveScore);
  const score = Number.isFinite(numeric) ? numeric : 0;
  const material = materialLead(position, position.turn);
  if (score <= DESPERATE_STALEMATE_THRESHOLD) return true;
  if (score <= STALEMATE_OBJECTIVE_THRESHOLD && material <= 0) return true;
  return material <= -STALEMATE_MATERIAL_DEFICIT && score <= 0;
}

function stalemateReplyStats(position, move) {
  const after = position.makeMove(move);
  const replies = after.legalMoves();
  if (!replies.length) {
    const immediate = !after.isInCheck();
    return {
      immediate,
      forced: immediate,
      stalematingReplies: immediate ? 1 : 0,
      replyCount: 0,
    };
  }

  let stalematingReplies = 0;
  for (const reply of replies) {
    const afterReply = after.makeMove(reply);
    if (isStalemate(afterReply)) stalematingReplies++;
  }

  return {
    immediate: false,
    forced: stalematingReplies === replies.length,
    stalematingReplies,
    replyCount: replies.length,
  };
}

/**
 * When Vanta is seriously losing, turn stalemate into an explicit swindle
 * objective. Guaranteed draws always override a losing continuation. If no
 * forced stalemate exists and the position is catastrophically bad, Vanta may
 * prefer a near-equal losing root that gives the opponent more ways to
 * accidentally stalemate it. The trap preference is deliberately limited to a
 * narrow objective window so desperation never replaces normal defense.
 */
export function selectDesperateStalemate(position, result = {}) {
  const objectiveValue = Number(result.objectiveScore ?? result.score ?? 0);
  const objective = Number.isFinite(objectiveValue) ? objectiveValue : 0;
  if (!shouldSeekStalemate(position, objective)) return null;

  const legal = position.legalMoves();
  for (const move of legal) {
    const after = position.makeMove(move);
    if (isStalemate(after)) {
      return {
        move,
        score: 0,
        kind: 'immediate-stalemate',
        forced: true,
        stalematingReplies: 1,
        replyCount: 0,
      };
    }
  }

  const candidates = new Map();
  if (result.move) {
    candidates.set(moveToUci(result.move), {
      move: result.move,
      score: objective,
      exact: true,
    });
  }
  for (const candidate of result.candidates || []) {
    if (candidate.exact === false) continue;
    const move = position.moveFromUci(candidate.uci);
    if (!move) continue;
    const candidateValue = Number(candidate.score);
    candidates.set(candidate.uci, {
      move,
      score: Number.isFinite(candidateValue) ? candidateValue : objective,
      exact: true,
    });
  }

  const pool = [...candidates.values()];
  if (!pool.length) return null;
  const bestScore = Math.max(...pool.map(candidate => candidate.score));
  let bestTrap = null;

  for (const candidate of pool) {
    const stats = stalemateReplyStats(position, candidate.move);
    if (stats.forced) {
      return {
        ...candidate,
        ...stats,
        score: 0,
        kind: 'forced-stalemate',
      };
    }

    if (objective > DESPERATE_STALEMATE_THRESHOLD) continue;
    if (!stats.stalematingReplies) continue;
    if (candidate.score < bestScore - STALEMATE_TRAP_WINDOW) continue;

    const ratio = stats.stalematingReplies / Math.max(1, stats.replyCount);
    const trap = {
      ...candidate,
      ...stats,
      kind: 'stalemate-trap',
      forced: false,
      ratio,
    };
    if (!bestTrap
      || trap.ratio > bestTrap.ratio
      || (trap.ratio === bestTrap.ratio && trap.score > bestTrap.score)) {
      bestTrap = trap;
    }
  }

  return bestTrap;
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
    const base = super.search(position, options);
    const result = { ...base, rootCriticality: this.rootCriticality };
    if (!result.move) return result;

    const stalemate = selectDesperateStalemate(position, result);
    if (!stalemate) return result;

    const selectedUci = moveToUci(result.move);
    const rescueUci = moveToUci(stalemate.move);
    const rescued = selectedUci !== rescueUci;
    const objective = stalemate.forced ? 0 : stalemate.score;

    return {
      ...result,
      move: stalemate.move,
      score: objective,
      objectiveScore: objective,
      pv: [stalemate.move],
      selectedRisk: stalemate.forced ? 0 : Math.max(240, Number(result.selectedRisk) || 0),
      drawStrategy: {
        kind: stalemate.kind,
        forced: stalemate.forced,
        rescued,
        uci: rescueUci,
        stalematingReplies: stalemate.stalematingReplies,
        replyCount: stalemate.replyCount,
      },
    };
  }

  /**
   * Repetition inside the search tree follows the same policy as root play:
   * unless the side to move is seriously losing, a loop is actively bad. This
   * removes the old neutral zone where Vanta could drift into threefold around
   * equality even though playable winning chances remained.
   */
  repetitionUtility(position) {
    const staticScore = this.staticEval(position);
    const aversion = 180 + Math.round((VANTA_PERSONALITY.drawAversion / 100) * 520);
    if (isSeriouslyLosing(position, staticScore)) return Math.round(aversion * 0.55);
    return -aversion;
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

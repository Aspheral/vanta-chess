import { FLAGS } from '../chess/position.js';

const DEFAULT_MAX_CHECKS = 5;
const DEFAULT_CHECK_NODE_LIMIT = 5000;
const DEFAULT_MAX_PLIES = 9;
const DEFAULT_FULL_NODE_LIMIT = 16000;
const PROVEN = 1;
const REFUTED = 0;
const UNKNOWN = -1;

function movePriority(position, move) {
  const next = position.makeMove(move);
  let priority = 0;
  if (next.isInCheck()) priority += 100000;
  if (move.flags & FLAGS.CAPTURE) priority += 1000;
  if (move.promotion) priority += 500;
  return { next, priority };
}

/**
 * Stage one: the original narrow proof. It is exceptionally efficient on
 * forcing checking trees, so keep it instead of making the broad proof rediscover
 * those lines through a much larger move tree.
 */
function checkingMateWithin(position, attacker, checksLeft, budget) {
  if (budget.nodes >= budget.limit) {
    budget.exhausted = true;
    return false;
  }
  budget.nodes++;

  const legal = position.legalMoves();
  if (!legal.length) {
    return position.isInCheck() && position.turn !== attacker;
  }

  if (position.turn === attacker) {
    if (checksLeft <= 0) return false;

    const checks = [];
    for (const move of legal) {
      const next = position.makeMove(move);
      if (next.isInCheck()) checks.push(next);
    }
    for (const next of checks) {
      if (budget.nodes >= budget.limit) {
        budget.exhausted = true;
        return false;
      }
      if (checkingMateWithin(next, attacker, checksLeft - 1, budget)) return true;
    }
    return false;
  }

  if (!position.isInCheck()) return false;
  for (const reply of legal) {
    if (budget.nodes >= budget.limit) {
      budget.exhausted = true;
      return false;
    }
    if (!checkingMateWithin(position.makeMove(reply), attacker, checksLeft, budget)) {
      return false;
    }
  }
  return true;
}

/**
 * Stage two: exact bounded mate proof that permits quiet attacking moves.
 *
 * The attacker needs one continuation that forces mate. Every legal defensive
 * reply must remain in the mating tree. Budget exhaustion propagates UNKNOWN,
 * which deliberately fails open so a sound sacrifice is never rejected merely
 * because the safety probe ran out of work.
 */
function fullMateWithin(position, attacker, pliesLeft, budget, memo) {
  if (budget.nodes >= budget.limit) {
    budget.exhausted = true;
    return UNKNOWN;
  }
  budget.nodes++;

  const legal = position.legalMoves();
  if (!legal.length) {
    return position.isInCheck() && position.turn !== attacker ? PROVEN : REFUTED;
  }
  if (pliesLeft <= 0) return REFUTED;

  const key = `${position.hash}:${pliesLeft}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  const children = legal
    .map(move => movePriority(position, move))
    .sort((a, b) => b.priority - a.priority);

  if (position.turn === attacker) {
    let sawUnknown = false;
    for (const { next } of children) {
      const result = fullMateWithin(next, attacker, pliesLeft - 1, budget, memo);
      if (result === PROVEN) {
        memo.set(key, PROVEN);
        return PROVEN;
      }
      if (result === UNKNOWN) sawUnknown = true;
    }
    if (sawUnknown) return UNKNOWN;
    memo.set(key, REFUTED);
    return REFUTED;
  }

  let sawUnknown = false;
  for (const { next } of children) {
    const result = fullMateWithin(next, attacker, pliesLeft - 1, budget, memo);
    if (result === REFUTED) {
      memo.set(key, REFUTED);
      return REFUTED;
    }
    if (result === UNKNOWN) sawUnknown = true;
  }
  if (sawUnknown) return UNKNOWN;
  memo.set(key, PROVEN);
  return PROVEN;
}

export function forcedMateProbe(position, move, options = {}) {
  if (!move) {
    return { forced: false, nodes: 0, exhausted: false, matePlies: null, stage: null };
  }

  const after = position.makeMove(move);
  const replies = after.legalMoves();
  if (!replies.length) {
    return { forced: false, nodes: 1, exhausted: false, matePlies: null, stage: null };
  }

  const attacker = after.turn;
  const maxChecks = Math.max(1, Number(options.maxChecks) || DEFAULT_MAX_CHECKS);
  const checkNodeLimit = Math.max(
    64,
    Number(options.checkNodeLimit) || DEFAULT_CHECK_NODE_LIMIT,
  );
  const checkBudget = { nodes: 0, limit: checkNodeLimit, exhausted: false };

  if (checkingMateWithin(after, attacker, maxChecks, checkBudget)) {
    return {
      forced: true,
      nodes: checkBudget.nodes,
      exhausted: checkBudget.exhausted,
      matePlies: null,
      stage: 'checks',
    };
  }

  const maxPlies = Math.max(1, Number(options.maxPlies) || DEFAULT_MAX_PLIES);
  const fullNodeLimit = Math.max(
    128,
    Number(options.nodeLimit) || DEFAULT_FULL_NODE_LIMIT,
  );
  const fullBudget = { nodes: 0, limit: fullNodeLimit, exhausted: false };
  const full = fullMateWithin(after, attacker, maxPlies, fullBudget, new Map());

  return {
    forced: full === PROVEN,
    nodes: checkBudget.nodes + fullBudget.nodes,
    exhausted: fullBudget.exhausted,
    matePlies: full === PROVEN ? maxPlies : null,
    stage: full === PROVEN ? 'full' : null,
  };
}

export function allowsForcedMate(position, move, options = {}) {
  return forcedMateProbe(position, move, options).forced;
}

// Keep the historical API name while upgrading its implementation to the
// two-stage proof. Existing callers and the fixed 276-test corpus stay stable.
export function forcedCheckingMateProbe(position, move, options = {}) {
  return forcedMateProbe(position, move, options);
}

export function allowsForcedCheckingMate(position, move, options = {}) {
  return forcedCheckingMateProbe(position, move, options).forced;
}

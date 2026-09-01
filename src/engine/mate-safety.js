import { FLAGS } from '../chess/position.js';

const DEFAULT_MAX_PLIES = 9;
const DEFAULT_NODE_LIMIT = 16000;
const PROVEN = 1;
const REFUTED = 0;
const UNKNOWN = -1;

function movePriority(position, move) {
  const next = position.makeMove(move);
  let priority = 0;
  if (next.isInCheck()) priority += 100000;
  if (move.flags & FLAGS.CAPTURE) priority += 1000;
  if (move.promotion) priority += 500;
  return { move, next, priority };
}

function orderedChildren(position) {
  return position.legalMoves()
    .map(move => movePriority(position, move))
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Exact bounded mate proof with a fail-open work cap.
 *
 * The attacking side only needs one continuation that forces mate. The
 * defending side must have every legal reply covered by the mating tree. Quiet
 * attacking moves are deliberately allowed, which fixes the blind spot in the
 * older checking-only prover. If the local node budget is exhausted, UNKNOWN
 * propagates upward and the caller must treat the move as safe/not proven.
 */
function mateWithin(position, attacker, pliesLeft, budget, memo) {
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

  const attackerTurn = position.turn === attacker;
  const children = legal
    .map(move => movePriority(position, move))
    .sort((a, b) => b.priority - a.priority);

  if (attackerTurn) {
    let sawUnknown = false;
    for (const { next } of children) {
      const result = mateWithin(next, attacker, pliesLeft - 1, budget, memo);
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
    const result = mateWithin(next, attacker, pliesLeft - 1, budget, memo);
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
  if (!move) return { forced: false, nodes: 0, exhausted: false, matePlies: null };

  const maxPlies = Math.max(1, Number(options.maxPlies) || DEFAULT_MAX_PLIES);
  const nodeLimit = Math.max(128, Number(options.nodeLimit) || DEFAULT_NODE_LIMIT);
  const after = position.makeMove(move);

  // If Vanta itself just ended the game, there is no opponent mating tree.
  const replies = after.legalMoves();
  if (!replies.length) {
    return { forced: false, nodes: 1, exhausted: false, matePlies: null };
  }

  const attacker = after.turn;
  const budget = { nodes: 0, limit: nodeLimit, exhausted: false };
  const memo = new Map();
  const lastDepth = maxPlies % 2 === 1 ? maxPlies : maxPlies - 1;

  // Iterative mate depth keeps short tactical mates cheap while still allowing
  // the prover to reach quiet mate-in-4/5 constructions when work remains.
  for (let plies = 1; plies <= lastDepth; plies += 2) {
    const result = mateWithin(after, attacker, plies, budget, memo);
    if (result === PROVEN) {
      return {
        forced: true,
        nodes: budget.nodes,
        exhausted: budget.exhausted,
        matePlies: plies,
      };
    }
    if (budget.exhausted) break;
  }

  return {
    forced: false,
    nodes: budget.nodes,
    exhausted: budget.exhausted,
    matePlies: null,
  };
}

export function allowsForcedMate(position, move, options = {}) {
  return forcedMateProbe(position, move, options).forced;
}

// Backward-compatible names for the existing regression corpus and any callers
// outside the worker. They now use the stronger full-tree proof.
export function forcedCheckingMateProbe(position, move, options = {}) {
  const translated = {
    ...options,
    maxPlies: options.maxPlies ?? (options.maxChecks ? (Number(options.maxChecks) * 2 - 1) : undefined),
  };
  return forcedMateProbe(position, move, translated);
}

export function allowsForcedCheckingMate(position, move, options = {}) {
  return forcedCheckingMateProbe(position, move, options).forced;
}

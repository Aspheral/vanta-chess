import { FLAGS } from '../chess/position.js';

const DEFAULT_MAX_CHECKS = 5;
const DEFAULT_CHECK_NODE_LIMIT = 5000;
const DEFAULT_MAX_PLIES = 9;
const DEFAULT_QUIET_NODE_LIMIT = 24000;
const PROVEN = 1;
const REFUTED = 0;
const UNKNOWN = -1;

function orderedMoves(position, legal) {
  return legal
    .map(move => {
      const next = position.makeMove(move);
      let priority = 0;
      if (next.isInCheck()) priority += 100000;
      if (move.flags & FLAGS.CAPTURE) priority += 1000;
      if (move.promotion) priority += 500;
      return { move, next, givesCheck: next.isInCheck(), priority };
    })
    .sort((a, b) => b.priority - a.priority);
}

/**
 * Stage one: prove mates made entirely of checking attacker moves. This tiny
 * tree catches ordinary forcing combinations extremely cheaply.
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
    for (const { next, givesCheck } of orderedMoves(position, legal)) {
      if (!givesCheck) continue;
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
 * Stage two: exact bounded mate proof with at most one quiet attacker setup.
 *
 * This covers the important horizon pattern the checking-only prover misses,
 * while avoiding the explosive tree of allowing arbitrary quiet attacker moves
 * at every ply. The defender is still exhaustive: every legal reply has to
 * remain inside the mating tree. UNKNOWN propagates on budget exhaustion, so
 * this seatbelt always fails open rather than vetoing an unproven sacrifice.
 */
function oneQuietMateWithin(position, attacker, pliesLeft, quietsLeft, budget, memo) {
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

  const key = `${position.hash}:${pliesLeft}:${quietsLeft}`;
  const cached = memo.get(key);
  if (cached !== undefined) return cached;

  if (position.turn === attacker) {
    let sawUnknown = false;
    for (const { next, givesCheck } of orderedMoves(position, legal)) {
      if (!givesCheck && quietsLeft <= 0) continue;
      const result = oneQuietMateWithin(
        next,
        attacker,
        pliesLeft - 1,
        givesCheck ? quietsLeft : quietsLeft - 1,
        budget,
        memo,
      );
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
  for (const { next } of orderedMoves(position, legal)) {
    const result = oneQuietMateWithin(next, attacker, pliesLeft - 1, quietsLeft, budget, memo);
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
  const checkNodeLimit = Math.max(64, Number(options.checkNodeLimit) || DEFAULT_CHECK_NODE_LIMIT);
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
  const quietNodeLimit = Math.max(128, Number(options.nodeLimit) || DEFAULT_QUIET_NODE_LIMIT);
  const quietBudget = { nodes: 0, limit: quietNodeLimit, exhausted: false };
  const quietResult = oneQuietMateWithin(after, attacker, maxPlies, 1, quietBudget, new Map());

  return {
    forced: quietResult === PROVEN,
    nodes: checkBudget.nodes + quietBudget.nodes,
    exhausted: quietBudget.exhausted,
    matePlies: quietResult === PROVEN ? maxPlies : null,
    stage: quietResult === PROVEN ? 'one-quiet' : null,
  };
}

export function allowsForcedMate(position, move, options = {}) {
  return forcedMateProbe(position, move, options).forced;
}

// Historical API retained for existing callers and the fixed 276-test corpus.
export function forcedCheckingMateProbe(position, move, options = {}) {
  return forcedMateProbe(position, move, options);
}

export function allowsForcedCheckingMate(position, move, options = {}) {
  return forcedCheckingMateProbe(position, move, options).forced;
}

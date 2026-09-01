const DEFAULT_MAX_CHECKS = 5;
const DEFAULT_NODE_LIMIT = 5000;

/**
 * Prove a mate using checking moves only.
 *
 * This is intentionally a proof, not an evaluation heuristic. On the attacking
 * side's turns we consider only legal moves that give check. On the defender's
 * turns every legal evasion has to remain inside the mating tree. If the local
 * node budget is exhausted the answer is "not proven", so the seatbelt cannot
 * reject a sound sacrifice merely because the probe ran out of work.
 */
function attackerForcesCheckingMate(position, attacker, checksLeft, budget) {
  if (budget.nodes >= budget.limit) return false;
  budget.nodes++;

  const legal = position.legalMoves();
  if (!legal.length) {
    return position.isInCheck() && position.turn !== attacker;
  }

  if (position.turn === attacker) {
    if (checksLeft <= 0) return false;

    for (const move of legal) {
      if (budget.nodes >= budget.limit) return false;
      const next = position.makeMove(move);
      if (!next.isInCheck()) continue;
      if (attackerForcesCheckingMate(next, attacker, checksLeft - 1, budget)) return true;
    }
    return false;
  }

  // A checking-only proof can reach a defender turn only while that defender
  // is in check. If the attack ever needs a quiet setup move, this conservative
  // probe declines to call it forced mate.
  if (!position.isInCheck()) return false;

  for (const reply of legal) {
    if (budget.nodes >= budget.limit) return false;
    if (!attackerForcesCheckingMate(position.makeMove(reply), attacker, checksLeft, budget)) {
      return false;
    }
  }
  return true;
}

export function forcedCheckingMateProbe(position, move, options = {}) {
  if (!move) return { forced: false, nodes: 0 };

  const maxChecks = Math.max(1, Number(options.maxChecks) || DEFAULT_MAX_CHECKS);
  const nodeLimit = Math.max(64, Number(options.nodeLimit) || DEFAULT_NODE_LIMIT);
  const after = position.makeMove(move);

  // If Vanta just delivered mate, there is obviously no opponent mating tree.
  const replies = after.legalMoves();
  if (!replies.length) return { forced: false, nodes: 1 };

  const budget = { nodes: 0, limit: nodeLimit };
  const forced = attackerForcesCheckingMate(after, after.turn, maxChecks, budget);
  return { forced, nodes: budget.nodes };
}

export function allowsForcedCheckingMate(position, move, options = {}) {
  return forcedCheckingMateProbe(position, move, options).forced;
}

import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

export const HANGING_GATE_THRESHOLD = 240;
export const HANGING_GATE_PROOF_MARGIN = 170;

/**
 * Measure the clean material the opponent can win immediately after a root
 * candidate. Unlike the softer root tactical-risk score, this value is used as
 * a selection gate: if a competitive safe move exists, Vanta does not get to
 * hang a minor/rook/queen merely because its personality likes the position.
 */
export function strictHangingPieceRisk(position, move, seeMemo = new Map()) {
  if (!move) return 100000;
  const us = position.turn;
  const after = position.makeMove(move);
  let worst = 0;

  for (const capture of after.legalMoves({ capturesOnly: true })) {
    if (!(capture.flags & FLAGS.CAPTURE)) continue;
    const victim = after.board[capture.to];
    if (!victim || colorOf(victim) !== us) continue;
    const victimType = typeOf(victim);
    if (!['n', 'b', 'r', 'q'].includes(victimType)) continue;

    const gain = staticExchangeEval(after, capture, seeMemo);
    if (gain < HANGING_GATE_THRESHOLD) continue;
    const victimValue = PIECE_VALUES[victimType] || 0;
    const severity = Math.max(gain, Math.round(victimValue * 0.78));
    worst = Math.max(worst, Math.min(1400, severity));
  }

  return Math.max(0, Math.round(worst));
}

/**
 * A sacrifice is allowed through only when objective search proves it is
 * materially better than the best safe alternative by a substantial margin.
 * This keeps brilliant sacrifices legal while blocking vague "pressure" sacs.
 */
export function applyStrictHangingGate(lines, threshold = HANGING_GATE_THRESHOLD, proofMargin = HANGING_GATE_PROOF_MARGIN) {
  if (!lines?.length) return [];
  const safe = lines.filter(line => (line.hangingRisk || 0) < threshold);
  if (!safe.length) return lines;
  const bestSafe = Math.max(...safe.map(line => line.score));
  const gated = lines.filter(line => {
    if ((line.hangingRisk || 0) < threshold) return true;
    return line.score >= bestSafe + proofMargin;
  });
  return gated.length ? gated : safe;
}

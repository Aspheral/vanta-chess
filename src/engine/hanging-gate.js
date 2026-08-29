import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

export const HANGING_GATE_THRESHOLD = 240;
export const HANGING_GATE_PROOF_MARGIN = 170;

/**
 * Measure the clean material the opponent can win immediately after a root
 * candidate. Severity reflects the valuable piece Vanta actually gives up,
 * not only the net SEE after Vanta later recaptures the cheap attacker. Thus a
 * pawn taking a knight is still a strict-gate event even if the pawn itself can
 * be recovered on the following move.
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
    // A true exchange or clean piece loss is already a serious root event at
    // roughly 1.5 pawns. Equal swaps and tactically recoverable captures remain
    // below this floor and stay entirely search-authoritative.
    if (gain < 150) continue;

    const victimValue = PIECE_VALUES[victimType] || 0;
    const attackerValue = PIECE_VALUES[typeOf(capture.piece)] || 0;
    const nominalLoss = Math.max(0, victimValue - Math.min(victimValue, attackerValue));
    if (gain < 180 && nominalLoss < 180) continue;

    const severity = Math.max(gain, nominalLoss, Math.round(victimValue * 0.82));
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

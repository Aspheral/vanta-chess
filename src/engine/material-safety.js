import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

// A minor exchanged for a pawn is already a serious one-move material loss.
// Legal SEE reports that as roughly 200-230 cp, so the gate must trigger below
// the old 240 cp cutoff or it misses exactly the real Chess.com blunders it is
// meant to prevent.
const CLEAN_LOSS_THRESHOLD = 180;
const SAFE_EXPOSURE = 120;

function captureExposure(after, capture, seeMemo) {
  if (!(capture.flags & FLAGS.CAPTURE)) return null;
  const victimType = typeOf(capture.captured);
  if (!['n', 'b', 'r', 'q'].includes(victimType)) return null;
  const see = staticExchangeEval(after, capture, seeMemo);
  if (see < CLEAN_LOSS_THRESHOLD) return null;
  return {
    loss: Math.max(0, Math.round(see)),
    victimType,
    victimValue: PIECE_VALUES[victimType] || 0,
    reply: capture,
  };
}

/**
 * Measure the worst immediate clean loss after a candidate move. Legal SEE is
 * used so pins, x-rays, king legality and recaptures are respected. This is a
 * tactical safety gate, not a blanket ban on sacrifices.
 */
export function hangingPieceExposure(position, move, seeMemo = new Map()) {
  if (!move) return { loss: Infinity, victimType: null, victimValue: 0, reply: null };
  const after = position.makeMove(move);
  let worst = { loss: 0, victimType: null, victimValue: 0, reply: null };
  for (const capture of after.legalMoves({ capturesOnly: true })) {
    const exposure = captureExposure(after, capture, seeMemo);
    if (exposure && exposure.loss > worst.loss) worst = exposure;
  }
  return worst;
}

function compensationRequired(exposure) {
  if (!exposure?.victimType) return 0;
  if (exposure.victimType === 'q') return 500;
  if (exposure.victimType === 'r') return 340;
  return 240;
}

/**
 * Strict Hanging-Piece Gate.
 *
 * Once any materially sane legal candidate exists, a move that simply drops a
 * minor/rook/queen is removed from the personality pool. The risky line can
 * still survive when objective search proves a genuinely large advantage over
 * the best safe line, or when it is mating. This is intentionally stricter
 * than the personality risk penalty: style never gets to spend a whole piece
 * for vague pressure.
 */
export function strictHangingPieceGate(position, lines, seeMemo = new Map()) {
  if (!lines?.length) return { lines: [], blocked: [] };
  const profiled = lines.map(line => ({
    line,
    exposure: hangingPieceExposure(position, line.move, seeMemo),
  }));
  const safe = profiled.filter(item => item.exposure.loss <= SAFE_EXPOSURE);
  if (!safe.length) return { lines, blocked: [] };

  const bestSafeScore = Math.max(...safe.map(item => item.line.score));
  const kept = [];
  const blocked = [];

  for (const item of profiled) {
    const { line, exposure } = item;
    const mating = Math.abs(line.score) >= 99000;
    const provenCompensation = line.score >= bestSafeScore + compensationRequired(exposure);
    if (exposure.loss >= CLEAN_LOSS_THRESHOLD && !mating && !provenCompensation) blocked.push(item);
    else kept.push(line);
  }

  return { lines: kept.length ? kept : lines, blocked };
}

/**
 * Emergency fallback for the rare case where iterative deepening cannot finish
 * depth one. Prefer a move that does not leave a cleanly capturable piece.
 */
export function chooseSafestFallback(position, moves, seeMemo = new Map()) {
  if (!moves?.length) return null;
  let best = moves[0];
  let bestLoss = Infinity;
  for (const move of moves) {
    const loss = hangingPieceExposure(position, move, seeMemo).loss;
    if (loss < bestLoss) {
      best = move;
      bestLoss = loss;
      if (loss === 0) break;
    }
  }
  return best;
}

import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

const CLEAN_LOSS_THRESHOLD = 240;
const SAFE_EXPOSURE = 170;
const COMPETITIVE_WINDOW = 150;

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
  if (exposure.victimType === 'q') return 360;
  if (exposure.victimType === 'r') return 250;
  return 175;
}

/**
 * Strict Hanging-Piece Gate.
 *
 * If a competitive safe move exists, a line that simply drops a minor/rook/
 * queen is removed from the personality pool. A sacrifice can still pass when
 * objective search proves enough compensation by a large margin, or when the
 * line is mating. This keeps Vanta aggressive without letting style overrule a
 * clean one-move material loss.
 */
export function strictHangingPieceGate(position, lines, seeMemo = new Map()) {
  if (!lines?.length) return { lines: [], blocked: [] };
  const profiled = lines.map(line => ({
    line,
    exposure: hangingPieceExposure(position, line.move, seeMemo),
  }));
  const bestScore = Math.max(...profiled.map(item => item.line.score));
  const safe = profiled.filter(item =>
    item.exposure.loss <= SAFE_EXPOSURE
    && item.line.score >= bestScore - COMPETITIVE_WINDOW
  );
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

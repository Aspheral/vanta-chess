import { FLAGS } from '../chess/position.js';
import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite,
  KNIGHT_DELTAS,
} from '../chess/constants.js';

function pieceValue(piece) { return PIECE_VALUES[typeOf(piece)] || 0; }

function attacksTarget(board, from, target) {
  const piece = board[from];
  if (!piece) return false;
  const color = colorOf(piece), type = typeOf(piece);
  const [fr, fc] = rowCol(from), [tr, tc] = rowCol(target);
  const dr = tr - fr, dc = tc - fc;

  if (type === 'p') return dr === (color === WHITE ? -1 : 1) && Math.abs(dc) === 1;
  if (type === 'n') return KNIGHT_DELTAS.some(([r, c]) => r === dr && c === dc);
  if (type === 'k') return Math.max(Math.abs(dr), Math.abs(dc)) === 1;

  let stepR = 0, stepC = 0;
  if (dr === 0 && dc !== 0) stepC = Math.sign(dc);
  else if (dc === 0 && dr !== 0) stepR = Math.sign(dr);
  else if (Math.abs(dr) === Math.abs(dc)) { stepR = Math.sign(dr); stepC = Math.sign(dc); }
  else return false;

  if (type === 'b' && !(stepR && stepC)) return false;
  if (type === 'r' && stepR && stepC) return false;
  if (!['b', 'r', 'q'].includes(type)) return false;

  let rr = fr + stepR, cc = fc + stepC;
  while (rr !== tr || cc !== tc) {
    if (board[rr * 8 + cc]) return false;
    rr += stepR; cc += stepC;
  }
  return true;
}

function leastValuableAttacker(board, color, target) {
  let best = null;
  for (let from = 0; from < 64; from++) {
    const piece = board[from];
    if (!piece || colorOf(piece) !== color || !attacksTarget(board, from, target)) continue;
    const value = pieceValue(piece);
    if (!best || value < best.value) best = { from, piece, value };
  }
  return best;
}

function promotionValueOnTarget(piece, target) {
  if (typeOf(piece) !== 'p') return pieceValue(piece);
  const [row] = rowCol(target);
  if ((colorOf(piece) === WHITE && row === 0) || (colorOf(piece) === BLACK && row === 7)) return PIECE_VALUES.q;
  return PIECE_VALUES.p;
}

// Fast swap-off SEE for ordering/pruning. It deliberately ignores pins, so search
// remains authoritative and negative SEE is never treated as a hard legality rule.
export function staticExchangeEval(position, move) {
  const captured = move.captured ? pieceValue(move.captured) : 0;
  const promotionGain = move.promotion ? (PIECE_VALUES[move.promotion] || 0) - PIECE_VALUES.p : 0;
  if (!(move.flags & FLAGS.CAPTURE) && !move.promotion) return 0;

  const next = position.makeMove(move);
  const board = [...next.board];
  const target = move.to;
  const gain = [captured + promotionGain];
  let targetValue = promotionValueOnTarget(board[target], target);
  let side = next.turn;
  let depth = 0;

  while (depth < 16) {
    const attacker = leastValuableAttacker(board, side, target);
    if (!attacker) break;
    depth++;
    gain[depth] = targetValue - gain[depth - 1];

    board[attacker.from] = null;
    board[target] = attacker.piece;
    targetValue = promotionValueOnTarget(attacker.piece, target);
    side = opposite(side);
  }

  while (depth > 0) {
    gain[depth - 1] = -Math.max(-gain[depth - 1], gain[depth]);
    depth--;
  }
  return gain[0];
}

export function moveGivesCheck(position, move) {
  return position.makeMove(move).isInCheck();
}

export function hasNearPromotion(position, color = null) {
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (color && pc !== color) continue;
    const [row] = rowCol(sq);
    if ((pc === WHITE && row <= 1) || (pc === BLACK && row >= 6)) return true;
  }
  return false;
}

export function promotionPressure(position, color = null) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (color && pc !== color) continue;
    const [row] = rowCol(sq);
    const distance = pc === WHITE ? row : 7 - row;
    if (distance <= 1) score += 28;
    else if (distance === 2) score += 18;
    else if (distance === 3) score += 10;
  }
  return score;
}

export function looseHighValueCount(position, color) {
  let count = 0;
  const enemy = opposite(color);
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) === 'k') continue;
    const value = pieceValue(piece);
    if (value < PIECE_VALUES.n) continue;
    if (!position.isSquareAttacked(sq, enemy)) continue;
    const defended = position.isSquareAttacked(sq, color);
    if (!defended || value >= PIECE_VALUES.r) count++;
  }
  return count;
}

export function tacticalVolatility(position) {
  const legal = position.legalMoves();
  let score = position.isInCheck() ? 38 : 0;
  let checks = 0, promotions = 0, forcingCaptures = 0;

  for (const move of legal) {
    if (move.promotion) { promotions++; score += 10; }
    if (move.flags & FLAGS.CAPTURE) {
      const victim = pieceValue(move.captured);
      const see = staticExchangeEval(position, move);
      if (victim >= PIECE_VALUES.n || see >= 80) { forcingCaptures++; score += victim >= PIECE_VALUES.r ? 7 : 4; }
    }
    if (checks < 6 && moveGivesCheck(position, move)) { checks++; score += 5; }
    if (score >= 100) return 100;
  }

  score += Math.min(32, promotionPressure(position));
  score += Math.min(18, (looseHighValueCount(position, WHITE) + looseHighValueCount(position, BLACK)) * 6);
  if (checks >= 3) score += 8;
  if (promotions) score += Math.min(16, promotions * 4);
  if (forcingCaptures >= 3) score += 8;
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function isTacticallyQuietMove(position, move, next = null) {
  if (move.flags & FLAGS.CAPTURE) return false;
  if (move.promotion) return false;
  const child = next || position.makeMove(move);
  if (child.isInCheck()) return false;
  if (promotionPressure(position) >= 18 || promotionPressure(child) >= 18) return false;
  return true;
}

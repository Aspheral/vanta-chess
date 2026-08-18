import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf, rowCol, opposite, WHITE } from '../chess/constants.js';

const MAX_SEE_PLIES = 10;

export function staticExchangeEval(position, move, cache = null) {
  const key = cache ? `${position.hash}:${moveToUci(move)}` : null;
  if (key && cache.has(key)) return cache.get(key);

  const captured = move.captured ? (PIECE_VALUES[typeOf(move.captured)] || 0) : 0;
  const promotionGain = move.promotion ? (PIECE_VALUES[move.promotion] - PIECE_VALUES.p) : 0;
  if (!(move.flags & FLAGS.CAPTURE) && !move.promotion) {
    if (key) cache.set(key, 0);
    return 0;
  }

  const next = position.makeMove(move);
  const replyGain = bestExchangeGain(next, move.to, 0, new Map());
  const score = captured + promotionGain - replyGain;
  if (key) cache.set(key, score);
  return score;
}

function bestExchangeGain(position, target, ply, memo) {
  if (ply >= MAX_SEE_PLIES) return 0;
  const memoKey = `${position.hash}:${target}:${ply}`;
  if (memo.has(memoKey)) return memo.get(memoKey);

  let best = 0; // declining an exchange is always legal.
  const captures = position.legalMoves({ capturesOnly: true }).filter(m => m.to === target);
  for (const move of captures) {
    const victim = move.captured ? (PIECE_VALUES[typeOf(move.captured)] || 0) : 0;
    const promotionGain = move.promotion ? (PIECE_VALUES[move.promotion] - PIECE_VALUES.p) : 0;
    const gain = victim + promotionGain - bestExchangeGain(position.makeMove(move), target, ply + 1, memo);
    if (gain > best) best = gain;
  }
  memo.set(memoKey, best);
  return best;
}

export function mateInOneMove(position) {
  const legal = position.legalMoves();
  for (const move of legal) {
    const next = position.makeMove(move);
    if (!next.isInCheck(next.turn)) continue;
    if (next.legalMoves().length === 0) return move;
  }
  return null;
}

export function allowsMateInOne(position, move) {
  return Boolean(mateInOneMove(position.makeMove(move)));
}

export function givesCheck(position, move) {
  const next = position.makeMove(move);
  return next.isInCheck(next.turn);
}

export function isKingZoneMove(position, move, radius = 3) {
  const enemyKing = position.kingSquare(opposite(position.turn));
  if (enemyKing < 0) return false;
  const [kr, kc] = rowCol(enemyKing);
  const [tr, tc] = rowCol(move.to);
  if (Math.max(Math.abs(kr - tr), Math.abs(kc - tc)) <= radius) return true;

  // Sliding moves that uncover a line into the king zone are tactically relevant
  // even when the moving piece itself finishes farther away.
  const next = position.makeMove(move);
  const zone = [];
  for (let r = Math.max(0, kr - 1); r <= Math.min(7, kr + 1); r++) {
    for (let c = Math.max(0, kc - 1); c <= Math.min(7, kc + 1); c++) zone.push(r * 8 + c);
  }
  return zone.some(square => next.isSquareAttacked(square, position.turn));
}

export function isAdvancedPawnPush(position, move) {
  if (typeOf(move.piece) !== 'p') return false;
  const [row] = rowCol(move.to);
  const color = colorOf(move.piece);
  return color === WHITE ? row <= 1 : row >= 6;
}

export function tacticalMoveInfo(position, move, seeCache = null) {
  const next = position.makeMove(move);
  const check = next.isInCheck(next.turn);
  const see = staticExchangeEval(position, move, seeCache);
  return {
    see,
    check,
    promotion: Boolean(move.promotion),
    kingZone: isKingZoneMove(position, move),
    advancedPawn: isAdvancedPawnPush(position, move),
  };
}

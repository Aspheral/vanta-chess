import { PIECE_VALUES, colorOf, typeOf, opposite, rowCol } from '../chess/constants.js';
import { FLAGS, moveToUci } from '../chess/position.js';

const MATE_RISK = 100000;

function valueOf(pieceOrType) {
  if (!pieceOrType) return 0;
  const type = pieceOrType.length === 1 ? typeOf(pieceOrType) : pieceOrType;
  return PIECE_VALUES[type] || 0;
}

function promotionGain(move) {
  return move?.promotion ? Math.max(0, valueOf(move.promotion) - PIECE_VALUES.p) : 0;
}

function exchangeContinuation(position, target, memo, depth = 0) {
  if (depth > 14) return 0;
  const key = `${position.hash.toString()}:${target}:${depth}`;
  if (memo.has(key)) return memo.get(key);
  let best = 0;
  const captures = position.legalMoves({ capturesOnly: true }).filter(move => move.to === target && (move.flags & FLAGS.CAPTURE));
  for (const move of captures) {
    const immediate = valueOf(move.captured) + promotionGain(move);
    const reply = exchangeContinuation(position.makeMove(move), target, memo, depth + 1);
    best = Math.max(best, immediate - reply);
  }
  memo.set(key, best);
  return best;
}

/**
 * Legal static exchange evaluation. It intentionally uses legal recaptures,
 * so pins, king legality, x-rays and promotion recaptures are respected.
 * Search remains authoritative: a negative SEE move may still be brilliant.
 */
export function staticExchangeEval(position, move, memo = new Map()) {
  if (!move) return 0;
  const immediate = valueOf(move.captured) + promotionGain(move);
  if (!(move.flags & FLAGS.CAPTURE) && !move.promotion) return 0;
  const next = position.makeMove(move);
  return immediate - exchangeContinuation(next, move.to, memo, 0);
}

export function hasNearPromotion(position, color = null) {
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (color && pc !== color) continue;
    const [row] = rowCol(sq);
    if ((pc === 'w' && row <= 1) || (pc === 'b' && row >= 6)) return true;
  }
  return false;
}

export function hasLooseMajor(position, color = position.turn) {
  const enemy = opposite(color);
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || !['q', 'r'].includes(typeOf(piece))) continue;
    if (position.isSquareAttacked(sq, enemy)) return true;
  }
  return false;
}

function immediateMateAvailable(position) {
  for (const move of position.legalMoves()) {
    const next = position.makeMove(move);
    if (next.isInCheck() && next.legalMoves().length === 0) return true;
  }
  return false;
}

function bestImmediateGain(position, seeMemo = new Map()) {
  let best = 0;
  for (const move of position.legalMoves({ capturesOnly: true })) {
    if (move.promotion) best = Math.max(best, 650 + promotionGain(move));
    if (move.flags & FLAGS.CAPTURE) best = Math.max(best, staticExchangeEval(position, move, seeMemo));
  }
  return best;
}

/**
 * A compact tactical seatbelt used only at the root. It asks whether the
 * opponent has mate, promotion, a clean material win, or a checking sequence
 * that forces a second-ply material win. This is not a replacement for search.
 */
export function rootTacticalRisk(position, move, seeMemo = new Map()) {
  if (!move) return MATE_RISK;
  const after = position.makeMove(move);
  let risk = 0;
  const replies = after.legalMoves();
  for (const reply of replies) {
    const afterReply = after.makeMove(reply);
    if (afterReply.isInCheck() && afterReply.legalMoves().length === 0) return MATE_RISK;

    if (reply.promotion) risk = Math.max(risk, 650 + promotionGain(reply));
    if (reply.flags & FLAGS.CAPTURE) risk = Math.max(risk, staticExchangeEval(after, reply, seeMemo));

    // Forcing check followed by a material grab, e.g. ...Nc2+ then ...Nxa1.
    if (afterReply.isInCheck()) {
      const evasions = afterReply.legalMoves();
      if (!evasions.length) return MATE_RISK;
      let forcedGain = Infinity;
      for (const evasion of evasions) {
        const afterEvasion = afterReply.makeMove(evasion);
        if (immediateMateAvailable(afterEvasion)) {
          forcedGain = Math.min(forcedGain, MATE_RISK);
          continue;
        }
        forcedGain = Math.min(forcedGain, bestImmediateGain(afterEvasion, seeMemo));
      }
      if (Number.isFinite(forcedGain)) risk = Math.max(risk, forcedGain);
    }
  }
  return Math.max(0, Math.round(risk));
}

export function cheapVolatility(position) {
  let score = position.isInCheck() ? 34 : 0;
  if (hasNearPromotion(position)) score += 24;
  if (hasLooseMajor(position, position.turn)) score += 18;
  if (hasLooseMajor(position, opposite(position.turn))) score += 12;
  const king = position.kingSquare(position.turn);
  if (king >= 0) {
    const enemy = opposite(position.turn);
    let attackedRing = 0;
    const [kr, kc] = rowCol(king);
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const rr = kr + dr, cc = kc + dc;
      if (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 && position.isSquareAttacked(rr * 8 + cc, enemy)) attackedRing++;
    }
    score += Math.min(24, attackedRing * 4);
  }
  return Math.min(100, score);
}

export function positionCriticality(position) {
  let score = cheapVolatility(position);
  const seeMemo = new Map();
  let checks = 0, promotions = 0, winningCaptures = 0;
  for (const move of position.legalMoves()) {
    if (move.promotion) promotions++;
    if (move.flags & FLAGS.CAPTURE) {
      const see = staticExchangeEval(position, move, seeMemo);
      if (see >= 200) winningCaptures++;
    }
    const next = position.makeMove(move);
    if (next.isInCheck()) checks++;
  }
  score += Math.min(20, checks * 4);
  score += Math.min(24, promotions * 12);
  score += Math.min(18, winningCaptures * 6);
  return Math.min(100, score);
}

export function allocateRapidTime(position, remainingMs = 600000, incrementMs = 0) {
  const remaining = Math.max(1000, Number(remainingMs) || 600000);
  const reserve = Math.max(30000, remaining * 0.08);
  const usable = Math.max(250, remaining - reserve);
  const criticality = positionCriticality(position);
  const c = criticality / 100;
  const base = Math.max(220, Math.min(750, remaining / 1000 + incrementMs * 0.25));
  const softTimeMs = Math.round(Math.min(usable, base * (0.82 + 2.15 * c)));
  const hardTimeMs = Math.round(Math.min(usable, Math.max(softTimeMs + 80, base * (1.28 + 4.7 * c), softTimeMs * 1.35)));
  return {
    criticality,
    softTimeMs,
    hardTimeMs: Math.min(4500, hardTimeMs),
    reserveMs: Math.round(reserve),
  };
}

export function describeRootRisk(position, move) {
  return { uci: moveToUci(move), risk: rootTacticalRisk(position, move) };
}

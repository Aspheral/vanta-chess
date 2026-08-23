import {
  PIECE_VALUES, colorOf, typeOf, opposite, rowCol, pieceFor, inBounds,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS,
} from '../chess/constants.js';
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

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === 'w' ? 6 - row : row - 1;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === 'w' ? 0 : 56) + file;
}

function isPassedPawnAt(position, square, color) {
  const [row, file] = rowCol(square);
  const dir = color === 'w' ? -1 : 1;
  const enemyPawn = pieceFor(opposite(color), 'p');
  for (const f of [file - 1, file, file + 1]) {
    if (f < 0 || f > 7) continue;
    for (let r = row + dir; r >= 0 && r < 8; r += dir) {
      if (position.board[r * 8 + f] === enemyPawn) return false;
    }
  }
  return true;
}

function countSquareAttackers(position, square, color) {
  const [r, c] = rowCol(square);
  let count = 0;

  const pawnRow = color === 'w' ? r + 1 : r - 1;
  if (pawnRow >= 0 && pawnRow < 8) {
    const pawn = pieceFor(color, 'p');
    for (const dc of [-1, 1]) {
      const cc = c + dc;
      if (inBounds(pawnRow, cc) && position.board[pawnRow * 8 + cc] === pawn) count++;
    }
  }

  const knight = pieceFor(color, 'n');
  for (const [dr, dc] of KNIGHT_DELTAS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc) && position.board[rr * 8 + cc] === knight) count++;
  }

  const king = pieceFor(color, 'k');
  for (const [dr, dc] of KING_DELTAS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc) && position.board[rr * 8 + cc] === king) count++;
  }

  const scan = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inBounds(rr, cc)) {
        const piece = position.board[rr * 8 + cc];
        if (piece) {
          if (colorOf(piece) === color && types.includes(typeOf(piece))) count++;
          break;
        }
        rr += dr;
        cc += dc;
      }
    }
  };
  scan(BISHOP_DIRS, ['b', 'q']);
  scan(ROOK_DIRS, ['r', 'q']);
  return count;
}

function promotionStopperCount(position, square, color) {
  const occupant = position.board[square];
  const blocker = occupant && colorOf(occupant) === color ? 1 : 0;
  return blocker + countSquareAttackers(position, square, color);
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

/**
 * "Near promotion" includes a passed pawn on the sixth/seventh rank, not only
 * a pawn literally one push from queening. This keeps late pawn races out of
 * late-move reductions before the horizon becomes obvious.
 */
export function hasNearPromotion(position, color = null) {
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (color && pc !== color) continue;
    const [row] = rowCol(sq);
    if ((pc === 'w' && row <= 1) || (pc === 'b' && row >= 6)) return true;
    if (pawnProgress(sq, pc) >= 4 && isPassedPawnAt(position, sq, pc)) return true;
  }
  return false;
}

/**
 * Passed-pawn pushes to the sixth/seventh rank are tactical moves in an
 * endgame even when they are quiet. Treating them as ordinary quiet moves is
 * exactly how a shallow search can trade away a stopper and notice the queen
 * one tempo too late.
 */
export function isCriticalPassedPawnPush(position, move) {
  if (!move || typeOf(move.piece) !== 'p' || move.promotion) return false;
  const color = colorOf(move.piece);
  if (pawnProgress(move.to, color) < 4) return false;
  return isPassedPawnAt(position, move.to, color);
}

export function hasCriticalPassedPawn(position, color = null) {
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (color && pc !== color) continue;
    if (pawnProgress(sq, pc) >= 4 && isPassedPawnAt(position, sq, pc)) return true;
  }
  return false;
}

function advancedPasserVolatility(position) {
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const color = colorOf(piece);
    const progress = pawnProgress(sq, color);
    if (progress < 3 || !isPassedPawnAt(position, sq, color)) continue;
    score += progress >= 5 ? 32 : progress === 4 ? 22 : 12;
  }
  return Math.min(42, score);
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

/**
 * Value a promotion by what survives, not by the word "promotion" alone.
 * If the new queen can be legally captured at once, the promotion may be
 * harmless. If the sole bishop/rook/knight that used to capture it has been
 * traded away, the same promotion becomes catastrophic.
 */
function promotionAftermathRisk(position, move, seeMemo = new Map()) {
  const rawRisk = 650 + promotionGain(move);
  const afterPromotion = position.makeMove(move);
  const recaptures = afterPromotion.legalMoves({ capturesOnly: true })
    .filter(candidate => candidate.to === move.to && (candidate.flags & FLAGS.CAPTURE));
  if (!recaptures.length) return rawRisk;

  let bestSee = -Infinity;
  for (const recapture of recaptures) {
    bestSee = Math.max(bestSee, staticExchangeEval(afterPromotion, recapture, seeMemo));
  }
  const promotedValue = valueOf(move.promotion);
  if (recaptures.length >= 2 && bestSee >= 150) return 0;
  if (bestSee >= Math.min(450, promotedValue * 0.55)) return 35;
  if (bestSee >= 200) return 120;
  if (bestSee > 0) return 260;
  return Math.max(450, rawRisk - 150);
}

function bestImmediateGain(position, seeMemo = new Map()) {
  let best = 0;
  for (const move of position.legalMoves({ capturesOnly: true })) {
    if (move.promotion) best = Math.max(best, promotionAftermathRisk(position, move, seeMemo));
    if (move.flags & FLAGS.CAPTURE) best = Math.max(best, staticExchangeEval(position, move, seeMemo));
  }
  return best;
}

function promotionDefenseCollapseRisk(before, after, defenderColor) {
  const enemy = opposite(defenderColor);
  let risk = 0;
  let collapsed = 0;

  for (let sq = 0; sq < 64; sq++) {
    const pawn = after.board[sq];
    if (!pawn || typeOf(pawn) !== 'p' || colorOf(pawn) !== enemy) continue;
    const progress = pawnProgress(sq, enemy);
    if (progress < 4 || !isPassedPawnAt(after, sq, enemy)) continue;

    const promoSq = promotionSquare(sq, enemy);
    const beforeStoppers = promotionStopperCount(before, promoSq, defenderColor);
    const afterStoppers = promotionStopperCount(after, promoSq, defenderColor);
    if (beforeStoppers <= 0 || afterStoppers > 0) continue;

    collapsed++;
    const base = progress >= 5 ? 1050 : 520;
    risk = Math.max(risk, base + Math.min(180, (beforeStoppers - afterStoppers - 1) * 60));
  }

  if (collapsed > 1) risk += Math.min(220, (collapsed - 1) * 110);
  return risk;
}

/**
 * Opportunity-cost guard for trades. A bishop worth 335 material points can
 * be worth far more functionally if it is the only piece stopping a passed
 * pawn from queening. With a second legal/geometric stopper, that special
 * premium disappears and ordinary exchange logic can take over again.
 */
export function criticalPromotionDefenseRisk(position, move) {
  if (!move) return MATE_RISK;
  return promotionDefenseCollapseRisk(position, position.makeMove(move), position.turn);
}

function forcedPromotionRiskAfterPush(position, seeMemo = new Map()) {
  const defenses = position.legalMoves();
  if (!defenses.length) return 0;
  let bestDefenseRisk = Infinity;

  for (const defense of defenses) {
    const afterDefense = position.makeMove(defense);
    const promotions = afterDefense.legalMoves().filter(move => Boolean(move.promotion));
    if (!promotions.length) return 0;

    let worstPromotion = 0;
    for (const promotion of promotions) {
      worstPromotion = Math.max(worstPromotion, promotionAftermathRisk(afterDefense, promotion, seeMemo));
    }
    bestDefenseRisk = Math.min(bestDefenseRisk, worstPromotion);
    if (bestDefenseRisk <= 80) break;
  }

  return Number.isFinite(bestDefenseRisk) ? bestDefenseRisk : 0;
}

/**
 * A compact tactical seatbelt used only at the root. It asks whether the
 * opponent has mate, promotion, a clean material win, a critical promotion
 * defender collapse, or a forcing checking sequence. This is not a replacement
 * for search; it patches the exact shallow-horizon failures humans notice in
 * practical endgames.
 */
export function rootTacticalRisk(position, move, seeMemo = new Map()) {
  if (!move) return MATE_RISK;
  const after = position.makeMove(move);
  const us = position.turn;
  let risk = promotionDefenseCollapseRisk(position, after, us);
  const replies = after.legalMoves();

  for (const reply of replies) {
    const afterReply = after.makeMove(reply);
    if (afterReply.isInCheck() && afterReply.legalMoves().length === 0) return MATE_RISK;

    // Also catch a trade sequence where the opponent's recapture removes the
    // sole stopper even if the pawn itself does not promote on this ply.
    risk = Math.max(risk, promotionDefenseCollapseRisk(position, afterReply, us));

    if (reply.promotion) risk = Math.max(risk, promotionAftermathRisk(after, reply, seeMemo));
    if (reply.flags & FLAGS.CAPTURE) risk = Math.max(risk, staticExchangeEval(after, reply, seeMemo));

    if (isCriticalPassedPawnPush(after, reply) && pawnProgress(reply.to, colorOf(reply.piece)) >= 5) {
      risk = Math.max(risk, forcedPromotionRiskAfterPush(afterReply, seeMemo));
    }

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

/**
 * Hot-path volatility must stay genuinely cheap. Advanced passed pawns are
 * intentionally promoted to tactical status here so LMR does not shave away
 * the only tempo that prevents queening.
 */
export function cheapVolatility(position) {
  let score = position.isInCheck() ? 42 : 0;
  if (hasNearPromotion(position)) score += 52;
  return Math.min(100, score);
}

export function positionCriticality(position) {
  let score = cheapVolatility(position) + advancedPasserVolatility(position);

  // These are useful time-management signals, but intentionally root-only.
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
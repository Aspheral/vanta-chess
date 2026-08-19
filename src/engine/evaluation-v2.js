import { evaluate as baseEvaluate, personalityMoveBonus as basePersonalityMoveBonus, MATE_SCORE } from './evaluation.js';
import { staticExchangeEval } from './tactics.js';
import { WHITE, PIECE_VALUES, colorOf, typeOf, opposite, rowCol, inBounds } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

export { MATE_SCORE };

function homeMinorSquares(color) {
  return color === WHITE
    ? [[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]
    : [[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']];
}

function undevelopedMinorCount(position, color) {
  return homeMinorSquares(color).filter(([sq, piece]) => position.board[sq] === piece).length;
}

function isHomeMinorSquare(square, piece) {
  const color = colorOf(piece);
  return homeMinorSquares(color).some(([sq, p]) => sq === square && p === piece);
}

function openingDevelopmentFor(position, color) {
  if (position.fullmove > 14) return 0;
  const undeveloped = undevelopedMinorCount(position, color);
  const homeKing = color === WHITE ? 60 : 4;
  const king = position.kingSquare(color);
  const rights = color === WHITE ? ['K', 'Q'] : ['k', 'q'];
  const pawn = color === WHITE ? 'P' : 'p';
  const homePawnRow = color === WHITE ? 6 : 1;

  // The base evaluator already rewards development. This layer is intentionally
  // modest after reference testing showed that an earlier, larger bonus could
  // bully Vanta away from tactically justified knight manoeuvres.
  let score = -undeveloped * 8;

  const castled = color === WHITE ? [62, 58].includes(king) : [6, 2].includes(king);
  if (castled) score += 18;
  else if (king === homeKing) {
    if (rights.some(r => position.castling.includes(r))) score += 4;
    if (position.fullmove >= 8 && undeveloped <= 2) score -= 3;
  } else if (position.fullmove <= 12) score -= 10;

  if (undeveloped >= 2) {
    for (const file of [0, 1, 6, 7]) {
      let bestAdvance = 0;
      for (let row = 0; row < 8; row++) {
        if (position.board[row * 8 + file] !== pawn) continue;
        const advance = color === WHITE ? homePawnRow - row : row - homePawnRow;
        bestAdvance = Math.max(bestAdvance, advance);
      }
      if (bestAdvance > 0) score -= bestAdvance * (file >= 6 ? 5 : 3);
    }
  }

  if (color === WHITE) {
    if (!position.board[61]) score += 3;
    if (!position.board[62]) score += 3;
  } else {
    if (!position.board[5]) score += 3;
    if (!position.board[6]) score += 3;
  }
  return score;
}

// The base evaluator already builds a full attack map, counts safe king exits,
// rays, shield integrity, nearby attackers, and loose pieces. This extra term is
// intentionally cheap: it supplies nonlinear accumulation without rebuilding
// attack maps a second time at every leaf.
function kingDanger(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 1000;
  const enemy = opposite(color);
  const [kr, kc] = rowCol(king);
  let danger = 0;

  const forward = color === WHITE ? -1 : 1;
  let shield = 0;
  for (const dc of [-1, 0, 1]) {
    const rr = kr + forward, cc = kc + dc;
    if (!inBounds(rr, cc)) continue;
    const piece = position.board[rr * 8 + cc];
    if (piece && colorOf(piece) === color && typeOf(piece) === 'p') shield++;
  }
  danger += (3 - shield) * 8;

  let nearbyAttackers = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== enemy || typeOf(piece) === 'k') continue;
    const [r, c] = rowCol(sq);
    const distance = Math.max(Math.abs(r - kr), Math.abs(c - kc));
    if (distance > 4) continue;
    const weight = typeOf(piece) === 'q' ? 7 : typeOf(piece) === 'r' ? 5 : ['b', 'n'].includes(typeOf(piece)) ? 3 : 1;
    nearbyAttackers += Math.max(0, 5 - distance) * weight;
  }
  danger += nearbyAttackers;

  for (const file of [kc - 1, kc, kc + 1]) {
    if (file < 0 || file > 7) continue;
    let ownPawn = false, enemyHeavy = false;
    for (let row = 0; row < 8; row++) {
      const p = position.board[row * 8 + file];
      if (!p) continue;
      if (colorOf(p) === color && typeOf(p) === 'p') ownPawn = true;
      if (colorOf(p) === enemy && ['q', 'r'].includes(typeOf(p))) enemyHeavy = true;
    }
    if (!ownPawn) danger += enemyHeavy ? 14 : 6;
  }

  const homeKing = color === WHITE ? 60 : 4;
  if (position.fullmove <= 14 && king === homeKing && undevelopedMinorCount(position, color) >= 2) danger += 10;
  const castled = color === WHITE ? [62, 58].includes(king) : [6, 2].includes(king);
  if (!castled && position.fullmove >= 12) danger += 8;

  return Math.round(danger + (danger * danger) / 55);
}

function isPassed(position, sq, color) {
  const [r, c] = rowCol(sq);
  const dir = color === WHITE ? -1 : 1;
  const enemyPawn = color === WHITE ? 'p' : 'P';
  for (const file of [c - 1, c, c + 1]) {
    if (file < 0 || file > 7) continue;
    for (let rr = r + dir; rr >= 0 && rr < 8; rr += dir) {
      if (position.board[rr * 8 + file] === enemyPawn) return false;
    }
  }
  return true;
}

function passedPawnUrgencyFor(position, color) {
  const pawn = color === WHITE ? 'P' : 'p';
  const distanceBonus = [0, 300, 155, 82, 44, 24, 12, 0];
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    if (position.board[sq] !== pawn || !isPassed(position, sq, color)) continue;
    const [row, col] = rowCol(sq);
    const distance = color === WHITE ? row : 7 - row;
    if (distance <= 0 || distance >= distanceBonus.length) continue;
    let value = distanceBonus[distance];
    const frontRow = row + (color === WHITE ? -1 : 1);
    if (inBounds(frontRow, col) && position.board[frontRow * 8 + col]) value *= 0.52;
    if (distance === 1) value += 45;
    total += value;
  }
  return Math.round(total);
}

// Base evaluation already has attack-map-based loose-piece scoring. Keep a cheap
// public diagnostic here so regression reports can separate that class of risk.
function loosePieceRiskFor(position, color) {
  const enemy = opposite(color);
  let risk = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) === 'k') continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    if (value < PIECE_VALUES.r) continue;
    if (position.isSquareAttacked(sq, enemy) && !position.isSquareAttacked(sq, color)) risk += Math.round(value * 0.12);
  }
  return risk;
}

export function evaluate(position, perspective = position.turn) {
  let score = baseEvaluate(position, perspective);
  score += openingDevelopmentFor(position, perspective) - openingDevelopmentFor(position, opposite(perspective));

  const ownDanger = kingDanger(position, perspective);
  const enemyDanger = kingDanger(position, opposite(perspective));
  score += Math.round((enemyDanger - ownDanger) * 0.58);

  score += passedPawnUrgencyFor(position, perspective) - passedPawnUrgencyFor(position, opposite(perspective));
  return Math.round(score);
}

export function personalityMoveBonus(position, move) {
  let bonus = basePersonalityMoveBonus(position, move);
  const us = position.turn;
  const type = typeOf(move.piece);
  const next = position.makeMove(move);
  const givesCheck = next.isInCheck();
  const tactical = givesCheck || Boolean(move.flags & FLAGS.CAPTURE) || Boolean(move.promotion);

  if (position.fullmove <= 12) {
    const undeveloped = undevelopedMinorCount(position, us);
    if (['n', 'b'].includes(type) && !isHomeMinorSquare(move.from, move.piece) && undeveloped > 0 && !tactical) {
      bonus -= 8 + undeveloped * 4;
    }
    if (['n', 'b'].includes(type) && isHomeMinorSquare(move.from, move.piece) && !isHomeMinorSquare(move.to, move.piece)) bonus += 8;
    if (type === 'p' && undeveloped >= 2) {
      const file = move.from % 8;
      if ([0, 1, 6, 7].includes(file) && !tactical) bonus -= file >= 6 ? 8 : 5;
    }
  }

  const see = staticExchangeEval(position, move);
  if (see < -80 && !move.promotion) {
    const scale = givesCheck ? 0.08 : 0.18;
    bonus -= Math.min(90, Math.round(-see * scale));
  }

  const beforeDanger = kingDanger(position, us);
  const afterDanger = kingDanger(next, us);
  if (afterDanger > beforeDanger) bonus -= Math.min(90, Math.round((afterDanger - beforeDanger) * 0.55));

  const beforePasser = passedPawnUrgencyFor(position, us);
  const afterPasser = passedPawnUrgencyFor(next, us);
  if (afterPasser > beforePasser) bonus += Math.min(36, Math.round((afterPasser - beforePasser) * 0.12));

  return Math.round(bonus);
}

export const evaluationDiagnostics = {
  openingDevelopmentFor,
  kingDanger,
  passedPawnUrgencyFor,
  loosePieceRiskFor,
  undevelopedMinorCount,
};

import { evaluate as baseEvaluate, personalityMoveBonus as basePersonalityMoveBonus, MATE_SCORE } from './evaluation.js';
import { staticExchangeEval, moveGivesCheck } from './tactics.js';
import { WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, opposite, rowCol, inBounds, KING_DELTAS } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

export { MATE_SCORE };

function signed(color, perspective) { return color === perspective ? 1 : -1; }

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
  let score = -undeveloped * 19;

  const castled = color === WHITE ? [62, 58].includes(king) : [6, 2].includes(king);
  if (castled) score += 38;
  else if (king === homeKing) {
    const hasRights = rights.some(r => position.castling.includes(r));
    if (hasRights) score += 9;
    if (position.fullmove >= 8 && undeveloped <= 2) score -= 8;
  } else if (position.fullmove <= 12) score -= 24;

  // Early flank-pawn motion is expensive when the army behind it is still asleep.
  if (undeveloped >= 2) {
    for (const file of [0, 1, 6, 7]) {
      let bestAdvance = 0;
      for (let row = 0; row < 8; row++) {
        if (position.board[row * 8 + file] !== pawn) continue;
        const advance = color === WHITE ? homePawnRow - row : row - homePawnRow;
        bestAdvance = Math.max(bestAdvance, advance);
      }
      if (bestAdvance > 0) score -= bestAdvance * (file >= 6 ? 11 : 7);
    }
  }

  // Reward actually opening castling lanes, not merely shuffling developed pieces.
  if (color === WHITE) {
    if (!position.board[61]) score += 8;
    if (!position.board[62]) score += 8;
  } else {
    if (!position.board[5]) score += 8;
    if (!position.board[6]) score += 8;
  }
  return score;
}

function kingDanger(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 1000;
  const enemy = opposite(color);
  const [kr, kc] = rowCol(king);
  let danger = 0;
  let attackedRing = 0, safeRing = 0;

  for (const [dr, dc] of KING_DELTAS) {
    const rr = kr + dr, cc = kc + dc;
    if (!inBounds(rr, cc)) continue;
    const sq = rr * 8 + cc;
    const own = position.board[sq] && colorOf(position.board[sq]) === color;
    if (own) continue;
    if (position.isSquareAttacked(sq, enemy)) attackedRing++;
    else safeRing++;
  }
  danger += attackedRing * 9;
  if (safeRing <= 1) danger += 20;

  const forward = color === WHITE ? -1 : 1;
  let shield = 0;
  for (const dc of [-1, 0, 1]) {
    const rr = kr + forward, cc = kc + dc;
    if (!inBounds(rr, cc)) continue;
    const piece = position.board[rr * 8 + cc];
    if (piece && colorOf(piece) === color && typeOf(piece) === 'p') shield++;
  }
  danger += (3 - shield) * 7;

  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== enemy || typeOf(piece) === 'k') continue;
    const [r, c] = rowCol(sq);
    const distance = Math.max(Math.abs(r - kr), Math.abs(c - kc));
    if (distance > 4) continue;
    const weight = typeOf(piece) === 'q' ? 7 : typeOf(piece) === 'r' ? 5 : ['b', 'n'].includes(typeOf(piece)) ? 3 : 1;
    danger += Math.max(0, 5 - distance) * weight;
  }

  // Open/semi-open files adjacent to the king become dangerous very quickly with rooks/queen present.
  for (const file of [kc - 1, kc, kc + 1]) {
    if (file < 0 || file > 7) continue;
    let ownPawn = false, enemyHeavy = false;
    for (let row = 0; row < 8; row++) {
      const p = position.board[row * 8 + file];
      if (!p) continue;
      if (colorOf(p) === color && typeOf(p) === 'p') ownPawn = true;
      if (colorOf(p) === enemy && ['q', 'r'].includes(typeOf(p))) enemyHeavy = true;
    }
    if (!ownPawn) danger += enemyHeavy ? 14 : 7;
  }

  if (position.isSquareAttacked(king, enemy)) danger += 26;
  const homeKing = color === WHITE ? 60 : 4;
  if (position.fullmove <= 14 && king === homeKing && undevelopedMinorCount(position, color) >= 2) danger += 8;

  // Nonlinear accumulation: several modest defects together are much worse than one.
  return Math.round(danger + (danger * danger) / 38);
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
  const enemy = opposite(color);
  const distanceBonus = [0, 280, 145, 78, 42, 24, 12, 0];
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    if (position.board[sq] !== pawn || !isPassed(position, sq, color)) continue;
    const [row, col] = rowCol(sq);
    const distance = color === WHITE ? row : 7 - row;
    if (distance <= 0 || distance >= distanceBonus.length) continue;
    let value = distanceBonus[distance];
    const dir = color === WHITE ? -1 : 1;
    const frontRow = row + dir;
    if (inBounds(frontRow, col)) {
      const front = frontRow * 8 + col;
      if (position.board[front]) value *= 0.48;
      if (position.isSquareAttacked(front, color)) value *= 1.12;
      if (position.isSquareAttacked(front, enemy)) value *= 0.82;
    }
    if (position.isSquareAttacked(sq, color)) value *= 1.12;
    if (distance === 1) {
      const promotionMoves = position.turn === color
        ? position.legalMoves().filter(move => move.from === sq && move.promotion)
        : [];
      if (promotionMoves.some(move => position.makeMove(move).isInCheck())) value += 80;
    }
    total += value;
  }
  return Math.round(total);
}

function loosePieceRiskFor(position, color) {
  const enemy = opposite(color);
  let risk = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) === 'k') continue;
    if (!position.isSquareAttacked(sq, enemy)) continue;
    const defended = position.isSquareAttacked(sq, color);
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    if (!defended) risk += Math.round(value * (value >= PIECE_VALUES.r ? 0.16 : 0.12));
    else if (value >= PIECE_VALUES.r) risk += Math.round(value * 0.045);
  }
  return risk;
}

export function evaluate(position, perspective = position.turn) {
  let score = baseEvaluate(position, perspective);
  score += openingDevelopmentFor(position, perspective) - openingDevelopmentFor(position, opposite(perspective));

  const ownDanger = kingDanger(position, perspective);
  const enemyDanger = kingDanger(position, opposite(perspective));
  score += Math.round((enemyDanger - ownDanger) * 0.72);

  score += passedPawnUrgencyFor(position, perspective) - passedPawnUrgencyFor(position, opposite(perspective));
  score += loosePieceRiskFor(position, opposite(perspective)) - loosePieceRiskFor(position, perspective);
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
      bonus -= 18 + undeveloped * 9;
    }
    if (['n', 'b'].includes(type) && isHomeMinorSquare(move.from, move.piece) && !isHomeMinorSquare(move.to, move.piece)) {
      bonus += 14;
    }
    if (type === 'p' && undeveloped >= 2) {
      const file = move.from % 8;
      if ([0, 1, 6, 7].includes(file) && !tactical) bonus -= file >= 6 ? 18 : 11;
    }
  }

  const see = staticExchangeEval(position, move);
  if (see < -80 && !move.promotion) {
    // Sacrifices are welcome only when the forcing line itself justifies them.
    // The personality layer must never manufacture compensation search did not find.
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

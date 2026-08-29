import { PIECE_VALUES, colorOf, typeOf, opposite, rowCol, pieceFor, inBounds } from '../chess/constants.js';

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function signed(color, perspective) { return color === perspective ? 1 : -1; }
function distance(a, b) {
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}

function nonPawnMaterial(position) {
  let total = 0;
  let queens = 0;
  let pieces = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'q') queens++;
    if (!['p', 'k'].includes(type)) {
      total += PIECE_VALUES[type] || 0;
      pieces++;
    }
  }
  return { total, queens, pieces };
}

export function endgameWeight(position) {
  const m = nonPawnMaterial(position);
  let weight = clamp((3600 - m.total) / 2400, 0, 1);
  if (m.queens) weight *= 0.42;
  if (m.total <= 1800 && m.queens === 0) weight = Math.max(weight, 0.82);
  if (m.total <= 1000 && m.queens === 0) weight = 1;
  return Number(weight.toFixed(3));
}

function isPassedPawn(position, square, color) {
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

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return clamp(color === 'w' ? 6 - row : row - 1, 0, 6);
}

function kingCentrality(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 0;
  const centers = [27, 28, 35, 36];
  const d = Math.min(...centers.map(sq => distance(king, sq)));
  return (3 - Math.min(3, d)) * 12;
}

function rookBehindPasser(position, rookSquare, pawnSquare, pawnColor) {
  const [, rookFile] = rowCol(rookSquare);
  const [pawnRow, pawnFile] = rowCol(pawnSquare);
  if (rookFile !== pawnFile) return false;
  const [rookRow] = rowCol(rookSquare);
  const behind = pawnColor === 'w' ? rookRow > pawnRow : rookRow < pawnRow;
  if (!behind) return false;
  const step = rookRow < pawnRow ? 1 : -1;
  for (let r = rookRow + step; r !== pawnRow; r += step) {
    if (position.board[r * 8 + rookFile]) return false;
  }
  return true;
}

function passedPawnScore(position, color) {
  const ownKing = position.kingSquare(color);
  const enemyKing = position.kingSquare(opposite(color));
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (piece !== pieceFor(color, 'p') || !isPassedPawn(position, sq, color)) continue;
    const progress = pawnProgress(sq, color);
    const race = [0, 2, 6, 14, 30, 68, 135][progress];
    score += race;

    if (ownKing >= 0) score += Math.max(0, 4 - distance(ownKing, sq)) * (progress >= 4 ? 6 : 3);
    if (enemyKing >= 0) score += Math.max(-12, Math.min(24, (distance(enemyKing, sq) - 2) * 4));

    const [row, file] = rowCol(sq);
    const frontRow = row + (color === 'w' ? -1 : 1);
    if (inBounds(frontRow, file)) {
      const blocker = position.board[frontRow * 8 + file];
      if (blocker && colorOf(blocker) === opposite(color)) score -= progress >= 4 ? 26 : 12;
    }

    for (let rookSq = 0; rookSq < 64; rookSq++) {
      if (position.board[rookSq] === pieceFor(color, 'r') && rookBehindPasser(position, rookSq, sq, color)) {
        score += progress >= 4 ? 28 : 18;
        break;
      }
    }
  }
  return score;
}

function blockadeScore(position, color) {
  let score = 0;
  const enemy = opposite(color);
  for (let sq = 0; sq < 64; sq++) {
    const pawn = position.board[sq];
    if (pawn !== pieceFor(enemy, 'p') || !isPassedPawn(position, sq, enemy)) continue;
    const progress = pawnProgress(sq, enemy);
    if (progress < 3) continue;
    const [row, file] = rowCol(sq);
    const frontRow = row + (enemy === 'w' ? -1 : 1);
    if (!inBounds(frontRow, file)) continue;
    const blocker = position.board[frontRow * 8 + file];
    if (blocker && colorOf(blocker) === color) {
      const type = typeOf(blocker);
      score += type === 'k' ? 34 : type === 'n' || type === 'b' ? 28 : type === 'r' ? 20 : 12;
      score += progress >= 5 ? 22 : progress === 4 ? 10 : 0;
    }
  }
  return score;
}

function kingPasserProximity(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 0;
  let bestEnemy = Infinity;
  let bestOwn = Infinity;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const pc = colorOf(piece);
    if (!isPassedPawn(position, sq, pc)) continue;
    const d = distance(king, sq);
    if (pc === color) bestOwn = Math.min(bestOwn, d);
    else bestEnemy = Math.min(bestEnemy, d);
  }
  let score = 0;
  if (Number.isFinite(bestEnemy)) score += Math.max(0, 5 - bestEnemy) * 8;
  if (Number.isFinite(bestOwn)) score += Math.max(0, 4 - bestOwn) * 4;
  return score;
}

function pawnOnlyOpposition(position, color) {
  const m = nonPawnMaterial(position);
  if (m.total !== 0) return 0;
  const us = position.kingSquare(color), them = position.kingSquare(opposite(color));
  if (us < 0 || them < 0) return 0;
  const [ur, uc] = rowCol(us), [tr, tc] = rowCol(them);
  const opposition = (ur === tr && Math.abs(uc - tc) === 2) || (uc === tc && Math.abs(ur - tr) === 2);
  if (!opposition) return 0;
  return position.turn === color ? -10 : 14;
}

export function endgameSpecialistBreakdown(position, perspective = position.turn) {
  const weight = endgameWeight(position);
  if (weight <= 0) return { weight: 0, kingActivity: 0, passers: 0, blockade: 0, opposition: 0, total: 0 };

  const them = opposite(perspective);
  const kingActivityRaw = kingCentrality(position, perspective) - kingCentrality(position, them)
    + kingPasserProximity(position, perspective) - kingPasserProximity(position, them);
  const passersRaw = passedPawnScore(position, perspective) - passedPawnScore(position, them);
  const blockadeRaw = blockadeScore(position, perspective) - blockadeScore(position, them);
  const oppositionRaw = pawnOnlyOpposition(position, perspective) - pawnOnlyOpposition(position, them);

  const kingActivity = Math.round(kingActivityRaw * weight);
  const passers = Math.round(passersRaw * weight);
  const blockade = Math.round(blockadeRaw * weight);
  const opposition = Math.round(oppositionRaw * weight);
  const total = kingActivity + passers + blockade + opposition;
  return { weight, kingActivity, passers, blockade, opposition, total };
}

export function endgameSpecialistScore(position, perspective = position.turn) {
  return endgameSpecialistBreakdown(position, perspective).total;
}

/**
 * Search selectivity hint only. No clock policy is changed here. Advanced pawn
 * races and very low-material king endings should not be shaved by LMR as if
 * they were routine middlegame quiet moves.
 */
export function endgameVolatility(position) {
  const weight = endgameWeight(position);
  if (weight < 0.55) return 0;
  let advanced = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'p') continue;
    const color = colorOf(piece);
    if (isPassedPawn(position, sq, color) && pawnProgress(sq, color) >= 4) advanced++;
  }
  const pieces = position.board.filter(Boolean).length;
  return Math.min(100, Math.round(advanced * 28 + (pieces <= 8 ? 35 : pieces <= 12 ? 18 : 0)));
}

export function isEndgameCriticalMove(position, move) {
  if (!move || endgameWeight(position) < 0.6 || move.promotion) return false;
  const type = typeOf(move.piece);
  if (type === 'p') {
    const after = position.makeMove(move);
    return pawnProgress(move.to, colorOf(move.piece)) >= 4 && isPassedPawn(after, move.to, colorOf(move.piece));
  }
  if (type === 'k' && position.board.filter(Boolean).length <= 10) return true;
  return false;
}

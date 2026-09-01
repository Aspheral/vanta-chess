import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, inBounds,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({
    king: 60,
    queen: 59,
    queenPiece: 'Q',
    minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]),
    castles: Object.freeze([62, 58]),
    rights: 'KQ',
  }),
  [BLACK]: Object.freeze({
    king: 4,
    queen: 3,
    queenPiece: 'q',
    minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]),
    castles: Object.freeze([6, 2]),
    rights: 'kq',
  }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function squareDistance(a, b) {
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}

function centerDistance(square) {
  return Math.min(...[27, 28, 35, 36].map(center => squareDistance(square, center)));
}

function pieceAttacksSquare(position, from, target) {
  const piece = position.board[from];
  if (!piece) return false;
  const color = colorOf(piece);
  const type = typeOf(piece);
  const [fr, fc] = rowCol(from);
  const [tr, tc] = rowCol(target);
  const dr = tr - fr;
  const dc = tc - fc;

  if (type === 'p') {
    const step = color === WHITE ? -1 : 1;
    return dr === step && Math.abs(dc) === 1;
  }
  if (type === 'n') return KNIGHT_DELTAS.some(([r, c]) => r === dr && c === dc);
  if (type === 'k') return KING_DELTAS.some(([r, c]) => r === dr && c === dc);

  const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
  for (const [stepR, stepC] of dirs) {
    if (stepR === 0 && dr !== 0) continue;
    if (stepC === 0 && dc !== 0) continue;
    if (stepR !== 0 && stepC !== 0 && Math.abs(dr) !== Math.abs(dc)) continue;
    if (dr !== 0 && Math.sign(dr) !== Math.sign(stepR)) continue;
    if (dc !== 0 && Math.sign(dc) !== Math.sign(stepC)) continue;
    let r = fr + stepR;
    let c = fc + stepC;
    while (inBounds(r, c)) {
      const sq = r * 8 + c;
      if (sq === target) return true;
      if (position.board[sq]) break;
      r += stepR;
      c += stepC;
    }
  }
  return false;
}

function minorStats(position, color) {
  const home = HOME[color];
  let surviving = 0;
  let active = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || !['n', 'b'].includes(typeOf(piece))) continue;
    surviving++;
    const onHome = home.minors.some(([homeSq, homePiece]) => homeSq === sq && homePiece === piece);
    if (!onHome) active++;
  }
  return {
    surviving,
    active,
    casualties: Math.max(0, 4 - surviving),
    unmobilized: Math.max(0, 4 - active),
  };
}

function hasCastlingRight(position, color) {
  return [...HOME[color].rights].some(right => position.castling.includes(right));
}

function isCastled(position, color) {
  return HOME[color].castles.includes(position.kingSquare(color));
}

function queensPresent(position) {
  return position.board.includes('Q') && position.board.includes('q');
}

function nonPawnMaterial(position) {
  let total = 0;
  let queens = 0;
  let rooks = 0;
  let minors = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'q') queens++;
    if (type === 'r') rooks++;
    if (type === 'n' || type === 'b') minors++;
    if (!['p', 'k'].includes(type)) total += PIECE_VALUES[type] || 0;
  }
  return { total, queens, rooks, minors };
}

export function endgamePhase(position) {
  const material = nonPawnMaterial(position);
  const queenless = material.queens === 0;
  const lowMaterial = material.total <= 3000;
  const deep = queenless && (material.total <= 1700 || (material.rooks <= 2 && material.minors <= 2));
  const weight = !queenless ? 0 : deep ? 1 : lowMaterial ? 0.82 : 0.58;
  return { ...material, queenless, deep, weight };
}

function isPassedPawn(position, square, color) {
  const [row, file] = rowCol(square);
  const direction = color === WHITE ? -1 : 1;
  const enemyPawn = color === WHITE ? 'p' : 'P';
  for (const f of [file - 1, file, file + 1]) {
    if (f < 0 || f > 7) continue;
    for (let r = row + direction; r >= 0 && r < 8; r += direction) {
      if (position.board[r * 8 + f] === enemyPawn) return false;
    }
  }
  return true;
}

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function squaresToPromotion(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? row : 7 - row;
}

function passedPawns(position, color) {
  const pawn = color === WHITE ? 'P' : 'p';
  const result = [];
  for (let sq = 0; sq < 64; sq++) {
    if (position.board[sq] === pawn && isPassedPawn(position, sq, color)) result.push(sq);
  }
  return result;
}

function rookBehindPasserBonus(position, color, pawnSq) {
  const [pawnRow, file] = rowCol(pawnSq);
  let score = 0;
  for (let row = 0; row < 8; row++) {
    const sq = row * 8 + file;
    const piece = position.board[sq];
    if (!piece || typeOf(piece) !== 'r') continue;
    const rookColor = colorOf(piece);
    const behindForPawn = color === WHITE ? row > pawnRow : row < pawnRow;
    if (!behindForPawn) continue;
    score += rookColor === color ? 22 : -20;
  }
  return score;
}

function passedPawnEndgameScore(position, color) {
  const enemy = opposite(color);
  const ownKing = position.kingSquare(color);
  const enemyKing = position.kingSquare(enemy);
  let score = 0;
  for (const pawnSq of passedPawns(position, color)) {
    const progress = pawnProgress(pawnSq, color);
    if (progress < 2) continue;
    const promo = promotionSquare(pawnSq, color);
    const steps = Math.max(1, squaresToPromotion(pawnSq, color));
    const ownKingDistance = ownKing >= 0 ? squareDistance(ownKing, pawnSq) : 7;
    const enemyKingDistance = enemyKing >= 0 ? squareDistance(enemyKing, promo) : 7;
    const tempo = position.turn === color ? 1 : 0;
    const raceMargin = enemyKingDistance + tempo - steps;

    score += progress * 13;
    score += clamp((4 - ownKingDistance) * 5, -10, 18);
    if (raceMargin >= 1) score += Math.min(90, 24 + raceMargin * 14 + progress * 5);
    else if (raceMargin <= -2) score -= Math.min(42, Math.abs(raceMargin) * 8);

    const [row, file] = rowCol(pawnSq);
    const frontRow = row + (color === WHITE ? -1 : 1);
    if (inBounds(frontRow, file)) {
      const blocker = position.board[frontRow * 8 + file];
      if (blocker && colorOf(blocker) === enemy) score -= 24 + Math.min(24, (PIECE_VALUES[typeOf(blocker)] || 0) / 20);
    }

    score += rookBehindPasserBonus(position, color, pawnSq);
  }
  return score;
}

function kingEndgameScore(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return -1000;
  let score = (4 - centerDistance(king)) * 11;
  const enemyPassers = passedPawns(position, opposite(color));
  if (enemyPassers.length) {
    const nearest = Math.min(...enemyPassers.map(sq => squareDistance(king, sq)));
    score += clamp((5 - nearest) * 7, -14, 28);
  }
  const ownPassers = passedPawns(position, color);
  if (ownPassers.length) {
    const nearest = Math.min(...ownPassers.map(sq => squareDistance(king, sq)));
    score += clamp((4 - nearest) * 5, -10, 20);
  }
  return score;
}

function openingPositionForColor(position, color) {
  if (position.fullmove > 16) return 0;
  const home = HOME[color];
  const minors = minorStats(position, color);
  const king = position.kingSquare(color);
  let score = minors.active * 9 - minors.casualties * 15;

  if (isCastled(position, color)) score += 38;
  else if (king === home.king && hasCastlingRight(position, color)) score += position.fullmove >= 8 ? 2 : 7;
  else if (queensPresent(position)) score -= position.fullmove <= 12 ? 34 : 22;

  if (position.board[home.queen] !== home.queenPiece && minors.active < 3) {
    score -= 18 + (3 - minors.active) * 7;
  }

  return score;
}

export function endgameStrategicScore(position, perspective = position.turn) {
  const phase = endgamePhase(position);
  if (phase.weight <= 0) return 0;
  const own = kingEndgameScore(position, perspective) + passedPawnEndgameScore(position, perspective);
  const enemy = kingEndgameScore(position, opposite(perspective)) + passedPawnEndgameScore(position, opposite(perspective));
  return Math.round((own - enemy) * phase.weight);
}

export function strategicPositionScore(position, perspective = position.turn) {
  const opening = openingPositionForColor(position, perspective) - openingPositionForColor(position, opposite(perspective));
  return Math.round(opening + endgameStrategicScore(position, perspective));
}

export function openingMoveDiscipline(position, move) {
  if (!move || position.fullmove > 16) return 0;
  const us = position.turn;
  const home = HOME[us];
  const type = typeOf(move.piece);
  const minors = minorStats(position, us);
  const capturedValue = move.captured ? PIECE_VALUES[typeOf(move.captured)] || 0 : 0;
  const next = position.makeMove(move);
  const givesCheck = next.isInCheck();
  const forcing = givesCheck || Boolean(move.promotion) || capturedValue >= PIECE_VALUES.n;
  const pieceUnderAttack = position.isSquareAttacked(move.from, opposite(us));
  let bonus = 0;

  const castle = Boolean(move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q));
  if (castle) {
    bonus += 42 + Math.min(18, minors.active * 5);
    return bonus;
  }

  if (type === 'k' && move.from === home.king && hasCastlingRight(position, us) && !position.isInCheck() && queensPresent(position) && !forcing) {
    bonus -= position.fullmove <= 12 ? 58 : 38;
  }

  if (type === 'n' || type === 'b') {
    const fromHome = home.minors.some(([sq, piece]) => sq === move.from && piece === move.piece);
    if (fromHome) {
      bonus += minors.active < 3 ? 22 : 12;
    } else if (minors.unmobilized >= 2 && !forcing) {
      bonus -= 30 + Math.min(18, (minors.unmobilized - 2) * 9);
    } else if (minors.unmobilized >= 1 && !forcing && position.fullmove <= 10) {
      bonus -= 14;
    }
  }

  if (type === 'n' && !forcing && !pieceUnderAttack) {
    const [toRow, toFile] = rowCol(move.to);
    // Penalize voluntary rim excursions, not emergency retreats. When a knight
    // is already attacked, tactical survival outranks aesthetic development.
    if (toFile === 0 || toFile === 7) bonus -= 40;
    else if (toRow === 0 || toRow === 7) bonus -= 15;
  }

  if (type === 'q' && minors.active < 3 && !forcing) {
    const repeatedQueenMove = move.from !== home.queen;
    bonus -= repeatedQueenMove ? 46 : 25;
    bonus -= Math.min(18, (3 - minors.active) * 6);
    if (capturedValue <= PIECE_VALUES.p) bonus -= 8;
  }

  if (type === 'r' && minors.active < 3 && !forcing) {
    bonus -= position.fullmove <= 10 ? 24 : 14;
  }

  if (type === 'p' && [0, 1, 6, 7].includes(move.from % 8) && minors.unmobilized >= 2 && !forcing) {
    bonus -= 12;
  }

  return Math.round(bonus);
}

function moveApproachesCriticalPawn(position, move, color) {
  if (typeOf(move.piece) !== 'k') return false;
  const targets = [
    ...passedPawns(position, color),
    ...passedPawns(position, opposite(color)),
  ].filter(sq => pawnProgress(sq, colorOf(position.board[sq])) >= 3);
  if (!targets.length) return centerDistance(move.to) < centerDistance(move.from);
  const before = Math.min(...targets.map(sq => squareDistance(move.from, sq)));
  const after = Math.min(...targets.map(sq => squareDistance(move.to, sq)));
  return after < before;
}

export function isEndgamePassedPawnPush(position, move) {
  if (!move || typeOf(move.piece) !== 'p' || move.promotion) return false;
  const phase = endgamePhase(position);
  if (phase.weight < 0.7) return false;
  const color = colorOf(move.piece);
  return pawnProgress(move.to, color) >= 3 && isPassedPawn(position.makeMove(move), move.to, color);
}

export function isEndgameCriticalMove(position, move) {
  if (!move) return false;
  if (isEndgamePassedPawnPush(position, move)) return true;
  const phase = endgamePhase(position);
  if (phase.weight < 0.7) return false;
  return typeOf(move.piece) === 'k' && phase.deep && moveApproachesCriticalPawn(position, move, position.turn);
}

export function rootImmediateMaterialLoss(position, move, memo = new Map()) {
  if (!move) return 100000;
  const after = position.makeMove(move);
  let worst = 0;
  for (const reply of after.legalMoves({ capturesOnly: true })) {
    if (!(reply.flags & FLAGS.CAPTURE) && !reply.promotion) continue;
    worst = Math.max(worst, staticExchangeEval(after, reply, memo));
  }
  return Math.max(0, Math.round(worst));
}

export function quietTacticalThreatScore(position, move) {
  if (!move || (move.flags & FLAGS.CAPTURE) || move.promotion) return 0;
  const us = position.turn;
  const enemy = opposite(us);
  const after = position.makeMove(move);
  if (after.isInCheck()) return 0;

  const directTargets = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = after.board[sq];
    if (!piece || colorOf(piece) !== enemy || !['n', 'b', 'r', 'q'].includes(typeOf(piece))) continue;
    if (pieceAttacksSquare(after, move.to, sq)) directTargets.push(PIECE_VALUES[typeOf(piece)] || 0);
  }
  directTargets.sort((a, b) => b - a);
  if (directTargets.length >= 2) {
    return 440 + Math.min(260, Math.round((directTargets[0] + directTargets[1] - 600) * 0.35));
  }

  const newlyAttacked = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = after.board[sq];
    if (!piece || colorOf(piece) !== enemy) continue;
    const type = typeOf(piece);
    if (!['n', 'b', 'r', 'q'].includes(type)) continue;
    if (!after.isSquareAttacked(sq, us) || position.isSquareAttacked(sq, us)) continue;
    newlyAttacked.push({ value: PIECE_VALUES[type] || 0, sq });
  }

  if (!newlyAttacked.length) return 0;
  newlyAttacked.sort((a, b) => b.value - a.value);
  if (newlyAttacked.length >= 2) {
    return 420 + Math.min(240, Math.round((newlyAttacked[0].value + newlyAttacked[1].value - 600) * 0.32));
  }

  const target = newlyAttacked[0];
  if (target.value >= PIECE_VALUES.q) return 390;
  if (target.value >= PIECE_VALUES.r) return 340;
  if (!after.isSquareAttacked(target.sq, enemy) && target.value >= PIECE_VALUES.n) return 310;
  return 0;
}

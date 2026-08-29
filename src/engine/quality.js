import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite,
  BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, KING_DELTAS, inBounds,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval, rootTacticalRisk, isCriticalPassedPawnPush } from './tactics.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({
    king: 60, queen: 59, castleSquares: Object.freeze([62, 58]),
    minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]),
    rights: 'KQ',
  }),
  [BLACK]: Object.freeze({
    king: 4, queen: 3, castleSquares: Object.freeze([6, 2]),
    minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]),
    rights: 'kq',
  }),
});

const VALUABLE = new Set(['n', 'b', 'r', 'q']);

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function pieceValue(piece) { return piece ? (PIECE_VALUES[typeOf(piece)] || 0) : 0; }
function kingDistance(a, b) {
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}

function hasCastlingRight(position, color) {
  return [...HOME[color].rights].some(right => position.castling.includes(right));
}

function homeMinorCount(position, color) {
  return HOME[color].minors.reduce((count, [square, piece]) => count + (position.board[square] === piece ? 1 : 0), 0);
}

function isMinorHomeSquare(color, square, piece) {
  return HOME[color].minors.some(([homeSquare, homePiece]) => homeSquare === square && homePiece === piece);
}

function isCastlingMove(move) {
  return Boolean(move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q));
}

function isTacticalMove(position, move) {
  if (move.flags & FLAGS.CAPTURE || move.promotion) return true;
  return position.makeMove(move).isInCheck();
}

function attacksSquareFrom(position, from, target) {
  const piece = position.board[from];
  if (!piece) return false;
  const color = colorOf(piece), type = typeOf(piece);
  const [fr, fc] = rowCol(from), [tr, tc] = rowCol(target);
  const dr = tr - fr, dc = tc - fc;

  if (type === 'p') {
    const step = color === WHITE ? -1 : 1;
    return dr === step && Math.abs(dc) === 1;
  }
  if (type === 'n') return KNIGHT_DELTAS.some(([r, c]) => r === dr && c === dc);
  if (type === 'k') return KING_DELTAS.some(([r, c]) => r === dr && c === dc);

  const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
  for (const [sr, sc] of dirs) {
    if (sr === 0 && dr !== 0) continue;
    if (sc === 0 && dc !== 0) continue;
    if (sr !== 0 && sc !== 0 && Math.abs(dr) !== Math.abs(dc)) continue;
    if (dr && Math.sign(dr) !== Math.sign(sr)) continue;
    if (dc && Math.sign(dc) !== Math.sign(sc)) continue;
    let r = fr + sr, c = fc + sc;
    while (inBounds(r, c)) {
      const sq = r * 8 + c;
      if (sq === target) return true;
      if (position.board[sq]) break;
      r += sr; c += sc;
    }
  }
  return false;
}

function isPassedPawn(position, square, color) {
  const [row, file] = rowCol(square);
  const dir = color === WHITE ? -1 : 1;
  const enemyPawn = color === WHITE ? 'p' : 'P';
  for (const f of [file - 1, file, file + 1]) {
    if (f < 0 || f > 7) continue;
    for (let r = row + dir; r >= 0 && r < 8; r += dir) {
      if (position.board[r * 8 + f] === enemyPawn) return false;
    }
  }
  return true;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function rookBehindPasser(position, square, color) {
  const [pawnRow, file] = rowCol(square);
  const rook = color === WHITE ? 'R' : 'r';
  for (let row = 0; row < 8; row++) {
    const sq = row * 8 + file;
    if (position.board[sq] !== rook) continue;
    const behind = color === WHITE ? row > pawnRow : row < pawnRow;
    if (!behind) continue;
    let clear = true;
    const step = row < pawnRow ? 1 : -1;
    for (let r = row + step; r !== pawnRow; r += step) {
      if (position.board[r * 8 + file]) { clear = false; break; }
    }
    if (clear) return true;
  }
  return false;
}

function nonPawnMaterial(position) {
  let total = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'p' || type === 'k') continue;
    total += PIECE_VALUES[type] || 0;
  }
  return total;
}

function endgamePhase(position) {
  const npm = nonPawnMaterial(position);
  return clamp((3800 - npm) / 2700, 0, 1);
}

function centerDistance(square) {
  const centers = [27, 28, 35, 36];
  return Math.min(...centers.map(center => kingDistance(square, center)));
}

function endgameSideValue(position, color) {
  const phase = endgamePhase(position);
  if (phase <= 0) return 0;
  const enemy = opposite(color);
  const king = position.kingSquare(color);
  const enemyKing = position.kingSquare(enemy);
  let score = 0;

  if (king >= 0) score += Math.max(0, 4 - centerDistance(king)) * 10 * phase;

  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) !== 'p' || !isPassedPawn(position, sq, color)) continue;
    const progress = pawnProgress(sq, color);
    const promo = promotionSquare(sq, color);
    let passer = 8 + progress * progress * 3;

    if (king >= 0) passer += Math.max(0, 4 - kingDistance(king, sq)) * 5;
    if (enemyKing >= 0) {
      const movesToPromote = color === WHITE ? rowCol(sq)[0] : 7 - rowCol(sq)[0];
      const catchDistance = kingDistance(enemyKing, promo);
      const tempo = position.turn === color ? 0 : 1;
      if (catchDistance > movesToPromote + tempo) passer += 42 + progress * 8;
      else passer -= Math.max(0, 3 - kingDistance(enemyKing, sq)) * 6;
    }
    if (rookBehindPasser(position, sq, color)) passer += 28;

    const [row, file] = rowCol(sq);
    const frontRow = row + (color === WHITE ? -1 : 1);
    if (frontRow >= 0 && frontRow < 8) {
      const blocker = position.board[frontRow * 8 + file];
      if (blocker && colorOf(blocker) === enemy) passer -= 18;
    }
    score += passer * phase;
  }
  return score;
}

export function strategicPositionValue(position, perspective = position.turn) {
  // Opening discipline stays root-only. Injecting it into every leaf made the
  // same concept count repeatedly and disturbed already-proven tactical lines.
  // The endgame layer is genuinely positional and therefore belongs in static
  // evaluation once material has thinned out.
  const endgame = endgameSideValue(position, perspective) - endgameSideValue(position, opposite(perspective));
  return Math.round(endgame);
}

export function rootStrategicAdjustment(position, move) {
  if (!move) return -1000;
  const us = position.turn;
  const home = HOME[us];
  const type = typeOf(move.piece);
  const tactical = isTacticalMove(position, move);
  const homeMinors = homeMinorCount(position, us);
  let bonus = 0;

  if (position.fullmove <= 14) {
    if (['n', 'b'].includes(type)) {
      if (isMinorHomeSquare(us, move.from, move.piece)) bonus += 18;
      else if (homeMinors > 0 && !tactical) bonus -= 22 + homeMinors * 7;
    }

    if (type === 'q' && !tactical) {
      if (move.from !== home.queen) bonus -= 28 + homeMinors * 9;
      else if (homeMinors >= 2) bonus -= 18 + homeMinors * 5;
    }

    if (isCastlingMove(move)) {
      bonus += 34 + Math.min(22, Math.max(0, position.fullmove - 5) * 4);
    } else if (type === 'k' && move.from === home.king && hasCastlingRight(position, us) && !position.isInCheck(us)) {
      bonus -= 54;
    }

    if (type === 'p' && [5, 6, 7].includes(move.from % 8) && position.kingSquare(us) === home.king && hasCastlingRight(position, us) && homeMinors > 0 && !tactical) {
      bonus -= 10;
    }
  }

  const phase = endgamePhase(position);
  if (phase > 0.2) {
    const before = endgameSideValue(position, us) - endgameSideValue(position, opposite(us));
    const next = position.makeMove(move);
    const after = endgameSideValue(next, us) - endgameSideValue(next, opposite(us));
    bonus += clamp(Math.round((after - before) * 0.55), -42, 42);
  }

  return Math.round(clamp(bonus, -90, 90));
}

export function immediateMaterialLossRisk(position, move) {
  if (!move) return 100000;
  const after = position.makeMove(move);
  const us = position.turn;
  const them = opposite(us);
  let risk = 0;

  // Only call it an immediate-loss error when the candidate leaves one of our
  // already-attacked valuable pieces sitting on the same square and the enemy
  // can profitably take it. This prevents an unrelated tactical capture
  // elsewhere on the board from falsely marking every candidate as unsafe.
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== us || !VALUABLE.has(typeOf(piece))) continue;
    if (!position.isSquareAttacked(sq, them) || after.board[sq] !== piece) continue;

    for (const capture of after.legalMoves({ capturesOnly: true })) {
      if (capture.to !== sq || !(capture.flags & FLAGS.CAPTURE)) continue;
      const gain = staticExchangeEval(after, capture);
      const victim = pieceValue(capture.captured);
      if (gain < 220 || victim < 300) continue;
      risk = Math.max(risk, 620 + Math.min(360, Math.max(gain, victim) - 220));
    }
  }
  return risk;
}

export function rootSafetyRisk(position, move) {
  return Math.max(rootTacticalRisk(position, move), immediateMaterialLossRisk(position, move));
}

export function isForcingQuietThreat(position, move) {
  if (!move || move.flags & FLAGS.CAPTURE || move.promotion) return false;
  if (isCriticalPassedPawnPush(position, move)) return true;
  const us = position.turn;
  const them = opposite(us);
  const next = position.makeMove(move);
  if (next.isInCheck()) return true;

  let newValuableAttacks = 0;
  let severeSingle = false;
  for (let sq = 0; sq < 64; sq++) {
    const target = next.board[sq];
    if (!target || colorOf(target) !== them || !VALUABLE.has(typeOf(target))) continue;
    const newlyAttacked = next.isSquareAttacked(sq, us) && !position.isSquareAttacked(sq, us);
    if (!newlyAttacked) continue;
    newValuableAttacks++;
    const defended = next.isSquareAttacked(sq, them);
    const targetValue = PIECE_VALUES[typeOf(target)] || 0;
    const attacker = next.board[move.to];
    const attackerValue = attacker ? (PIECE_VALUES[typeOf(attacker)] || 0) : 1000;
    if (!defended || attackerValue + 80 < targetValue) severeSingle = true;
  }
  if (newValuableAttacks >= 2 || severeSingle) return true;

  const moved = next.board[move.to];
  if (!moved) return false;
  let directTargets = 0;
  for (let sq = 0; sq < 64; sq++) {
    const target = next.board[sq];
    if (!target || colorOf(target) !== them || !VALUABLE.has(typeOf(target))) continue;
    if (attacksSquareFrom(next, move.to, sq)) directTargets++;
  }
  return directTargets >= 2;
}

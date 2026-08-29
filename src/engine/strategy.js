import { FLAGS } from '../chess/position.js';
import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, opposite, rowCol, inBounds,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS,
} from '../chess/constants.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({ minors: Object.freeze([57, 62, 58, 61]), queen: 59, king: 60, rights: 'KQ' }),
  [BLACK]: Object.freeze({ minors: Object.freeze([1, 6, 2, 5]), queen: 3, king: 4, rights: 'kq' }),
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function signed(color, perspective) { return color === perspective ? 1 : -1; }
function kingDistance(a, b) {
  if (a < 0 || b < 0) return 8;
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}

function pieceAttacksSquare(position, from, target) {
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
  if (type === 'k') return Math.max(Math.abs(dr), Math.abs(dc)) === 1;
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

function attackersOf(position, square, color) {
  let count = 0;
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (piece && colorOf(piece) === color && pieceAttacksSquare(position, from, square)) count++;
  }
  return count;
}

function lowestAttackerValue(position, square, color) {
  let best = Infinity;
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || colorOf(piece) !== color || !pieceAttacksSquare(position, from, square)) continue;
    best = Math.min(best, PIECE_VALUES[typeOf(piece)] || 0);
  }
  return Number.isFinite(best) ? best : 0;
}

function pseudoDestinations(position, square) {
  const piece = position.board[square];
  if (!piece) return [];
  const color = colorOf(piece), type = typeOf(piece), [r, c] = rowCol(square);
  const destinations = [];
  const add = (rr, cc) => {
    if (!inBounds(rr, cc)) return false;
    const target = rr * 8 + cc;
    const occupant = position.board[target];
    if (!occupant || colorOf(occupant) !== color) destinations.push(target);
    return !occupant;
  };

  if (type === 'n') {
    for (const [dr, dc] of KNIGHT_DELTAS) add(r + dr, c + dc);
    return destinations;
  }
  if (type === 'b' || type === 'r' || type === 'q') {
    const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (inBounds(rr, cc)) {
        const clear = add(rr, cc);
        if (!clear) break;
        rr += dr; cc += dc;
      }
    }
  }
  return destinations;
}

/**
 * Cheap trap detector for non-pawn pieces. It deliberately does not call
 * legalMoves(), so it can be used by root planning without turning every
 * candidate into another search. A square counts as an escape when it is not
 * currently controlled, or when moving there captures a piece at least as
 * valuable as the trapped piece.
 */
export function trappedPiecePenalty(position, color) {
  const enemy = opposite(color);
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color) continue;
    const type = typeOf(piece);
    if (!['n', 'b', 'r', 'q'].includes(type) || !position.isSquareAttacked(sq, enemy)) continue;

    const value = PIECE_VALUES[type] || 0;
    const attacker = lowestAttackerValue(position, sq, enemy);
    const defenders = attackersOf(position, sq, color);
    let safeEscapes = 0;
    for (const target of pseudoDestinations(position, sq)) {
      const occupant = position.board[target];
      if (occupant && colorOf(occupant) === enemy && (PIECE_VALUES[typeOf(occupant)] || 0) >= value) {
        safeEscapes++;
        continue;
      }
      if (!position.isSquareAttacked(target, enemy)) safeEscapes++;
    }

    if (safeEscapes === 0 && attacker > 0 && attacker < value) {
      let penalty = type === 'q' ? 220 : type === 'r' ? 165 : 118;
      if (defenders === 0) penalty += type === 'q' ? 55 : type === 'r' ? 45 : 42;
      if (attacker <= PIECE_VALUES.p) penalty += type === 'q' ? 35 : type === 'r' ? 30 : 28;
      total += penalty;
    } else if (safeEscapes === 1 && attacker > 0 && attacker < value && defenders === 0) {
      total += type === 'q' ? 42 : type === 'r' ? 32 : 24;
    }
  }
  return Math.min(320, total);
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

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function movesToPromote(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? row : 7 - row;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function nonPawnMaterial(position) {
  let total = 0;
  let queens = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'q') queens++;
    if (!['p', 'k'].includes(type)) total += PIECE_VALUES[type] || 0;
  }
  return { total, queens };
}

export function isEndgame(position) {
  const { total, queens } = nonPawnMaterial(position);
  return queens === 0 || total <= 3000;
}

function kingCentralization(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 0;
  const [r, c] = rowCol(king);
  const distance = Math.max(Math.abs(r - 3.5), Math.abs(c - 3.5));
  return Math.round((3.5 - distance) * 8);
}

function rookBehindPasser(position, pawnSquare, pawnColor) {
  const [pr, pc] = rowCol(pawnSquare);
  const behindSign = pawnColor === WHITE ? 1 : -1;
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const rook = position.board[sq];
    if (!rook || typeOf(rook) !== 'r') continue;
    const [rr, rc] = rowCol(sq);
    if (rc !== pc || Math.sign(rr - pr) !== behindSign) continue;
    let clear = true;
    for (let r = pr + behindSign; r !== rr; r += behindSign) {
      if (position.board[r * 8 + pc]) { clear = false; break; }
    }
    if (!clear) continue;
    score += colorOf(rook) === pawnColor ? 18 : -16;
  }
  return score;
}

function passedPawnRaceScore(position, perspective) {
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    const pawn = position.board[sq];
    if (!pawn || typeOf(pawn) !== 'p') continue;
    const color = colorOf(pawn);
    if (!isPassedPawn(position, sq, color)) continue;
    const progress = pawnProgress(sq, color);
    if (progress < 3) continue;
    const sign = signed(color, perspective);
    const promo = promotionSquare(sq, color);
    const pushes = movesToPromote(sq, color);
    const ownKing = position.kingSquare(color), enemyKing = position.kingSquare(opposite(color));
    const enemyDistance = kingDistance(enemyKing, promo);
    const ownDistance = kingDistance(ownKing, sq);
    const tempo = position.turn === color ? 0 : 1;
    let race = progress >= 5 ? 26 : progress === 4 ? 14 : 7;
    if (enemyDistance > pushes + tempo) race += Math.min(34, (enemyDistance - pushes - tempo) * 9);
    else if (enemyDistance <= Math.max(1, pushes - 1)) race -= 8;
    if (ownDistance <= 2) race += 7;
    const [r, c] = rowCol(sq), dir = color === WHITE ? -1 : 1;
    const frontRow = r + dir;
    if (inBounds(frontRow, c)) {
      const blocker = position.board[frontRow * 8 + c];
      if (blocker && colorOf(blocker) !== color) race -= typeOf(blocker) === 'k' ? 20 : 11;
    }
    race += rookBehindPasser(position, sq, color);
    total += sign * race;
  }
  return total;
}

/**
 * Phase-aware strategic supplement. The proven middlegame evaluator stays
 * untouched; only simplified positions gain explicit king activity, pawn-race,
 * blockade and rook-behind-passer terms.
 */
export function strategicEvaluation(position, perspective = position.turn) {
  if (!isEndgame(position)) return 0;
  const trapBalance = trappedPiecePenalty(position, opposite(perspective)) - trappedPiecePenalty(position, perspective);
  const { total } = nonPawnMaterial(position);
  const factor = total <= 1800 ? 1 : 0.7;
  const kingActivity = (kingCentralization(position, perspective) - kingCentralization(position, opposite(perspective))) * factor;
  const races = passedPawnRaceScore(position, perspective);
  return Math.round(clamp(trapBalance + kingActivity + races, -190, 190));
}

function undevelopedHomeMinors(position, color) {
  const home = HOME[color];
  return home.minors.filter(sq => {
    const p = position.board[sq];
    return p && colorOf(p) === color && ['n', 'b'].includes(typeOf(p));
  }).length;
}

function isTactical(position, move, next) {
  return Boolean(move.flags & FLAGS.CAPTURE) || Boolean(move.promotion) || next.isInCheck(opposite(position.turn));
}

function castlingRightsRemain(position, color) {
  return [...HOME[color].rights].some(right => position.castling.includes(right));
}

/**
 * Root style discipline learned from the August game batch. It stays cheap on
 * purpose: no legal-move scans or nested mini-searches are performed here.
 * Concrete tactics remain search-authoritative, while repeated minor moves,
 * queen tourism, voluntary king exposure and directly-created piece cages pay
 * a real opportunity cost.
 */
export function strategicMoveBonus(position, move) {
  if (!move) return 0;
  const us = position.turn;
  const next = position.makeMove(move);
  const type = typeOf(move.piece);
  const tactical = isTactical(position, move, next);
  let bonus = 0;

  if (position.fullmove <= 14) {
    const undeveloped = undevelopedHomeMinors(position, us);
    const home = HOME[us];

    if (['n', 'b'].includes(type) && !home.minors.includes(move.from) && undeveloped > 0 && !tactical) {
      bonus -= 16 + undeveloped * 9;
    }

    if (type === 'q' && undeveloped > 0 && !tactical) {
      const alreadyOut = move.from !== home.queen;
      bonus -= (alreadyOut ? 22 : 10) + undeveloped * (alreadyOut ? 9 : 7);
    }

    if (type === 'r' && undeveloped >= 2 && !tactical) bonus -= 14;

    if (move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q)) {
      bonus += position.fullmove >= 5 ? 34 : 25;
      if (undeveloped <= 2) bonus += 8;
    } else if (type === 'k' && move.from === home.king && castlingRightsRemain(position, us) && !tactical) {
      bonus -= 46;
    }

    if (!tactical) {
      const trapBefore = trappedPiecePenalty(position, us);
      const trapAfter = trappedPiecePenalty(next, us);
      if (trapAfter > trapBefore) bonus -= Math.min(70, Math.round((trapAfter - trapBefore) * 0.45));
    }
  }

  if (isEndgame(position)) {
    if (type === 'k') bonus += clamp(kingCentralization(next, us) - kingCentralization(position, us), -8, 10);
    if (type === 'p' && isPassedPawn(next, move.to, us)) {
      const progress = pawnProgress(move.to, us);
      bonus += progress >= 5 ? 24 : progress === 4 ? 14 : progress >= 3 ? 7 : 0;
    }
  }

  return Math.round(clamp(bonus, -100, 70));
}

/**
 * Score a nominally quiet move by the immediate threat it creates. This makes
 * f3-style forks, pawn attacks on loose pieces and advanced passer pushes
 * available to root ordering without expanding quiescence into a second tree.
 */
export function quietThreatScore(position, move) {
  if (!move || (move.flags & FLAGS.CAPTURE) || move.promotion) return 0;
  const us = position.turn, them = opposite(us);
  const next = position.makeMove(move);
  if (next.isInCheck(them)) return 100;

  let targets = 0;
  let targetValue = 0;
  let looseHighValue = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = next.board[sq];
    if (!piece || colorOf(piece) !== them || typeOf(piece) === 'k') continue;
    if (!pieceAttacksSquare(next, move.to, sq)) continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    if (value < 100) continue;
    targets++;
    targetValue += value;
    if (value >= 300 && attackersOf(next, sq, them) === 0) looseHighValue++;
  }

  let score = 0;
  if (targets >= 2 && targetValue >= 500) score = 82 + Math.min(14, (targets - 2) * 6);
  else if (looseHighValue > 0) score = 70;
  else if (targetValue >= 500) score = 58;

  if (typeOf(move.piece) === 'p' && isPassedPawn(next, move.to, us)) {
    const progress = pawnProgress(move.to, us);
    if (progress >= 5) score = Math.max(score, 88);
    else if (progress === 4) score = Math.max(score, 68);
  }

  return score;
}

export function quietThreatMoves(position, maxMoves = 6) {
  return position.legalMoves()
    .filter(move => !(move.flags & FLAGS.CAPTURE) && !move.promotion)
    .map(move => ({ move, score: quietThreatScore(position, move) }))
    .filter(item => item.score >= 58)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxMoves)
    .map(item => item.move);
}

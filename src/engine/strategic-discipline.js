import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, opposite, rowCol, inBounds,
  KNIGHT_DELTAS, KING_DELTAS, BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

const CENTER_SQUARES = [27, 28, 35, 36];
const START = {
  w: { king: 60, queen: 59, rooks: [56, 63], knights: [57, 62], bishops: [58, 61], castle: ['K','Q'] },
  b: { king: 4, queen: 3, rooks: [0, 7], knights: [1, 6], bishops: [2, 5], castle: ['k','q'] },
};

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
function sign(color, perspective) { return color === perspective ? 1 : -1; }
function valueOf(piece) { return piece ? (PIECE_VALUES[typeOf(piece)] || 0) : 0; }

function minorStats(position, color) {
  const start = START[color];
  let surviving = 0, active = 0, home = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || !['n','b'].includes(typeOf(piece))) continue;
    surviving++;
    const onHome = [...start.knights, ...start.bishops].includes(sq);
    if (onHome) home++; else active++;
  }
  return { surviving, active, home, casualties: Math.max(0, 4 - surviving), unmobilized: Math.max(0, 4 - active) };
}

function isMinorHomeSquare(color, type, square) {
  const start = START[color];
  return (type === 'n' ? start.knights : type === 'b' ? start.bishops : []).includes(square);
}

function isForcing(position, move, next = null) {
  if (move.flags & FLAGS.CAPTURE || move.promotion) return true;
  const after = next || position.makeMove(move);
  return after.isInCheck(opposite(position.turn));
}

/**
 * Opening-only move economy. This is deliberately a root personality term,
 * not a hard opening book. Concrete tactics remain search-authoritative.
 */
export function strategicMoveBonus(position, move) {
  if (!move) return 0;
  const us = position.turn;
  const next = position.makeMove(move);
  const forcing = isForcing(position, move, next);
  let bonus = 0;

  if (position.fullmove <= 14) {
    const stats = minorStats(position, us);
    const type = typeOf(move.piece);
    const start = START[us];

    if (['n','b'].includes(type)) {
      if (isMinorHomeSquare(us, type, move.from)) {
        bonus += stats.home >= 2 ? 22 : 14;
      } else if (!forcing && stats.home >= 1) {
        bonus -= 24 + stats.home * 8;
      }
    }

    if (type === 'q' && !forcing && stats.active < 3) {
      bonus -= move.from === start.queen ? 22 : 40;
    }

    if (type === 'r' && !forcing && position.kingSquare(us) === start.king
        && start.castle.some(right => position.castling.includes(right))) {
      bonus -= 30;
    }

    if (type === 'p' && !forcing && stats.active < 3) {
      const file = move.from % 8;
      if ([0,1,6,7].includes(file)) bonus -= 18;
      if ([3,4].includes(file)) bonus += 8;
    }

    if (move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q)) bonus += 38;

    if (type === 'k' && !(move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q)) && !forcing
        && move.from === start.king && start.castle.some(right => position.castling.includes(right))) {
      bonus -= 52;
    }
  }

  return Math.round(bonus);
}

function nonPawnMaterial(position) {
  let total = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (!['p','k'].includes(type)) total += PIECE_VALUES[type] || 0;
  }
  return total;
}

export function endgameWeight(position) {
  const npm = nonPawnMaterial(position);
  let queenCount = 0;
  for (const piece of position.board) if (piece && typeOf(piece) === 'q') queenCount++;
  let weight = clamp((4200 - npm) / 2600, 0, 1);
  if (queenCount === 0) weight = Math.max(weight, 0.48);
  return weight;
}

function kingCenterValue(square) {
  if (square < 0) return 0;
  const [r,c] = rowCol(square);
  let best = 99;
  for (const sq of CENTER_SQUARES) {
    const [cr,cc] = rowCol(sq);
    best = Math.min(best, Math.max(Math.abs(r-cr), Math.abs(c-cc)));
  }
  return 4 - best;
}

function kingDistance(a, b) {
  if (a < 0 || b < 0) return 8;
  const [ar,ac] = rowCol(a), [br,bc] = rowCol(b);
  return Math.max(Math.abs(ar-br), Math.abs(ac-bc));
}

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function promotionSquare(square, color) {
  const [,file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function isPassedPawn(position, square, color) {
  const [row,file] = rowCol(square);
  const dir = color === WHITE ? -1 : 1;
  const enemyPawn = color === WHITE ? 'p' : 'P';
  for (const f of [file-1,file,file+1]) {
    if (f < 0 || f > 7) continue;
    for (let r = row + dir; r >= 0 && r < 8; r += dir) {
      if (position.board[r*8+f] === enemyPawn) return false;
    }
  }
  return true;
}

function passerEndgameScore(position, color) {
  const enemy = opposite(color);
  const ourKing = position.kingSquare(color);
  const enemyKing = position.kingSquare(enemy);
  let score = 0;

  for (let sq = 0; sq < 64; sq++) {
    const pawn = position.board[sq];
    if (!pawn || colorOf(pawn) !== color || typeOf(pawn) !== 'p' || !isPassedPawn(position, sq, color)) continue;
    const progress = clamp(pawnProgress(sq,color),0,6);
    const promo = promotionSquare(sq,color);
    const remaining = Math.max(1, 6 - progress);

    score += progress * progress * 5;
    score += clamp((kingDistance(enemyKing,promo) - remaining) * 7, -28, 42);
    score += clamp((5 - kingDistance(ourKing,sq)) * 4, -8, 20);

    const [r,c] = rowCol(sq);
    const dir = color === WHITE ? -1 : 1;
    const frontRow = r + dir;
    if (frontRow >= 0 && frontRow < 8) {
      const blocker = position.board[frontRow*8+c];
      if (blocker && colorOf(blocker) === enemy) {
        const blockValue = typeOf(blocker) === 'k' ? 40 : progress >= 5 ? 75 : 34;
        score -= blockValue;
      }
    }

    for (let rsq=0; rsq<64; rsq++) {
      const rook = position.board[rsq];
      if (!rook || typeOf(rook) !== 'r' || rsq % 8 !== c) continue;
      const [rr] = rowCol(rsq);
      if (colorOf(rook) === color) {
        const behind = color === WHITE ? rr > r : rr < r;
        if (behind) score += 28;
      } else {
        const behindEnemy = color === WHITE ? rr < r : rr > r;
        if (behindEnemy) score -= 22;
      }
    }
  }
  return score;
}

export function strategicEvaluation(position, perspective = position.turn) {
  const weight = endgameWeight(position);
  if (weight <= 0.01) return 0;
  let score = 0;
  for (const color of [WHITE,BLACK]) {
    const s = sign(color,perspective);
    const king = position.kingSquare(color);
    score += s * kingCenterValue(king) * 12 * weight;
    score += s * passerEndgameScore(position,color) * weight;
  }
  return Math.round(score);
}

/**
 * Detect quiet moves that create a real next-move tactical obligation. This
 * catches pawn forks such as f3 attacking Ne4 and Bg4, discovered double
 * attacks, and advanced passed-pawn pushes without treating every attack as a
 * quiescence move.
 */
export function quietTacticalThreatRisk(position, move) {
  if (!move || move.flags & FLAGS.CAPTURE || move.promotion) return 0;
  const us = position.turn;
  const them = opposite(us);
  const after = position.makeMove(move);
  if (after.isInCheck(them)) return 0;

  const newlyAttacked = [];
  for (let sq=0; sq<64; sq++) {
    const piece = after.board[sq];
    if (!piece || colorOf(piece) !== them || !['n','b','r','q'].includes(typeOf(piece))) continue;
    if (!after.isSquareAttacked(sq, us)) continue;
    if (position.isSquareAttacked(sq, us)) continue;
    newlyAttacked.push(valueOf(piece));
  }
  newlyAttacked.sort((a,b)=>b-a);
  if (newlyAttacked.length >= 2 && newlyAttacked[1] >= PIECE_VALUES.n) {
    return 520 + Math.min(260, Math.max(0, newlyAttacked[1] - PIECE_VALUES.n));
  }
  if (newlyAttacked[0] >= PIECE_VALUES.q) return 430;
  if (newlyAttacked[0] >= PIECE_VALUES.r) return 280;

  if (typeOf(move.piece) === 'p') {
    const progress = pawnProgress(move.to, us);
    if (progress >= 4 && isPassedPawn(after, move.to, us)) return 300 + progress * 35;
  }
  return 0;
}

export function quietTacticalCandidates(position, limit = 4) {
  const candidates = [];
  for (const move of position.legalMoves()) {
    if (move.flags & FLAGS.CAPTURE || move.promotion) continue;
    const risk = quietTacticalThreatRisk(position, move);
    if (risk >= 260) candidates.push({ move, risk });
  }
  candidates.sort((a,b)=>b.risk-a.risk);
  return candidates.slice(0,limit);
}

/** Treat the second visit to a position as a progress warning, not a draw. */
export function cycleUtility(position, staticScore) {
  const weight = endgameWeight(position);
  if (staticScore >= 120) return Math.round(staticScore - (130 + 90 * weight));
  if (staticScore >= 20) return Math.round(staticScore - (70 + 45 * weight));
  if (staticScore <= -120) return Math.round(staticScore + 65);
  if (staticScore <= -20) return Math.round(staticScore + 30);
  return Math.round(staticScore - 18);
}

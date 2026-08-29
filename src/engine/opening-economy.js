import { colorOf, typeOf, opposite } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

const HOME = Object.freeze({
  w: Object.freeze({ minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]), queen: 59, king: 60 }),
  b: Object.freeze({ minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]), queen: 3, king: 4 }),
});

function undevelopedHomeMinors(position, color) {
  return HOME[color].minors.filter(([sq, piece]) => position.board[sq] === piece).length;
}

function isMinorHomeSquare(color, square) {
  return HOME[color].minors.some(([sq]) => sq === square);
}

function isTacticalOrNecessary(position, move) {
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
  const us = position.turn;
  const them = opposite(us);
  if (position.isSquareAttacked(move.from, them)) return true;
  return position.makeMove(move).isInCheck(them);
}

function isCastle(move) {
  return Boolean(move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q));
}

/**
 * Root-only move-economy score. It does not replace objective search. Instead
 * it makes Vanta pay a tempo tax for moving the same developed piece again
 * while teammates are still parked on their home squares.
 */
export function openingMoveEconomyBonus(position, move) {
  if (!move || position.fullmove > 14) return 0;
  const us = position.turn;
  const pieceType = typeOf(move.piece);
  const undeveloped = undevelopedHomeMinors(position, us);
  const tactical = isTacticalOrNecessary(position, move);
  let bonus = 0;

  if (isCastle(move)) return 30 + undeveloped * 2;

  if (['n', 'b'].includes(pieceType)) {
    if (isMinorHomeSquare(us, move.from)) {
      bonus += 20 + Math.min(10, undeveloped * 3);
    } else if (undeveloped > 0 && !tactical) {
      bonus -= 30 + undeveloped * 9;
      const file = move.to % 8;
      const row = Math.floor(move.to / 8);
      if (pieceType === 'n' && (file === 0 || file === 7 || row === 0 || row === 7)) bonus -= 10;
    }
  }

  if (pieceType === 'q' && undeveloped > 0 && !tactical) {
    const repeatedQueenMove = move.from !== HOME[us].queen;
    bonus -= repeatedQueenMove ? 42 + undeveloped * 10 : 20 + undeveloped * 7;
  }

  if (pieceType === 'r' && undeveloped >= 2 && !tactical) bonus -= 24;

  if (pieceType === 'k' && !isCastle(move) && position.castling && !tactical) {
    bonus -= 38;
  }

  if (pieceType === 'p' && undeveloped >= 2 && !tactical) {
    const file = move.from % 8;
    if ([0, 1, 6, 7].includes(file)) bonus -= 12 + (undeveloped - 2) * 4;
    else if ([3, 4].includes(file)) bonus += 7;
  }

  return Math.round(bonus);
}

/**
 * Stronger than a cosmetic personality bonus: if a sane developing move is
 * objectively close, suppress tempo-wasting knight tours and queen shuffles.
 * Search may still override this when the repeated move is at least roughly a
 * pawn better, or when it is tactical/forced.
 */
export function applyOpeningMoveEconomyGate(position, lines) {
  if (!lines?.length || position.fullmove > 14) return { lines: lines || [], blocked: [] };
  const profiled = lines.map(line => ({ line, economy: openingMoveEconomyBonus(position, line.move) }));
  const bestScore = Math.max(...profiled.map(item => item.line.score));
  const disciplined = profiled.filter(item => item.economy >= -8 && item.line.score >= bestScore - 85);
  if (!disciplined.length) return { lines, blocked: [] };

  const bestDisciplinedScore = Math.max(...disciplined.map(item => item.line.score));
  const kept = [];
  const blocked = [];
  for (const item of profiled) {
    const wasteful = item.economy <= -28;
    const objectivelyNecessary = item.line.score >= bestDisciplinedScore + 95;
    const mating = Math.abs(item.line.score) >= 99000;
    if (wasteful && !objectivelyNecessary && !mating) blocked.push(item);
    else kept.push(item.line);
  }
  return { lines: kept.length ? kept : lines, blocked };
}

export function openingEconomyDiagnostics(position, move) {
  return {
    bonus: openingMoveEconomyBonus(position, move),
    undevelopedHomeMinors: undevelopedHomeMinors(position, position.turn),
    movedType: move ? typeOf(move.piece) : null,
    movedColor: move ? colorOf(move.piece) : null,
  };
}

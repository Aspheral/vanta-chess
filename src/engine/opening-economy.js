import { WHITE, BLACK, colorOf, typeOf, opposite, rowCol } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({
    minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]),
    queen: 59,
    king: 60,
    rights: 'KQ',
  }),
  [BLACK]: Object.freeze({
    minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]),
    queen: 3,
    king: 4,
    rights: 'kq',
  }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function homeMinorCount(position, color) {
  return HOME[color].minors.reduce((count, [sq, piece]) => count + (position.board[sq] === piece ? 1 : 0), 0);
}

function isHomeMinorSquare(color, square, piece) {
  return HOME[color].minors.some(([sq, expected]) => sq === square && expected === piece);
}

function hasCastlingRights(position, color) {
  return [...HOME[color].rights].some(right => position.castling.includes(right));
}

function knightOnRim(square) {
  const [row, file] = rowCol(square);
  return row === 0 || row === 7 || file === 0 || file === 7;
}

/**
 * Opening move economy is deliberately a root-style signal, not a replacement
 * for search. Vanta should normally spend opening tempi bringing new pieces
 * into play, not moving the same knight or queen over and over. Tactical moves,
 * escapes from attack, captures, checks and promotions remain search-authoritative.
 */
export function openingMoveEconomyReport(position, move) {
  if (!move || position.fullmove > 14) {
    return { bonus: 0, phase: 'off', homeMinors: 0, tactical: false, escapingAttack: false };
  }

  const us = position.turn;
  const enemy = opposite(us);
  const type = typeOf(move.piece);
  const home = HOME[us];
  const homeMinors = homeMinorCount(position, us);
  const next = position.makeMove(move);
  const givesCheck = next.isInCheck();
  const tactical = Boolean(move.flags & FLAGS.CAPTURE) || Boolean(move.promotion) || givesCheck;
  const escapingAttack = position.isSquareAttacked(move.from, enemy);
  const castle = Boolean(move.flags & FLAGS.CASTLE_K) || Boolean(move.flags & FLAGS.CASTLE_Q);
  let bonus = 0;
  const reasons = [];

  if (castle) {
    bonus += 42;
    reasons.push('castle');
  }

  if (['n', 'b'].includes(type)) {
    if (isHomeMinorSquare(us, move.from, move.piece)) {
      bonus += 18 + Math.min(8, homeMinors * 2);
      reasons.push('develop-new-minor');
    } else if (homeMinors > 0 && !tactical && !escapingAttack) {
      const repeatPenalty = 18 + homeMinors * 8;
      bonus -= repeatPenalty;
      reasons.push('repeat-minor-before-development');
      if (type === 'n' && knightOnRim(move.to)) {
        bonus -= 9;
        reasons.push('knight-rim-tour');
      }
      const [fromRow] = rowCol(move.from);
      const [toRow] = rowCol(move.to);
      const backTowardHome = us === WHITE ? toRow > fromRow : toRow < fromRow;
      if (backTowardHome) {
        bonus -= 6;
        reasons.push('minor-retreat-tempo');
      }
    }
  }

  if (type === 'q' && !tactical && !escapingAttack) {
    if (move.from === home.queen && homeMinors >= 2) {
      bonus -= 20 + homeMinors * 5;
      reasons.push('premature-queen-development');
    } else if (move.from !== home.queen && homeMinors > 0) {
      bonus -= 30 + homeMinors * 7;
      reasons.push('repeat-queen-before-development');
    }
  }

  if (type === 'r' && !tactical && !escapingAttack && homeMinors >= 2 && hasCastlingRights(position, us)) {
    bonus -= 20;
    reasons.push('rook-before-castling');
  }

  if (type === 'k' && !castle && !tactical && !escapingAttack && move.from === home.king && hasCastlingRights(position, us)) {
    bonus -= 34;
    reasons.push('voluntary-king-move-loses-castling');
  }

  if (type === 'p' && !tactical && homeMinors >= 2) {
    const file = move.from % 8;
    if ([0, 1, 6, 7].includes(file)) {
      bonus -= 8 + Math.min(8, homeMinors * 2);
      reasons.push('flank-pawn-before-development');
    }
  }

  // If the piece is under attack, move economy must never trap it in place.
  // Keep positive development/castling rewards, but erase non-tactical tempo
  // penalties so a necessary retreat is not punished for being inelegant.
  if (escapingAttack && bonus < 0) bonus = 0;

  return {
    bonus: Math.round(clamp(bonus, -84, 52)),
    phase: 'opening',
    homeMinors,
    tactical,
    escapingAttack,
    reasons,
  };
}

export function openingMoveEconomyBonus(position, move) {
  return openingMoveEconomyReport(position, move).bonus;
}

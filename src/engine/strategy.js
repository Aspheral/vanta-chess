import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, opposite, rowCol, inBounds,
  BISHOP_DIRS, ROOK_DIRS, KNIGHT_DELTAS, KING_DELTAS,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({
    king: 60, queen: 59, queenPiece: 'Q', rights: 'KQ', castles: Object.freeze([62, 58]),
    minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]),
  }),
  [BLACK]: Object.freeze({
    king: 4, queen: 3, queenPiece: 'q', rights: 'kq', castles: Object.freeze([6, 2]),
    minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]),
  }),
});

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }
function signed(color, perspective) { return color === perspective ? 1 : -1; }
function valueOf(piece) { return piece ? (PIECE_VALUES[typeOf(piece)] || 0) : 0; }
function kingDistance(a, b) {
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}
function centerDistance(square) {
  return Math.min(...[27, 28, 35, 36].map(center => kingDistance(square, center)));
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
  const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : [...BISHOP_DIRS, ...ROOK_DIRS];
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

function minorStats(position, color) {
  const home = HOME[color].minors;
  let surviving = 0, active = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || !['n', 'b'].includes(typeOf(piece))) continue;
    surviving++;
    if (!home.some(([homeSq, homePiece]) => homeSq === sq && homePiece === piece)) active++;
  }
  return {
    surviving,
    active,
    casualties: Math.max(0, 4 - surviving),
    unmobilized: Math.max(0, 4 - active),
  };
}

function isMinorHomeSquare(color, type, square) {
  return HOME[color].minors.some(([sq, piece]) => sq === square && typeOf(piece) === type);
}

function hasCastlingRights(position, color) {
  return [...HOME[color].rights].some(right => position.castling.includes(right));
}

function queensPresent(position) {
  return position.board.includes('Q') && position.board.includes('q');
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

export function endgamePhase(position) {
  const material = nonPawnMaterial(position);
  let phase = clamp((3600 - material.total) / 2600, 0, 1);
  if (material.queens) phase *= material.queens >= 2 ? 0.35 : 0.55;
  else phase = Math.max(phase, 0.38);
  return clamp(phase, 0, 1);
}

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function isPassedPawnAt(position, square, color) {
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

function clearPromotionPath(position, square, color) {
  const [row, file] = rowCol(square);
  const dir = color === WHITE ? -1 : 1;
  for (let r = row + dir; r >= 0 && r < 8; r += dir) {
    if (position.board[r * 8 + file]) return false;
  }
  return true;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function rookBehindPasser(position, pawnSquare, pawnColor, rookColor) {
  const [row, file] = rowCol(pawnSquare);
  // "Behind" is opposite the pawn's direction of travel.
  const step = pawnColor === WHITE ? 1 : -1;
  for (let r = row + step; r >= 0 && r < 8; r += step) {
    const piece = position.board[r * 8 + file];
    if (!piece) continue;
    return colorOf(piece) === rookColor && typeOf(piece) === 'r';
  }
  return false;
}

function oppositionScore(position, perspective) {
  const material = nonPawnMaterial(position);
  if (material.total !== 0) return 0;
  const wk = position.kingSquare(WHITE), bk = position.kingSquare(BLACK);
  if (wk < 0 || bk < 0) return 0;
  const [wr, wc] = rowCol(wk), [br, bc] = rowCol(bk);
  const direct = (wr === br && Math.abs(wc - bc) === 2) || (wc === bc && Math.abs(wr - br) === 2);
  if (!direct) return 0;
  const holder = position.turn === WHITE ? BLACK : WHITE;
  return signed(holder, perspective) * 18;
}

function passerEndgameScore(position, perspective, phase) {
  if (phase <= 0.05) return 0;
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    const pawn = position.board[sq];
    if (!pawn || typeOf(pawn) !== 'p') continue;
    const color = colorOf(pawn);
    const progress = pawnProgress(sq, color);
    if (progress < 2 || !isPassedPawnAt(position, sq, color)) continue;
    const sign = signed(color, perspective);
    const enemy = opposite(color);
    const ownKing = position.kingSquare(color);
    const enemyKing = position.kingSquare(enemy);
    const dir = color === WHITE ? -1 : 1;
    const [row, file] = rowCol(sq);
    const frontRow = row + dir;
    let score = 0;

    if (frontRow >= 0 && frontRow < 8) {
      const front = frontRow * 8 + file;
      const blocker = position.board[front];
      if (blocker) {
        if (colorOf(blocker) === enemy) score -= 18 + progress * 9;
        else score -= 12 + progress * 5;
      }
      if (ownKing >= 0) score += Math.max(-12, 18 - kingDistance(ownKing, front) * 5);
      if (enemyKing >= 0) score += Math.min(20, kingDistance(enemyKing, front) * 3 - 8);
    }

    if (rookBehindPasser(position, sq, color, color)) score += 24 + progress * 4;
    if (rookBehindPasser(position, sq, color, enemy)) score -= 20 + progress * 4;

    if (progress >= 3 && clearPromotionPath(position, sq, color) && enemyKing >= 0) {
      const promo = promotionSquare(sq, color);
      const movesToQueen = color === WHITE ? row : 7 - row;
      const catchDistance = kingDistance(enemyKing, promo);
      const tempo = position.turn === color ? 0 : 1;
      if (catchDistance > movesToQueen + tempo) score += 62 + progress * 24;
      else if (catchDistance <= Math.max(1, movesToQueen - 1)) score -= 12 + progress * 4;
    }

    total += sign * Math.round(score * phase);
  }
  return total;
}

function kingEndgameScore(position, perspective, phase) {
  if (phase <= 0.05) return 0;
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const king = position.kingSquare(color);
    if (king < 0) continue;
    const central = 3 - centerDistance(king);
    let score = central * 12;

    // In queenless endings the king is a fighting piece. Reward approaching
    // advanced enemy passers instead of preserving an opening-style pawn shell.
    const enemy = opposite(color);
    let nearestDanger = 8;
    for (let sq = 0; sq < 64; sq++) {
      const pawn = position.board[sq];
      if (!pawn || colorOf(pawn) !== enemy || typeOf(pawn) !== 'p') continue;
      if (pawnProgress(sq, enemy) < 3 || !isPassedPawnAt(position, sq, enemy)) continue;
      nearestDanger = Math.min(nearestDanger, kingDistance(king, sq));
    }
    if (nearestDanger < 8) score += Math.max(-8, 24 - nearestDanger * 6);
    total += signed(color, perspective) * Math.round(score * phase);
  }
  return total;
}

/**
 * A deliberately compact strategic layer. The main evaluator remains the
 * proven baseline; this only becomes large in queenless/low-material endings
 * where king activity, blockades and pawn races have different physics.
 */
export function strategicEvaluation(position, perspective = position.turn) {
  const phase = endgamePhase(position);
  if (phase <= 0.05) return 0;
  return Math.round(
    kingEndgameScore(position, perspective, phase)
    + passerEndgameScore(position, perspective, phase)
    + oppositionScore(position, perspective) * phase
  );
}

/**
 * Root-style discipline learned from the recent Chess.com sample. These are
 * preference-sized terms, not hard bans: concrete tactics still override them.
 */
export function strategicMoveBonus(position, move) {
  if (!move) return 0;
  const us = position.turn;
  const home = HOME[us];
  const type = typeOf(move.piece);
  const next = position.makeMove(move);
  const givesCheck = next.isInCheck();
  const capturedValue = valueOf(move.captured);
  const tactical = Boolean(move.flags & FLAGS.CAPTURE) || Boolean(move.promotion) || givesCheck;
  const castle = Boolean(move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q));
  const minors = minorStats(position, us);
  let bonus = 0;

  if (castle) {
    bonus += position.fullmove >= 6 ? 46 : 34;
    if (queensPresent(position)) bonus += 10;
  }

  if (position.fullmove <= 14) {
    if (['n', 'b'].includes(type)) {
      if (isMinorHomeSquare(us, type, move.from)) bonus += 12;
      else if (minors.unmobilized >= 2 && !tactical) bonus -= type === 'n' ? 40 : 32;

      if (type === 'n' && !tactical && minors.unmobilized >= 2) {
        const [r, c] = rowCol(move.to);
        if (r === 0 || r === 7 || c === 0 || c === 7) bonus -= 12;
      }
    }

    if (type === 'q' && minors.active < 3) {
      const queenAlreadyOut = position.board[home.queen] !== home.queenPiece;
      const pawnGrab = Boolean(move.flags & FLAGS.CAPTURE) && capturedValue <= PIECE_VALUES.p && !givesCheck;
      if (!tactical || pawnGrab) bonus -= queenAlreadyOut ? 42 : 25;
      else if (queenAlreadyOut && capturedValue <= PIECE_VALUES.p) bonus -= 12;
      if (position.fullmove <= 8 && minors.active < 2 && !givesCheck) bonus -= 10;
    }

    if (type === 'r' && minors.unmobilized >= 2 && !tactical) bonus -= 18;

    if (type === 'p' && minors.unmobilized >= 2 && !tactical && [0, 1, 6, 7].includes(move.from % 8)) {
      bonus -= 11;
    }

    if (type === 'k' && !castle && hasCastlingRights(position, us)) {
      if (move.from === home.king) bonus -= tactical ? 20 : 56;
      else if (!tactical) bonus -= 24;
    }

    // By move eight or nine, preserving legal castling while queens remain is
    // worth real practical value. This does not force castling if a tactic is on.
    if (!castle && position.fullmove >= 8 && queensPresent(position)
      && position.kingSquare(us) === home.king && hasCastlingRights(position, us) && !tactical) {
      bonus -= Math.min(24, 8 + (position.fullmove - 8) * 3);
    }
  }

  return Math.round(bonus);
}

/**
 * Score quiet moves that behave tactically: forks, newly discovered attacks,
 * or advanced passed-pawn pushes. This is used to keep them out of LMR and to
 * let quiescence see a few high-value non-captures at the horizon.
 */
export function forcingQuietThreatScore(position, move) {
  if (!move || (move.flags & FLAGS.CAPTURE) || move.promotion) return 0;
  const us = position.turn;
  const enemy = opposite(us);
  const next = position.makeMove(move);
  if (next.isInCheck()) return 150;

  const targets = [];
  for (let sq = 0; sq < 64; sq++) {
    const piece = next.board[sq];
    if (!piece || colorOf(piece) !== enemy || !['n', 'b', 'r', 'q'].includes(typeOf(piece))) continue;
    if (pieceAttacksSquare(next, move.to, sq)) targets.push(valueOf(piece));
  }
  targets.sort((a, b) => b - a);
  let score = targets.length >= 2 ? 105 + Math.min(190, Math.max(0, targets[1] - 220)) : 0;

  let newVictim = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = next.board[sq];
    if (!piece || colorOf(piece) !== enemy || !['n', 'b', 'r', 'q'].includes(typeOf(piece))) continue;
    if (!position.isSquareAttacked(sq, us) && next.isSquareAttacked(sq, us)) newVictim = Math.max(newVictim, valueOf(piece));
  }
  if (newVictim >= PIECE_VALUES.n) score = Math.max(score, 72 + Math.min(110, newVictim / 4));

  if (typeOf(move.piece) === 'p') {
    const progress = pawnProgress(move.to, us);
    if (progress >= 4 && isPassedPawnAt(next, move.to, us)) score = Math.max(score, 125 + progress * 8);
  }

  return Math.round(score);
}

export function quietThreatMoves(position, limit = 3) {
  const scored = [];
  for (const move of position.legalMoves()) {
    if ((move.flags & FLAGS.CAPTURE) || move.promotion) continue;
    const score = forcingQuietThreatScore(position, move);
    if (score >= 100) scored.push({ move, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, limit)).map(entry => entry.move);
}

export function isEndgameCriticalMove(position, move) {
  if (!move || endgamePhase(position) < 0.55) return false;
  const type = typeOf(move.piece);
  if (type === 'p') {
    if (move.promotion) return true;
    const after = position.makeMove(move);
    return pawnProgress(move.to, colorOf(move.piece)) >= 3 && isPassedPawnAt(after, move.to, colorOf(move.piece));
  }
  if (move.flags & FLAGS.CAPTURE) {
    const captured = move.captured;
    return captured && typeOf(captured) === 'p' && pawnProgress(move.to, opposite(position.turn)) >= 3;
  }
  return false;
}

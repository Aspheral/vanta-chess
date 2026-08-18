import { FLAGS } from './position.js';
import { indexToSquare, typeOf } from './constants.js';

export function moveToSAN(position, move) {
  if (move.flags & FLAGS.CASTLE_K) return suffix(position, move, 'O-O');
  if (move.flags & FLAGS.CASTLE_Q) return suffix(position, move, 'O-O-O');
  const type = typeOf(move.piece);
  const capture = Boolean(move.flags & FLAGS.CAPTURE);
  let san = '';
  if (type !== 'p') {
    san += type.toUpperCase();
    const siblings = position.legalMoves().filter(m => m !== move && m.to === move.to && typeOf(m.piece) === type && m.from !== move.from);
    if (siblings.length) {
      const sameFile = siblings.some(m => m.from % 8 === move.from % 8);
      const sameRank = siblings.some(m => Math.floor(m.from / 8) === Math.floor(move.from / 8));
      if (!sameFile) san += indexToSquare(move.from)[0];
      else if (!sameRank) san += indexToSquare(move.from)[1];
      else san += indexToSquare(move.from);
    }
  } else if (capture) san += indexToSquare(move.from)[0];
  if (capture) san += 'x';
  san += indexToSquare(move.to);
  if (move.promotion) san += `=${move.promotion.toUpperCase()}`;
  return suffix(position, move, san);
}

function suffix(position, move, san) {
  const next = position.makeMove(move);
  if (!next.isInCheck()) return san;
  return san + (next.legalMoves().length === 0 ? '#' : '+');
}

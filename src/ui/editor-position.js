import { Position } from '../chess/position.js';

export function relocateEditorPiece(position, from, to) {
  if (!position || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || from >= 64 || to < 0 || to >= 64) return position;
  const piece = position.board[from];
  if (!piece || from === to) return position;

  const board = [...position.board];
  board[from] = null;
  board[to] = piece;

  let castling = position.castling;
  const strip = chars => { for (const ch of chars) castling = castling.replace(ch, ''); };
  if (piece === 'K') strip('KQ');
  if (piece === 'k') strip('kq');
  if (from === 63 || to === 63) strip('K');
  if (from === 56 || to === 56) strip('Q');
  if (from === 7 || to === 7) strip('k');
  if (from === 0 || to === 0) strip('q');

  return new Position({
    board,
    turn: position.turn,
    castling,
    epSquare: null,
    halfmove: position.halfmove,
    fullmove: position.fullmove,
  });
}

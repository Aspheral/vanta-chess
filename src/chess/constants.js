export const WHITE = 'w';
export const BLACK = 'b';

export const PIECE_VALUES = Object.freeze({ p: 100, n: 320, b: 335, r: 500, q: 900, k: 0 });
export const FILES = 'abcdefgh';
export const RANKS = '87654321';
export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

export const KNIGHT_DELTAS = Object.freeze([
  [-2, -1], [-2, 1], [-1, -2], [-1, 2],
  [1, -2], [1, 2], [2, -1], [2, 1],
]);
export const KING_DELTAS = Object.freeze([
  [-1, -1], [-1, 0], [-1, 1], [0, -1],
  [0, 1], [1, -1], [1, 0], [1, 1],
]);
export const BISHOP_DIRS = Object.freeze([[-1, -1], [-1, 1], [1, -1], [1, 1]]);
export const ROOK_DIRS = Object.freeze([[-1, 0], [1, 0], [0, -1], [0, 1]]);
export const QUEEN_DIRS = Object.freeze([...BISHOP_DIRS, ...ROOK_DIRS]);

export function opposite(color) { return color === WHITE ? BLACK : WHITE; }
export function colorOf(piece) { return piece && piece === piece.toUpperCase() ? WHITE : BLACK; }
export function typeOf(piece) { return piece ? piece.toLowerCase() : null; }
export function squareToIndex(square) {
  if (!/^[a-h][1-8]$/.test(square)) return null;
  const file = FILES.indexOf(square[0]);
  const rankFromTop = 8 - Number(square[1]);
  return rankFromTop * 8 + file;
}
export function indexToSquare(index) {
  const row = Math.floor(index / 8);
  const col = index % 8;
  return `${FILES[col]}${8 - row}`;
}
export function rowCol(index) { return [Math.floor(index / 8), index % 8]; }
export function inBounds(row, col) { return row >= 0 && row < 8 && col >= 0 && col < 8; }
export function pieceFor(color, type) { return color === WHITE ? type.toUpperCase() : type.toLowerCase(); }

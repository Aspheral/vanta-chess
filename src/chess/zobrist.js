const MASK64 = (1n << 64n) - 1n;
let seed = 0x9e3779b97f4a7c15n;
function next64() {
  seed ^= (seed << 13n) & MASK64;
  seed ^= seed >> 7n;
  seed ^= (seed << 17n) & MASK64;
  return seed & MASK64;
}
const pieces = 'PNBRQKpnbrqk';
const pieceIndex = new Map([...pieces].map((p, i) => [p, i]));
export const ZOBRIST = {
  piece: Array.from({ length: 12 }, () => Array.from({ length: 64 }, next64)),
  turn: next64(),
  castle: Array.from({ length: 16 }, next64),
  epFile: Array.from({ length: 8 }, next64),
};
export function castleMask(castling) {
  let mask = 0;
  if (castling.includes('K')) mask |= 1;
  if (castling.includes('Q')) mask |= 2;
  if (castling.includes('k')) mask |= 4;
  if (castling.includes('q')) mask |= 8;
  return mask;
}
export function pieceKey(piece,index){ return ZOBRIST.piece[pieceIndex.get(piece)][index]; }
export function castleKey(castling){ return ZOBRIST.castle[castleMask(castling)]; }
export function epKey(square){ return square==null?0n:ZOBRIST.epFile[square%8]; }
export function turnKey(){ return ZOBRIST.turn; }
export function hashPosition(position) {
  let hash = 0n;
  for (let i = 0; i < 64; i++) {
    const p = position.board[i];
    if (p) hash ^= pieceKey(p,i);
  }
  if (position.turn === 'b') hash ^= ZOBRIST.turn;
  hash ^= castleKey(position.castling);
  hash ^= epKey(position.epSquare);
  return hash & MASK64;
}
export function normalizeHash(hash){ return hash & MASK64; }

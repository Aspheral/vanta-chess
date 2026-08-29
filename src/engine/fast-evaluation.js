import { WHITE, PIECE_VALUES, colorOf, typeOf, rowCol } from '../chess/constants.js';

const CENTER_FILE = [3.5, 2.5, 1.5, 0.5, 0.5, 1.5, 2.5, 3.5];
const CENTER_RANK = CENTER_FILE;

function sign(color) { return color === WHITE ? 1 : -1; }
function advance(row, color) { return color === WHITE ? 6 - row : row - 1; }

function phaseWeight(board) {
  let phase = 0;
  for (const p of board) {
    if (!p) continue;
    const t = typeOf(p);
    if (t === 'n' || t === 'b') phase += 1;
    else if (t === 'r') phase += 2;
    else if (t === 'q') phase += 4;
  }
  return Math.max(0, Math.min(1, phase / 24));
}

function pieceActivity(type, row, file, color, phase) {
  const center = 4 - (CENTER_FILE[file] + CENTER_RANK[row]) * 0.55;
  const progress = Math.max(0, advance(row, color));
  if (type === 'p') return progress * 7 + center * 2;
  if (type === 'n') return center * 13 - (file === 0 || file === 7 ? 18 : 0);
  if (type === 'b') return center * 7 + progress * 2;
  if (type === 'r') return progress >= 5 ? 18 : progress * 2;
  if (type === 'q') return center * (phase > 0.55 ? 2 : 5);
  if (type === 'k') {
    const edgeDistance = Math.min(row, 7 - row, file, 7 - file);
    const endgameCentral = center * 10;
    const midgameShelter = (file <= 2 || file >= 5 ? 15 : -18) - edgeDistance * 4;
    return midgameShelter * phase + endgameCentral * (1 - phase);
  }
  return 0;
}

function passedPawn(board, square, color) {
  const [row, file] = rowCol(square);
  const enemyPawn = color === WHITE ? 'p' : 'P';
  const dir = color === WHITE ? -1 : 1;
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    for (let r = row + dir; r >= 0 && r < 8; r += dir) {
      if (board[r * 8 + f] === enemyPawn) return false;
    }
  }
  return true;
}

function pawnStructure(board, pawnsByColor) {
  let score = 0;
  for (const color of ['w', 'b']) {
    const s = sign(color);
    const pawns = pawnsByColor[color];
    const files = Array(8).fill(0);
    for (const sq of pawns) files[sq & 7]++;
    for (let f = 0; f < 8; f++) if (files[f] > 1) score -= s * (files[f] - 1) * 13;
    for (const sq of pawns) {
      const [row, file] = rowCol(sq);
      const isolated = (file === 0 || files[file - 1] === 0) && (file === 7 || files[file + 1] === 0);
      if (isolated) score -= s * 9;
      if (passedPawn(board, sq, color)) {
        const p = Math.max(0, Math.min(6, advance(row, color)));
        score += s * [0, 8, 18, 34, 62, 112, 210][p];
      }
    }
  }
  return score;
}

function kingShield(board, kingSquare, color, phase) {
  if (kingSquare < 0 || phase < 0.18) return 0;
  const [row, file] = rowCol(kingSquare);
  const pawn = color === WHITE ? 'P' : 'p';
  const dir = color === WHITE ? -1 : 1;
  let shield = 0;
  for (let f = Math.max(0, file - 1); f <= Math.min(7, file + 1); f++) {
    const r1 = row + dir;
    const r2 = row + dir * 2;
    if (r1 >= 0 && r1 < 8 && board[r1 * 8 + f] === pawn) shield += 12;
    else if (r2 >= 0 && r2 < 8 && board[r2 * 8 + f] === pawn) shield += 5;
    else shield -= 8;
  }
  if (file === 6 || file === 2) shield += 15;
  return Math.round(shield * phase);
}

/**
 * Search-hot-path evaluation. It intentionally avoids attack-map construction,
 * legal move generation, and nested exchange calculations. The richer public
 * evaluator remains available for analysis/UI, while alpha-beta gets a stable,
 * material-first tapered score cheap enough to reach real depth.
 */
export function fastEvaluate(position, perspective = position.turn) {
  const board = position.board;
  const phase = phaseWeight(board);
  const pawnsByColor = { w: [], b: [] };
  const bishops = { w: 0, b: 0 };
  const kings = { w: -1, b: -1 };
  let whiteScore = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = board[sq];
    if (!piece) continue;
    const color = colorOf(piece);
    const type = typeOf(piece);
    const [row, file] = rowCol(sq);
    const s = sign(color);
    whiteScore += s * (PIECE_VALUES[type] || 0);
    whiteScore += s * pieceActivity(type, row, file, color, phase);
    if (type === 'p') pawnsByColor[color].push(sq);
    else if (type === 'b') bishops[color]++;
    else if (type === 'k') kings[color] = sq;
  }

  if (bishops.w >= 2) whiteScore += 24;
  if (bishops.b >= 2) whiteScore -= 24;
  whiteScore += pawnStructure(board, pawnsByColor);
  whiteScore += kingShield(board, kings.w, 'w', phase);
  whiteScore -= kingShield(board, kings.b, 'b', phase);

  // Small side-to-move tempo. Keep it tiny so material/tactics dominate.
  whiteScore += position.turn === WHITE ? 7 : -7;
  const rounded = Math.round(whiteScore);
  return perspective === WHITE ? rounded : -rounded;
}

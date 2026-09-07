import { WHITE, PIECE_VALUES, colorOf, typeOf, rowCol } from '../chess/constants.js';

const CENTER_FILE = [3.5, 2.5, 1.5, 0.5, 0.5, 1.5, 2.5, 3.5];
const CENTER_RANK = CENTER_FILE;
const HOME = Object.freeze({
  w: { knights: [57, 62], bishops: [58, 61], queen: 59, king: 60, castles: [58, 62] },
  b: { knights: [1, 6], bishops: [2, 5], queen: 3, king: 4, castles: [2, 6] },
});
const KING_RAYS = Object.freeze([
  [-1, -1, true], [-1, 0, false], [-1, 1, true],
  [0, -1, false],                  [0, 1, false],
  [1, -1, true],  [1, 0, false],   [1, 1, true],
]);

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

function kingPressure(board, kingSquare, color, phase, pawnsByColor, piecesByColor) {
  if (kingSquare < 0 || phase < 0.22) return 0;
  const enemy = color === 'w' ? 'b' : 'w';
  const [kingRow, kingFile] = rowCol(kingSquare);
  let danger = 0;

  // Cheap latent slider pressure. A rook, bishop or queen aimed through one
  // friendly blocker still matters because that blocker can be pinned,
  // exchanged, or deflected just beyond the current search horizon.
  for (const [dr, dc, diagonal] of KING_RAYS) {
    let row = kingRow + dr;
    let file = kingFile + dc;
    let distance = 1;
    let blocker = 0;
    while (row >= 0 && row < 8 && file >= 0 && file < 8 && distance <= 6) {
      const piece = board[row * 8 + file];
      if (!piece) {
        row += dr; file += dc; distance++;
        continue;
      }
      const pieceColor = colorOf(piece);
      const type = typeOf(piece);
      if (pieceColor === color) {
        if (blocker === 0) {
          blocker = 1;
          row += dr; file += dc; distance++;
          continue;
        }
        break;
      }
      if (pieceColor === enemy) {
        const slider = type === 'q' || (diagonal ? type === 'b' : type === 'r');
        if (slider) {
          let pressure = type === 'q' ? 22 : 15;
          if (blocker) pressure = Math.round(pressure * 0.45);
          pressure -= Math.max(0, distance - 2) * 2;
          danger += Math.max(3, pressure);
        }
      }
      break;
    }
  }

  // Count enemy pawn attacks that land in the king's immediate ring.
  const enemyPawnDir = enemy === 'w' ? -1 : 1;
  for (const square of pawnsByColor[enemy]) {
    const [row, file] = rowCol(square);
    if (Math.abs(row - kingRow) > 3 || Math.abs(file - kingFile) > 2) continue;
    const attackRow = row + enemyPawnDir;
    if (Math.abs(attackRow - kingRow) <= 1 &&
        (Math.abs(file - 1 - kingFile) <= 1 || Math.abs(file + 1 - kingFile) <= 1)) danger += 6;
  }

  // Knights near a king can create forks and quiet mating threats one ply
  // beyond a capture-only horizon. Geometry is cheaper here than attack maps.
  for (const square of piecesByColor[enemy].knights) {
    const [row, file] = rowCol(square);
    const dr = Math.abs(row - kingRow);
    const df = Math.abs(file - kingFile);
    if ((dr === 1 && df <= 3) || (dr === 2 && df <= 2) || (dr === 3 && df === 1)) danger += 5;
  }

  return Math.round(danger * phase);
}

function openingDiscipline(position, piecesByColor, kings, phase) {
  if (position.fullmove > 16 || phase < 0.45) return 0;
  let score = 0;

  for (const color of ['w', 'b']) {
    const home = HOME[color];
    const pieces = piecesByColor[color];
    const s = sign(color);
    let developed = 0;

    for (const sq of pieces.knights) if (!home.knights.includes(sq)) developed++;
    for (const sq of pieces.bishops) if (!home.bishops.includes(sq)) developed++;

    let local = developed * 8;
    const queenPiece = color === 'w' ? 'Q' : 'q';
    if (position.board[home.queen] !== queenPiece && developed < 2 && position.fullmove <= 10) {
      local -= (2 - developed) * 14;
    }

    const kingSq = kings[color];
    if (home.castles.includes(kingSq)) {
      local += 24;
    } else if (position.fullmove >= 8) {
      const rights = color === 'w' ? /[KQ]/ : /[kq]/;
      const canCastle = rights.test(position.castling || '');
      if (kingSq !== home.king) local -= 18;
      else if (!canCastle) local -= 22;
      else if (position.fullmove >= 11 && developed >= 2) local -= 7;
    }

    score += s * Math.round(local * phase);
  }
  return score;
}

function rookFileActivity(pawnsByColor, rooksByColor) {
  const files = { w: Array(8).fill(0), b: Array(8).fill(0) };
  for (const color of ['w', 'b']) for (const sq of pawnsByColor[color]) files[color][sq & 7]++;
  let score = 0;
  for (const color of ['w', 'b']) {
    const enemy = color === 'w' ? 'b' : 'w';
    let local = 0;
    for (const sq of rooksByColor[color]) {
      const file = sq & 7;
      if (files[color][file] === 0) local += files[enemy][file] === 0 ? 13 : 7;
    }
    score += sign(color) * local;
  }
  return score;
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
  const piecesByColor = {
    w: { knights: [], bishops: [] },
    b: { knights: [], bishops: [] },
  };
  const rooksByColor = { w: [], b: [] };
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
    else if (type === 'n') piecesByColor[color].knights.push(sq);
    else if (type === 'b') {
      bishops[color]++;
      piecesByColor[color].bishops.push(sq);
    } else if (type === 'r') rooksByColor[color].push(sq);
    else if (type === 'k') kings[color] = sq;
  }

  if (bishops.w >= 2) whiteScore += 24;
  if (bishops.b >= 2) whiteScore -= 24;
  whiteScore += pawnStructure(board, pawnsByColor);
  whiteScore += kingShield(board, kings.w, 'w', phase);
  whiteScore -= kingShield(board, kings.b, 'b', phase);
  whiteScore += kingPressure(board, kings.b, 'b', phase, pawnsByColor, piecesByColor);
  whiteScore -= kingPressure(board, kings.w, 'w', phase, pawnsByColor, piecesByColor);
  whiteScore += openingDiscipline(position, piecesByColor, kings, phase);
  whiteScore += rookFileActivity(pawnsByColor, rooksByColor);

  // Small side-to-move tempo. Keep it tiny so material/tactics dominate.
  whiteScore += position.turn === WHITE ? 7 : -7;
  const rounded = Math.round(whiteScore);
  return perspective === WHITE ? rounded : -rounded;
}

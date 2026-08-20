import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, BISHOP_DIRS,
  ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, KING_DELTAS, inBounds,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { VANTA_PERSONALITY } from './personality.js';

const CENTER = new Set([27, 28, 35, 36]);
const EXTENDED_CENTER = new Set([18,19,20,21,26,27,28,29,34,35,36,37,42,43,44,45]);
const MATE_SCORE = 100000;
const PASSER_BONUS = [10, 16, 27, 48, 92, 185, 320];

export { MATE_SCORE };

function signed(color, perspective) { return color === perspective ? 1 : -1; }

function materialScore(position, perspective) {
  let score = 0;
  // Personality must never discount objective material before calculation.
  for (const p of position.board) {
    if (p) score += signed(colorOf(p), perspective) * PIECE_VALUES[typeOf(p)];
  }
  return score;
}

function pieceSquareActivity(position, perspective) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = position.board[i];
    if (!p) continue;
    const color = colorOf(p), type = typeOf(p), s = signed(color, perspective);
    const [r, c] = rowCol(i);
    const homeDistance = color === WHITE ? 7 - r : r;
    if (type === 'n') {
      if (CENTER.has(i)) score += s * 25;
      else if (EXTENDED_CENTER.has(i)) score += s * 13;
      score += s * Math.min(15, homeDistance * 4);
    } else if (type === 'b') score += s * Math.min(15, homeDistance * 3.5);
    else if (type === 'r') {
      const targetRank = color === WHITE ? 1 : 6;
      if (r === targetRank) score += s * 22;
    } else if (type === 'q') {
      if (position.fullmove <= 10 && homeDistance > 1) score -= s * Math.min(22, (homeDistance - 1) * 7);
    } else if (type === 'p') {
      score += s * homeDistance * 4;
      if ([3, 4].includes(c)) score += s * 6;
    }
  }
  return score;
}

function mobilityScore(position, perspective) {
  const count = color => {
    let mobility = 0;
    for (let i = 0; i < 64; i++) {
      const p = position.board[i];
      if (!p || colorOf(p) !== color) continue;
      const type = typeOf(p), [r, c] = rowCol(i);
      if (type === 'p') {
        const dir = color === WHITE ? -1 : 1;
        for (const dc of [-1, 1]) {
          const rr = r + dir, cc = c + dc;
          if (inBounds(rr, cc)) {
            const t = position.board[rr * 8 + cc];
            if (t && colorOf(t) !== color) mobility += 2;
          }
        }
        const rr = r + dir;
        if (inBounds(rr, c) && !position.board[rr * 8 + c]) mobility += 1;
      } else if (type === 'n' || type === 'k') {
        const deltas = type === 'n' ? KNIGHT_DELTAS : KING_DELTAS;
        for (const [dr, dc] of deltas) {
          const rr = r + dr, cc = c + dc;
          if (inBounds(rr, cc)) {
            const t = position.board[rr * 8 + cc];
            if (!t || colorOf(t) !== color) mobility++;
          }
        }
      } else {
        const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (inBounds(rr, cc)) {
            const t = position.board[rr * 8 + cc];
            if (!t) mobility++;
            else { if (colorOf(t) !== color) mobility += 2; break; }
            rr += dr; cc += dc;
          }
        }
      }
    }
    return mobility;
  };
  return (count(perspective) - count(opposite(perspective))) * 1.45;
}

function buildAttackData(position, color) {
  const counts = new Uint8Array(64);
  const weights = new Uint16Array(64);
  const add = (sq, weight) => {
    counts[sq] = Math.min(255, counts[sq] + 1);
    weights[sq] = Math.min(65535, weights[sq] + weight);
  };
  for (let from = 0; from < 64; from++) {
    const piece = position.board[from];
    if (!piece || colorOf(piece) !== color) continue;
    const type = typeOf(piece);
    const [r, c] = rowCol(from);
    const weight = type === 'q' ? 9 : type === 'r' ? 5 : ['b','n'].includes(type) ? 3 : 1;
    if (type === 'p') {
      const dr = color === WHITE ? -1 : 1;
      for (const dc of [-1, 1]) {
        const rr = r + dr, cc = c + dc;
        if (inBounds(rr, cc)) add(rr * 8 + cc, weight);
      }
    } else if (type === 'n' || type === 'k') {
      const deltas = type === 'n' ? KNIGHT_DELTAS : KING_DELTAS;
      for (const [dr, dc] of deltas) {
        const rr = r + dr, cc = c + dc;
        if (inBounds(rr, cc)) add(rr * 8 + cc, weight);
      }
    } else {
      const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inBounds(rr, cc)) {
          const sq = rr * 8 + cc;
          add(sq, weight);
          if (position.board[sq]) break;
          rr += dr; cc += dc;
        }
      }
    }
  }
  return { counts, weights };
}

function buildAttackPair(position) {
  return { [WHITE]: buildAttackData(position, WHITE), [BLACK]: buildAttackData(position, BLACK) };
}

function pawnStructure(position, perspective, attacks) {
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const sign = signed(color, perspective);
    const pawns = [];
    for (let i = 0; i < 64; i++) if (position.board[i] === (color === WHITE ? 'P' : 'p')) pawns.push(i);
    const fileCounts = Array(8).fill(0);
    for (const sq of pawns) fileCounts[sq % 8]++;
    for (const count of fileCounts) if (count > 1) total -= sign * (count - 1) * 13;

    for (const sq of pawns) {
      const [r, c] = rowCol(sq);
      const isolated = (c === 0 || fileCounts[c - 1] === 0) && (c === 7 || fileCounts[c + 1] === 0);
      if (isolated) total -= sign * 9;
      const dir = color === WHITE ? -1 : 1;
      let passed = true;
      for (const f of [c - 1, c, c + 1]) {
        if (f < 0 || f > 7) continue;
        for (let rr = r + dir; rr >= 0 && rr < 8; rr += dir) {
          if (position.board[rr * 8 + f] === (color === WHITE ? 'p' : 'P')) { passed = false; break; }
        }
      }
      if (!passed) continue;

      const progress = Math.max(0, Math.min(6, color === WHITE ? 6 - r : r - 1));
      let bonus = PASSER_BONUS[progress];
      const enemy = opposite(color);
      const frontRow = r + dir;
      if (frontRow >= 0 && frontRow < 8) {
        const front = frontRow * 8 + c;
        const blocker = position.board[front];
        if (blocker && colorOf(blocker) === enemy) {
          bonus *= attacks[color].counts[front] > attacks[enemy].counts[front] ? 0.82 : 0.58;
        }
      }
      if (attacks[color].counts[sq] > 0) bonus *= 1.16;
      if (progress >= 5) {
        const promoSq = (color === WHITE ? c : 56 + c);
        if (!position.board[promoSq] && attacks[color].counts[promoSq] >= attacks[enemy].counts[promoSq]) bonus += 70;
      }
      total += sign * Math.round(bonus);
    }
  }
  return total;
}

function homeInfo(color) {
  return color === WHITE
    ? { knights: [[57, 'N'], [62, 'N']], bishops: [[58, 'B'], [61, 'B']], queen: [59, 'Q'], king: [60, 'K'], castles: [62, 58], rights: 'KQ' }
    : { knights: [[1, 'n'], [6, 'n']], bishops: [[2, 'b'], [5, 'b']], queen: [3, 'q'], king: [4, 'k'], castles: [6, 2], rights: 'kq' };
}

function undevelopedMinorCount(position, color) {
  const homes = homeInfo(color);
  let count = 0;
  for (const [sq, piece] of [...homes.knights, ...homes.bishops]) if (position.board[sq] === piece) count++;
  return count;
}

function developmentScore(position, perspective) {
  if (position.fullmove > 16) return 0;
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const sign = signed(color, perspective);
    const homes = homeInfo(color);
    const undeveloped = undevelopedMinorCount(position, color);
    const developed = 4 - undeveloped;
    let score = developed * 18;
    const kingSq = position.kingSquare(color);
    const castled = homes.castles.includes(kingSq);
    if (castled) score += 36;
    else {
      const hasRights = [...homes.rights].some(right => position.castling.includes(right));
      if (hasRights) score += 9;
      else if (kingSq === homes.king[0]) score -= 28;
      if (kingSq === homes.king[0] && position.fullmove >= 6 && undeveloped >= 2) {
        score -= Math.min(34, (position.fullmove - 5) * 5 + undeveloped * 4);
      }
    }
    if (position.board[homes.queen[0]] !== homes.queen[1] && undeveloped >= 2 && position.fullmove <= 10) score -= undeveloped * 13;
    total += sign * score;
  }
  return total;
}

function rookAndBishopStructure(position, perspective) {
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const sign = signed(color, perspective);
    const bishop = color === WHITE ? 'B' : 'b';
    const rook = color === WHITE ? 'R' : 'r';
    const pawn = color === WHITE ? 'P' : 'p';
    const enemyPawn = color === WHITE ? 'p' : 'P';
    let bishops = 0;
    for (const p of position.board) if (p === bishop) bishops++;
    if (bishops >= 2) total += sign * 24;
    for (let sq = 0; sq < 64; sq++) {
      if (position.board[sq] !== rook) continue;
      const file = sq % 8;
      let ownPawn = false, opposingPawn = false;
      for (let row = 0; row < 8; row++) {
        const p = position.board[row * 8 + file];
        if (p === pawn) ownPawn = true;
        else if (p === enemyPawn) opposingPawn = true;
      }
      if (!ownPawn && !opposingPawn) total += sign * 14;
      else if (!ownPawn) total += sign * 8;
    }
  }
  return total;
}

function loosePieceScore(position, perspective, attacks) {
  let total = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || typeOf(piece) === 'k') continue;
    const color = colorOf(piece), enemy = opposite(color);
    if (!attacks[enemy].counts[sq]) continue;
    const defended = Boolean(attacks[color].counts[sq]);
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    let exposure;
    if (!defended) exposure = Math.min(260, Math.max(16, Math.round(value * 0.28)));
    else exposure = typeOf(piece) === 'q' ? 22 : typeOf(piece) === 'r' ? 15 : 9;
    total -= signed(color, perspective) * exposure;
  }
  return total;
}

function rayPressure(position, kingSq, attackerColor) {
  let pressure = 0;
  const [kr, kc] = rowCol(kingSq);
  const scan = (dirs, sliders, base) => {
    for (const [dr, dc] of dirs) {
      let rr = kr + dr, cc = kc + dc, distance = 1;
      while (inBounds(rr, cc)) {
        const p = position.board[rr * 8 + cc];
        if (p) {
          if (colorOf(p) === attackerColor && sliders.includes(typeOf(p))) pressure += Math.max(4, base - distance * 3);
          break;
        }
        rr += dr; cc += dc; distance++;
      }
    }
  };
  scan(BISHOP_DIRS, ['b', 'q'], 23);
  scan(ROOK_DIRS, ['r', 'q'], 27);
  return pressure;
}

function kingSafetyFor(position, color, attacks) {
  const kingSq = position.kingSquare(color);
  if (kingSq < 0) return -MATE_SCORE;
  const enemy = opposite(color);
  const [r, c] = rowCol(kingSq);
  const forward = color === WHITE ? -1 : 1;
  let shield = 0;
  for (const dc of [-1, 0, 1]) {
    const rr = r + forward, cc = c + dc;
    if (inBounds(rr, cc) && position.board[rr * 8 + cc] === (color === WHITE ? 'P' : 'p')) shield++;
  }

  const adjacent = [];
  for (const [dr, dc] of KING_DELTAS) {
    const rr = r + dr, cc = c + dc;
    if (inBounds(rr, cc)) adjacent.push(rr * 8 + cc);
  }
  let attackedEscapes = 0, safeEscapes = 0;
  for (const sq of adjacent) {
    const occupant = position.board[sq];
    if (occupant && colorOf(occupant) === color) continue;
    if (attacks[enemy].counts[sq]) attackedEscapes++; else safeEscapes++;
  }

  let nearbyAttackers = 0, nearbyDefenders = 0;
  for (let i = 0; i < 64; i++) {
    const p = position.board[i]; if (!p) continue;
    const [pr, pc] = rowCol(i);
    const dist = Math.max(Math.abs(pr - r), Math.abs(pc - c));
    if (dist <= 3 && typeOf(p) !== 'k') {
      if (colorOf(p) === enemy) nearbyAttackers += typeOf(p) === 'q' ? 3 : typeOf(p) === 'r' ? 2 : 1;
      else nearbyDefenders += typeOf(p) === 'q' ? 2 : 1;
    }
  }

  let openKingFiles = 0;
  for (const file of [c - 1, c, c + 1]) {
    if (file < 0 || file > 7) continue;
    let ownPawn = false;
    for (let rr = 0; rr < 8; rr++) {
      if (position.board[rr * 8 + file] === (color === WHITE ? 'P' : 'p')) { ownPawn = true; break; }
    }
    if (!ownPawn) openKingFiles++;
  }

  const ray = rayPressure(position, kingSq, enemy);
  let danger = (3 - shield) * 13 + attackedEscapes * 9 + ray + nearbyAttackers * 7 + openKingFiles * 9 - nearbyDefenders * 2;
  if (attacks[enemy].counts[kingSq]) danger += 42;

  const homes = homeInfo(color);
  const castled = homes.castles.includes(kingSq);
  if (!castled && kingSq === homes.king[0] && position.fullmove >= 7) {
    const rights = [...homes.rights].some(right => position.castling.includes(right));
    danger += rights ? 8 : 24;
  }

  if (danger > 36) danger += Math.min(190, Math.round(((danger - 36) * (danger - 36)) / 24));
  danger = Math.min(330, danger);
  return shield * 11 + safeEscapes * 5 - danger;
}

function squareName(index) {
  const files = 'abcdefgh';
  const row = Math.floor(index / 8), col = index % 8;
  return `${files[col]}${8 - row}`;
}

function openingKingDiscipline(position, color) {
  if (position.fullmove > 14) return 0;
  const kingSq = position.kingSquare(color);
  const homeKing = color === WHITE ? 60 : 4;
  if (kingSq !== homeKing) return 0;
  const homeRow = color === WHITE ? 6 : 1;
  const pawn = color === WHITE ? 'P' : 'p';
  let score = 0;
  for (const file of [5, 6, 7]) {
    let pawnSq = -1;
    for (let row = 0; row < 8; row++) {
      const sq = row * 8 + file;
      if (position.board[sq] === pawn) { pawnSq = sq; break; }
    }
    if (pawnSq < 0) { score -= 15; continue; }
    const [row] = rowCol(pawnSq);
    const advance = color === WHITE ? homeRow - row : row - homeRow;
    if (advance <= 0) score += 4;
    else score -= advance === 1 ? 9 : 24 + (advance - 2) * 8;
  }
  const right = color === WHITE ? 'K' : 'k';
  if (position.castling.includes(right)) {
    score += 8;
    const fSq = color === WHITE ? 61 : 5;
    const gSq = color === WHITE ? 62 : 6;
    if (!position.board[fSq]) score += 5;
    if (!position.board[gSq]) score += 7;
  }
  return score;
}

function attackPotential(position, color, attacks) {
  const enemy = opposite(color);
  const kingSq = position.kingSquare(enemy);
  if (kingSq < 0) return MATE_SCORE;
  const [kr, kc] = rowCol(kingSq);
  const zone = [kingSq];
  for (const [dr, dc] of KING_DELTAS) {
    const rr = kr + dr, cc = kc + dc;
    if (inBounds(rr, cc)) zone.push(rr * 8 + cc);
  }
  let weightedHits = 0, hitCount = 0;
  for (const sq of zone) {
    weightedHits += attacks[color].weights[sq];
    hitCount += attacks[color].counts[sq];
  }
  let score = weightedHits * 1.35;
  if (hitCount >= 2) score += Math.min(44, hitCount * 5.5);
  score += rayPressure(position, kingSq, color) * 1.28;
  return score;
}

function tempoAndInitiative(position, perspective, attacks) {
  const us = perspective, them = opposite(us);
  let score = position.turn === us ? 7 : -7;
  const usKing = position.kingSquare(us), themKing = position.kingSquare(them);
  if (themKing >= 0 && attacks[us].counts[themKing]) score += 32;
  if (usKing >= 0 && attacks[them].counts[usKing]) score -= 40;
  return score;
}

export function evaluateBreakdown(position, perspective = position.turn) {
  const attacks = buildAttackPair(position);
  const material = materialScore(position, perspective);
  const activity = pieceSquareActivity(position, perspective);
  const mobility = mobilityScore(position, perspective);
  const pawns = pawnStructure(position, perspective, attacks);
  const development = developmentScore(position, perspective);
  const structure = rookAndBishopStructure(position, perspective);
  const loose = loosePieceScore(position, perspective, attacks);
  const ownKing = kingSafetyFor(position, perspective, attacks);
  const enemyKing = kingSafetyFor(position, opposite(perspective), attacks);
  const kingSafety = (ownKing - enemyKing) * 1.55;
  const kingDiscipline = (openingKingDiscipline(position, perspective) - openingKingDiscipline(position, opposite(perspective))) * 1.35;
  const attack = (attackPotential(position, perspective, attacks) - attackPotential(position, opposite(perspective), attacks)) * 1.08;
  const initiative = tempoAndInitiative(position, perspective, attacks);
  const total = material + activity + mobility + pawns + development + structure + loose + kingSafety + kingDiscipline + attack + initiative;
  return { material, activity, mobility, pawns, development, structure, loose, kingSafety, kingDiscipline, attack, initiative, total: Math.round(total) };
}

export function evaluate(position, perspective = position.turn) {
  return evaluateBreakdown(position, perspective).total;
}

function isMinorHomeSquare(color, type, square) {
  const homes = homeInfo(color);
  const set = type === 'n' ? homes.knights : type === 'b' ? homes.bishops : [];
  return set.some(([sq]) => sq === square);
}

export function personalityMoveBonus(position, move) {
  const us = position.turn, them = opposite(us);
  const next = position.makeMove(move);
  const beforeAttacks = buildAttackPair(position), afterAttacks = buildAttackPair(next);
  let bonus = 0;
  const beforeMaterial = materialBalance(position, us), afterMaterial = materialBalance(next, us);
  const movedValue = PIECE_VALUES[typeOf(move.piece)] || 0;
  const capturedValue = move.captured ? (PIECE_VALUES[typeOf(move.captured)] || 0) : 0;
  const hangingRisk = afterAttacks[them].counts[move.to] ? Math.max(0, movedValue - capturedValue) : 0;
  const sacrifice = Math.max(0, beforeMaterial - afterMaterial, hangingRisk);
  const givesCheck = next.isInCheck(them);

  if (givesCheck) bonus += 45;
  if (move.flags & FLAGS.CAPTURE) bonus += 8;
  if (move.promotion) bonus += 40;

  const beforeAttack = attackPotential(position, us, beforeAttacks);
  const afterAttack = attackPotential(next, us, afterAttacks);
  bonus += Math.max(-18, Math.min(36, (afterAttack - beforeAttack) * 0.72));
  const enemyKingBefore = kingSafetyFor(position, them, beforeAttacks);
  const enemyKingAfter = kingSafetyFor(next, them, afterAttacks);
  bonus += Math.max(-12, Math.min(42, (enemyKingBefore - enemyKingAfter) * 0.48));
  const ownKingBefore = kingSafetyFor(position, us, beforeAttacks);
  const ownKingAfter = kingSafetyFor(next, us, afterAttacks);
  if (ownKingAfter < ownKingBefore) bonus -= Math.min(105, (ownKingBefore - ownKingAfter) * 1.45);

  const disciplineLoss = openingKingDiscipline(position, us) - openingKingDiscipline(next, us);
  if (disciplineLoss > 0) bonus -= Math.min(60, disciplineLoss * 1.4);

  if (position.fullmove <= 10) {
    const type = typeOf(move.piece);
    const undeveloped = undevelopedMinorCount(position, us);
    const tactical = givesCheck || Boolean(move.flags & FLAGS.CAPTURE);
    if (['n', 'b'].includes(type)) {
      if (isMinorHomeSquare(us, type, move.from) && move.to !== move.from) bonus += 13;
      else if (undeveloped >= 2 && !tactical) bonus -= 24 + Math.min(10, (undeveloped - 2) * 5);
    }
    if (type === 'p' && [0,1,6,7].includes(move.from % 8) && undeveloped >= 2 && !tactical) bonus -= 13;
  }

  if (sacrifice > 0) {
    const compensation = Math.max(0, afterAttack - beforeAttack)
      + (givesCheck ? 38 : 0)
      + Math.max(0, enemyKingBefore - enemyKingAfter) * 0.42;
    const unsupported = Math.max(0, sacrifice - compensation * 2.6);
    bonus += Math.min(48, compensation * 0.58) - unsupported * 0.38;
  }

  return Math.round(bonus);
}

export function materialBalance(position, perspective) {
  let score = 0;
  for (const p of position.board) if (p) score += signed(colorOf(p), perspective) * PIECE_VALUES[typeOf(p)];
  return score;
}

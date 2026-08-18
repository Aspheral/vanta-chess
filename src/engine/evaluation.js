import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, BISHOP_DIRS,
  ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, KING_DELTAS, inBounds,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { VANTA_PERSONALITY } from './personality.js';

const CENTER = new Set([27, 28, 35, 36]);
const EXTENDED_CENTER = new Set([18,19,20,21,26,27,28,29,34,35,36,37,42,43,44,45]);
const MATE_SCORE = 100000;

export { MATE_SCORE };

function signed(color, perspective) { return color === perspective ? 1 : -1; }

function materialScore(position, perspective) {
  let score = 0;
  const materialScale = 0.78 + VANTA_PERSONALITY.materialGreed / 500;
  for (const p of position.board) if (p) score += signed(colorOf(p), perspective) * PIECE_VALUES[typeOf(p)] * materialScale;
  return score;
}

function pieceSquareActivity(position, perspective) {
  let score = 0;
  for (let i = 0; i < 64; i++) {
    const p = position.board[i]; if (!p) continue;
    const color = colorOf(p), type = typeOf(p), s = signed(color, perspective);
    const [r, c] = rowCol(i);
    const homeDistance = color === WHITE ? 7 - r : r;
    if (type === 'n') {
      if (CENTER.has(i)) score += s * 28;
      else if (EXTENDED_CENTER.has(i)) score += s * 14;
      score += s * Math.min(18, homeDistance * 5);
    } else if (type === 'b') {
      score += s * Math.min(18, homeDistance * 4);
    } else if (type === 'r') {
      const targetRank = color === WHITE ? 1 : 6;
      if (r === targetRank) score += s * 24;
    } else if (type === 'q') {
      if (homeDistance > 2) score += s * 4;
    } else if (type === 'p') {
      score += s * homeDistance * 5;
      if ([3,4].includes(c)) score += s * 5;
    }
  }
  return score;
}

function mobilityScore(position, perspective) {
  const count = color => {
    let mobility = 0;
    for (let i=0;i<64;i++) {
      const p=position.board[i];
      if(!p || colorOf(p)!==color) continue;
      const type=typeOf(p), [r,c]=rowCol(i);
      if(type==='p') {
        const dir=color===WHITE?-1:1;
        for(const dc of [-1,1]) {
          const rr=r+dir,cc=c+dc;
          if(inBounds(rr,cc)) { const t=position.board[rr*8+cc]; if(t&&colorOf(t)!==color) mobility+=2; }
        }
        const rr=r+dir; if(inBounds(rr,c)&&!position.board[rr*8+c]) mobility+=1;
      } else if(type==='n'||type==='k') {
        const deltas=type==='n'?KNIGHT_DELTAS:KING_DELTAS;
        for(const [dr,dc] of deltas){const rr=r+dr,cc=c+dc;if(inBounds(rr,cc)){const t=position.board[rr*8+cc];if(!t||colorOf(t)!==color)mobility++;}}
      } else {
        const dirs=type==='b'?BISHOP_DIRS:type==='r'?ROOK_DIRS:QUEEN_DIRS;
        for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc;while(inBounds(rr,cc)){const t=position.board[rr*8+cc];if(!t)mobility++;else{if(colorOf(t)!==color)mobility+=2;break;}rr+=dr;cc+=dc;}}
      }
    }
    return mobility;
  };
  return (count(perspective)-count(opposite(perspective))) * 1.65;
}

function pawnStructure(position, perspective) {
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
      if (isolated) total -= sign * 10;
      const dir = color === WHITE ? -1 : 1;
      let passed = true;
      for (const f of [c - 1, c, c + 1]) {
        if (f < 0 || f > 7) continue;
        for (let rr = r + dir; rr >= 0 && rr < 8; rr += dir) {
          const enemyPawn = position.board[rr * 8 + f];
          if (enemyPawn === (color === WHITE ? 'p' : 'P')) { passed = false; break; }
        }
      }
      if (passed) {
        const progress = color === WHITE ? 6 - r : r - 1;
        total += sign * (18 + Math.max(0, progress) * 12);
      }
    }
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
  scan(BISHOP_DIRS, ['b','q'], 22);
  scan(ROOK_DIRS, ['r','q'], 25);
  return pressure;
}

function kingSafetyFor(position, color) {
  const kingSq = position.kingSquare(color);
  if (kingSq < 0) return -MATE_SCORE;
  const enemy = opposite(color);
  const [r, c] = rowCol(kingSq);
  let safety = 0;
  const forward = color === WHITE ? -1 : 1;
  let shield = 0;
  for (const dc of [-1,0,1]) {
    const rr = r + forward, cc = c + dc;
    if (inBounds(rr,cc) && position.board[rr*8+cc] === (color === WHITE ? 'P':'p')) shield++;
  }
  safety += shield * 18;
  if ((color === WHITE && ['g1','c1'].includes(squareName(kingSq))) || (color === BLACK && ['g8','c8'].includes(squareName(kingSq)))) safety += 16;
  const adjacent = [];
  for (const [dr,dc] of KING_DELTAS) {
    const rr=r+dr,cc=c+dc;
    if (inBounds(rr,cc)) adjacent.push(rr*8+cc);
  }
  let attackedEscapes = 0, safeEscapes = 0;
  for (const sq of adjacent) {
    const occupant = position.board[sq];
    if (occupant && colorOf(occupant) === color) continue;
    if (position.isSquareAttacked(sq, enemy)) attackedEscapes++;
    else safeEscapes++;
  }
  safety += safeEscapes * 5 - attackedEscapes * 10;
  safety -= rayPressure(position, kingSq, enemy);
  let nearbyAttackers = 0, nearbyDefenders = 0;
  for (let i=0;i<64;i++) {
    const p=position.board[i]; if(!p) continue;
    const [pr,pc]=rowCol(i); const dist=Math.max(Math.abs(pr-r),Math.abs(pc-c));
    if(dist<=3 && typeOf(p)!=='k') {
      if(colorOf(p)===enemy) nearbyAttackers += typeOf(p)==='q'?3:typeOf(p)==='r'?2:1;
      else nearbyDefenders += typeOf(p)==='q'?2:1;
    }
  }
  safety += nearbyDefenders*3 - nearbyAttackers*7;
  if (position.isSquareAttacked(kingSq, enemy)) safety -= 45;
  return safety;
}

function squareName(index) {
  const files='abcdefgh'; const row=Math.floor(index/8), col=index%8;
  return `${files[col]}${8-row}`;
}

function openingKingDiscipline(position, color) {
  if (position.fullmove > 14) return 0;
  const kingSq = position.kingSquare(color);
  const homeKing = color === WHITE ? 60 : 4;
  if (kingSq !== homeKing) return 0;
  const homeRow = color === WHITE ? 6 : 1;
  const pawn = color === WHITE ? 'P' : 'p';
  let score = 0;
  // A tactical engine still needs a roof. Before castling, advancing the f/g/h
  // pawns is treated as a real strategic cost, especially by two squares.
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

function pieceAttacksSquare(position, from, target, color) {
  const piece=position.board[from];
  if(!piece||colorOf(piece)!==color) return false;
  const type=typeOf(piece);
  const [fr,fc]=rowCol(from), [tr,tc]=rowCol(target);
  const dr=tr-fr, dc=tc-fc;
  if(type==='p') return dr===(color===WHITE?-1:1) && Math.abs(dc)===1;
  if(type==='n') return KNIGHT_DELTAS.some(([r,c])=>r===dr&&c===dc);
  if(type==='k') return Math.max(Math.abs(dr),Math.abs(dc))===1;
  let stepR=0,stepC=0;
  if(type==='b'||type==='q') {
    if(Math.abs(dr)===Math.abs(dc)&&dr!==0){stepR=Math.sign(dr);stepC=Math.sign(dc);}
  }
  if(!stepR&&!stepC&&(type==='r'||type==='q')) {
    if(dr===0&&dc!==0){stepC=Math.sign(dc);}
    else if(dc===0&&dr!==0){stepR=Math.sign(dr);}
  }
  if(!stepR&&!stepC) return false;
  let rr=fr+stepR,cc=fc+stepC;
  while(rr!==tr||cc!==tc) {
    if(position.board[rr*8+cc]) return false;
    rr+=stepR;cc+=stepC;
  }
  return true;
}

function attackPotential(position, color) {
  const enemy = opposite(color);
  const kingSq = position.kingSquare(enemy);
  if (kingSq < 0) return MATE_SCORE;
  const [kr,kc]=rowCol(kingSq);
  const zone=[kingSq];
  for(const [dr,dc] of KING_DELTAS){const rr=kr+dr,cc=kc+dc;if(inBounds(rr,cc))zone.push(rr*8+cc);}
  let score=0, attackers=0;
  for(let i=0;i<64;i++) {
    const p=position.board[i]; if(!p||colorOf(p)!==color||typeOf(p)==='k') continue;
    let hits=0;
    for(const sq of zone) if(pieceAttacksSquare(position,i,sq,color)) hits++;
    if(hits) {
      const weight=typeOf(p)==='q'?13:typeOf(p)==='r'?11:typeOf(p)==='b'?9:typeOf(p)==='n'?10:6;
      score += weight*hits;
      attackers++;
    }
  }
  if(attackers>=2) score += attackers*10;
  score += rayPressure(position, kingSq, color)*1.35;
  return score;
}

function tempoAndInitiative(position, perspective) {
  const us=perspective, them=opposite(us);
  let score=position.turn===us ? 7 : -7;
  const usKing=position.kingSquare(us);
  const themKing=position.kingSquare(them);
  if(themKing>=0 && position.isSquareAttacked(themKing,us)) score += 34;
  if(usKing>=0 && position.isSquareAttacked(usKing,them)) score -= 38;
  return score;
}

export function evaluate(position, perspective = position.turn) {
  let score=0;
  score += materialScore(position,perspective);
  score += pieceSquareActivity(position,perspective);
  score += mobilityScore(position,perspective);
  score += pawnStructure(position,perspective);
  const ownKing=kingSafetyFor(position,perspective);
  const enemyKing=kingSafetyFor(position,opposite(perspective));
  score += (ownKing-enemyKing)*1.45;
  score += (openingKingDiscipline(position,perspective)-openingKingDiscipline(position,opposite(perspective)))*1.35;
  score += (attackPotential(position,perspective)-attackPotential(position,opposite(perspective)))*1.18;
  score += tempoAndInitiative(position,perspective);
  return Math.round(score);
}

export function personalityMoveBonus(position, move) {
  const us=position.turn, them=opposite(us);
  const next=position.makeMove(move);
  let bonus=0;
  const beforeMaterial=materialBalance(position, us);
  const afterMaterial=materialBalance(next, us);
  const movedValue=PIECE_VALUES[typeOf(move.piece)]||0;
  const capturedValue=move.captured?(PIECE_VALUES[typeOf(move.captured)]||0):0;
  const hangingRisk=next.isSquareAttacked(move.to,them)?Math.max(0,movedValue-capturedValue):0;
  const sacrifice=Math.max(0,beforeMaterial-afterMaterial,hangingRisk);
  if(next.isInCheck(them)) bonus += 36;
  if(move.flags & FLAGS.CAPTURE) bonus += 5;
  if(move.promotion) bonus += 35;
  const beforeAttack=attackPotential(position,us);
  const afterAttack=attackPotential(next,us);
  bonus += Math.max(-15,Math.min(38,(afterAttack-beforeAttack)*0.8));
  const enemyKingBefore=kingSafetyFor(position,them);
  const enemyKingAfter=kingSafetyFor(next,them);
  bonus += Math.max(-10,Math.min(45,(enemyKingBefore-enemyKingAfter)*0.55));
  const ownKingBefore=kingSafetyFor(position,us);
  const ownKingAfter=kingSafetyFor(next,us);
  if(ownKingAfter<ownKingBefore) bonus -= Math.min(80,(ownKingBefore-ownKingAfter)*1.3);
  const disciplineLoss=openingKingDiscipline(position,us)-openingKingDiscipline(next,us);
  if(disciplineLoss>0) bonus -= Math.min(55,disciplineLoss*1.35);
  if(sacrifice>0) {
    const compensation=Math.max(0,afterAttack-beforeAttack)+(next.isInCheck(them)?34:0)+(enemyKingBefore-enemyKingAfter)*0.45;
    bonus += Math.min(52, compensation*0.75) - Math.max(0,sacrifice-compensation*5)*0.10;
  }
  return Math.round(bonus);
}

export function materialBalance(position,perspective) {
  let s=0;
  for(const p of position.board) if(p) s += signed(colorOf(p),perspective)*PIECE_VALUES[typeOf(p)];
  return s;
}

import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, BISHOP_DIRS,
  ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, KING_DELTAS, inBounds,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { VANTA_PERSONALITY } from './personality.js';

const CENTER = new Set([27, 28, 35, 36]);
const EXTENDED_CENTER = new Set([18,19,20,21,26,27,28,29,34,35,36,37,42,43,44,45]);
const PASSER_BONUS = [14, 24, 42, 76, 145, 270];
const MATE_SCORE = 100000;

export { MATE_SCORE };

function signed(color, perspective) { return color === perspective ? 1 : -1; }

function materialScore(position, perspective) {
  let score = 0;
  // Aggression comes from activity and initiative, not pretending a knight is
  // worth a pawn. Keep material slightly softened, but close to real values.
  const materialScale = 0.92 + VANTA_PERSONALITY.materialGreed / 1000;
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
      score += s * homeDistance * 4;
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
  return (count(perspective)-count(opposite(perspective))) * 1.45;
}

function isPassedPawn(position, color, r, c) {
  const dir = color === WHITE ? -1 : 1;
  for (const f of [c - 1, c, c + 1]) {
    if (f < 0 || f > 7) continue;
    for (let rr = r + dir; rr >= 0 && rr < 8; rr += dir) {
      if (position.board[rr * 8 + f] === (color === WHITE ? 'p' : 'P')) return false;
    }
  }
  return true;
}

function pawnStructure(position, perspective) {
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const sign = signed(color, perspective);
    const enemy = opposite(color);
    const pawns = [];
    for (let i = 0; i < 64; i++) if (position.board[i] === (color === WHITE ? 'P' : 'p')) pawns.push(i);
    const fileCounts = Array(8).fill(0);
    for (const sq of pawns) fileCounts[sq % 8]++;
    for (const count of fileCounts) if (count > 1) total -= sign * (count - 1) * 13;

    for (const sq of pawns) {
      const [r, c] = rowCol(sq);
      const isolated = (c === 0 || fileCounts[c - 1] === 0) && (c === 7 || fileCounts[c + 1] === 0);
      if (isolated) total -= sign * 10;
      if (!isPassedPawn(position, color, r, c)) continue;

      const progress = Math.max(0, Math.min(5, color === WHITE ? 6 - r : r - 1));
      const distance = color === WHITE ? r : 7 - r;
      let bonus = PASSER_BONUS[progress];
      const dir = color === WHITE ? -1 : 1;
      const frontR = r + dir;
      const front = inBounds(frontR,c) ? frontR * 8 + c : -1;

      if (front >= 0) {
        const blocker = position.board[front];
        if (!blocker) {
          bonus += distance === 1 ? 95 : distance === 2 ? 42 : 10;
          if (distance === 1) {
            if (position.isSquareAttacked(front, enemy)) bonus -= 48;
            else bonus += 38;
          }
        } else if (colorOf(blocker) === enemy) {
          const canChallenge = position.isSquareAttacked(front, color);
          bonus -= distance <= 2 ? (canChallenge ? 28 : 82) : (canChallenge ? 8 : 30);
        }
      }

      const protectedPasser = position.isSquareAttacked(sq, color);
      if (protectedPasser) bonus += distance <= 2 ? 48 : 22;

      const connected = pawns.some(other => {
        if (other === sq || Math.abs((other % 8) - c) !== 1) return false;
        const [or] = rowCol(other);
        return Math.abs(or - r) <= 1 && isPassedPawn(position, color, or, other % 8);
      });
      if (connected) bonus += distance <= 2 ? 58 : 28;

      total += sign * bonus;
    }
  }
  return total;
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
  scan(BISHOP_DIRS, ['b','q'], 24);
  scan(ROOK_DIRS, ['r','q'], 29);
  return pressure;
}

function kingSafetyFor(position, color) {
  const kingSq = position.kingSquare(color);
  if (kingSq < 0) return -MATE_SCORE;
  const enemy = opposite(color);
  const [r, c] = rowCol(kingSq);
  const forward = color === WHITE ? -1 : 1;
  let safety = 0;

  let shield = 0;
  for (const dc of [-1,0,1]) {
    const rr = r + forward, cc = c + dc;
    if (inBounds(rr,cc) && position.board[rr*8+cc] === (color === WHITE ? 'P':'p')) shield++;
  }
  safety += shield * 20;
  if ((color === WHITE && [62,58].includes(kingSq)) || (color === BLACK && [6,2].includes(kingSq))) safety += 18;

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
  safety += safeEscapes * 8 - attackedEscapes * 13;

  // Open and semi-open files next to the king are useful only if the enemy can
  // actually get heavy pieces there, but even statically they are a real leak.
  for (const file of [c-1,c,c+1]) {
    if (file < 0 || file > 7) continue;
    let friendlyPawn=false, anyPawn=false;
    for (let rr=0;rr<8;rr++) {
      const p=position.board[rr*8+file];
      if (p && typeOf(p)==='p') {
        anyPawn=true;
        if (colorOf(p)===color) friendlyPawn=true;
      }
    }
    if (!friendlyPawn) safety -= anyPawn ? 11 : 19;
  }

  const zone=[kingSq,...adjacent];
  let attackUnits=0, defendUnits=0, attackers=0;
  for(let i=0;i<64;i++) {
    const p=position.board[i]; if(!p||typeOf(p)==='k') continue;
    let hits=0;
    for(const sq of zone) if(pieceAttacksSquare(position,i,sq,colorOf(p))) hits++;
    if(!hits) continue;
    const type=typeOf(p);
    const unit=type==='q'?20:type==='r'?14:type==='b'?10:type==='n'?11:6;
    if(colorOf(p)===enemy) { attackUnits += unit * Math.min(2,hits); attackers++; }
    else defendUnits += Math.round(unit * 0.65) * Math.min(2,hits);
  }
  safety += defendUnits * 0.45 - attackUnits * 0.78;
  safety -= rayPressure(position, kingSq, enemy);

  if (attackers >= 2 && safeEscapes <= 1) safety -= 72 + Math.min(90, attackUnits);
  if (attackers >= 3 && safeEscapes === 0) safety -= 85;
  if (position.isSquareAttacked(kingSq, enemy)) safety -= 58;
  return safety;
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
      const weight=typeOf(p)==='q'?14:typeOf(p)==='r'?12:typeOf(p)==='b'?9:typeOf(p)==='n'?10:6;
      score += weight*hits;
      attackers++;
    }
  }
  if(attackers>=2) score += attackers*11;
  score += rayPressure(position, kingSq, color)*1.35;
  return score;
}

function tempoAndInitiative(position, perspective) {
  const us=perspective, them=opposite(us);
  let score=position.turn===us ? 7 : -7;
  const usKing=position.kingSquare(us);
  const themKing=position.kingSquare(them);
  if(themKing>=0 && position.isSquareAttacked(themKing,us)) score += 34;
  if(usKing>=0 && position.isSquareAttacked(usKing,them)) score -= 42;
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
  score += (ownKing-enemyKing)*1.55;
  score += (openingKingDiscipline(position,perspective)-openingKingDiscipline(position,opposite(perspective)))*1.35;
  score += (attackPotential(position,perspective)-attackPotential(position,opposite(perspective)))*1.16;
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
  const attacked=next.isSquareAttacked(move.to,them);
  const defended=next.isSquareAttacked(move.to,us);
  const hangingRisk=attacked?Math.max(0,movedValue-capturedValue)*(defended?0.55:1):0;
  const sacrifice=Math.max(0,beforeMaterial-afterMaterial,hangingRisk);

  if(next.isInCheck(them)) bonus += 36;
  if(move.flags & FLAGS.CAPTURE) bonus += 5;
  if(move.promotion) bonus += 32;
  const beforeAttack=attackPotential(position,us);
  const afterAttack=attackPotential(next,us);
  bonus += Math.max(-15,Math.min(38,(afterAttack-beforeAttack)*0.72));
  const enemyKingBefore=kingSafetyFor(position,them);
  const enemyKingAfter=kingSafetyFor(next,them);
  bonus += Math.max(-12,Math.min(45,(enemyKingBefore-enemyKingAfter)*0.48));
  const ownKingBefore=kingSafetyFor(position,us);
  const ownKingAfter=kingSafetyFor(next,us);
  if(ownKingAfter<ownKingBefore) bonus -= Math.min(95,(ownKingBefore-ownKingAfter)*1.35);
  const disciplineLoss=openingKingDiscipline(position,us)-openingKingDiscipline(next,us);
  if(disciplineLoss>0) bonus -= Math.min(55,disciplineLoss*1.35);

  if(sacrifice>0) {
    const compensation=Math.max(0,afterAttack-beforeAttack)+(next.isInCheck(them)?34:0)+Math.max(0,enemyKingBefore-enemyKingAfter)*0.40;
    const justified=Math.min(42,compensation*0.58);
    const uncompensated=Math.max(0,sacrifice-compensation*4.2);
    bonus += justified - Math.min(95,uncompensated*0.20);
  }
  return Math.round(bonus);
}

export function materialBalance(position,perspective) {
  let s=0;
  for(const p of position.board) if(p) s += signed(colorOf(p),perspective)*PIECE_VALUES[typeOf(p)];
  return s;
}

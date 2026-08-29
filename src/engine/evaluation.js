import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, BISHOP_DIRS,
  ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, KING_DELTAS, inBounds,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { VANTA_PERSONALITY } from './personality.js';
import { attackReadiness } from './attack-plan.js';

const CENTER = new Set([27, 28, 35, 36]);
const EXTENDED_CENTER = new Set([18,19,20,21,26,27,28,29,34,35,36,37,42,43,44,45]);
const MATE_SCORE = 100000;
const PASSER_BONUS = [18, 29, 44, 67, 108, 188, 315];

export { MATE_SCORE };

function signed(color, perspective) { return color === perspective ? 1 : -1; }

function materialScore(position, perspective) {
  let score = 0;
  const materialScale = 0.88 + VANTA_PERSONALITY.materialGreed / 500;
  for (const p of position.board) {
    if (p) score += signed(colorOf(p), perspective) * PIECE_VALUES[typeOf(p)] * materialScale;
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
      if (CENTER.has(i)) score += s * 28;
      else if (EXTENDED_CENTER.has(i)) score += s * 14;
      score += s * Math.min(18, homeDistance * 5);
    } else if (type === 'b') score += s * Math.min(18, homeDistance * 4);
    else if (type === 'r') {
      const targetRank = color === WHITE ? 1 : 6;
      if (r === targetRank) score += s * 24;
    } else if (type === 'q') {
      if (position.fullmove <= 10 && homeDistance > 1) score -= s * Math.min(18, (homeDistance - 1) * 6);
    } else if (type === 'p') {
      score += s * homeDistance * 5;
      if ([3, 4].includes(c)) score += s * 5;
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
  return (count(perspective) - count(opposite(perspective))) * 1.65;
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
    const type = typeOf(piece), [r, c] = rowCol(from);
    const weight = type === 'q' ? 9 : type === 'r' ? 5 : ['b','n'].includes(type) ? 3 : 1;
    if (type === 'p') {
      const dr = color === WHITE ? -1 : 1;
      for (const dc of [-1,1]) {
        const rr=r+dr,cc=c+dc; if(inBounds(rr,cc)) add(rr*8+cc,weight);
      }
    } else if (type === 'n' || type === 'k') {
      const deltas=type==='n'?KNIGHT_DELTAS:KING_DELTAS;
      for(const [dr,dc] of deltas){const rr=r+dr,cc=c+dc;if(inBounds(rr,cc))add(rr*8+cc,weight);}
    } else {
      const dirs=type==='b'?BISHOP_DIRS:type==='r'?ROOK_DIRS:QUEEN_DIRS;
      for(const [dr,dc] of dirs){let rr=r+dr,cc=c+dc;while(inBounds(rr,cc)){const sq=rr*8+cc;add(sq,weight);if(position.board[sq])break;rr+=dr;cc+=dc;}}
    }
  }
  return {counts,weights};
}
function buildAttackPair(position){return {[WHITE]:buildAttackData(position,WHITE),[BLACK]:buildAttackData(position,BLACK)};}

function pawnStructure(position, perspective, attacks) {
  let total = 0;
  for (const color of [WHITE, BLACK]) {
    const sign = signed(color, perspective), pawns=[];
    for(let i=0;i<64;i++)if(position.board[i]===(color===WHITE?'P':'p'))pawns.push(i);
    const fileCounts=Array(8).fill(0); for(const sq of pawns)fileCounts[sq%8]++;
    for(const count of fileCounts)if(count>1)total-=sign*(count-1)*13;
    for(const sq of pawns){
      const [r,c]=rowCol(sq);
      const isolated=(c===0||fileCounts[c-1]===0)&&(c===7||fileCounts[c+1]===0); if(isolated)total-=sign*10;
      const dir=color===WHITE?-1:1; let passed=true;
      for(const f of [c-1,c,c+1]){if(f<0||f>7)continue;for(let rr=r+dir;rr>=0&&rr<8;rr+=dir){if(position.board[rr*8+f]===(color===WHITE?'p':'P')){passed=false;break;}}}
      if(passed){
        const progress=Math.max(0,Math.min(6,color===WHITE?6-r:r-1)); let bonus=PASSER_BONUS[progress];
        const enemy=opposite(color),frontRow=r+dir;
        if(frontRow>=0&&frontRow<8){const front=frontRow*8+c,blocker=position.board[front];if(blocker&&colorOf(blocker)===enemy)bonus*=attacks[color].counts[front]>attacks[enemy].counts[front]?0.82:0.62;}
        if(attacks[color].counts[sq])bonus*=1.12;
        if(progress>=5){const promoSq=color===WHITE?c:56+c;if(!position.board[promoSq]&&attacks[color].counts[promoSq]>=attacks[enemy].counts[promoSq])bonus+=55;}
        total+=sign*Math.round(bonus);
      }
    }
  }
  return total;
}

function homeInfo(color){return color===WHITE?{knights:[[57,'N'],[62,'N']],bishops:[[58,'B'],[61,'B']],queen:[59,'Q'],king:[60,'K'],castles:[62,58],rights:'KQ'}:{knights:[[1,'n'],[6,'n']],bishops:[[2,'b'],[5,'b']],queen:[3,'q'],king:[4,'k'],castles:[6,2],rights:'kq'};}
function minorDeploymentStats(position,color){const h=homeInfo(color),home=[...h.knights,...h.bishops];let surviving=0,active=0;for(let sq=0;sq<64;sq++){const piece=position.board[sq];if(!piece||colorOf(piece)!==color||!['n','b'].includes(typeOf(piece)))continue;surviving++;const onOriginalHome=home.some(([homeSq,homePiece])=>homeSq===sq&&homePiece===piece);if(!onOriginalHome)active++;}return{surviving,active,casualties:Math.max(0,4-surviving),unmobilized:Math.max(0,4-active)};}
function undevelopedMinorCount(position,color){return minorDeploymentStats(position,color).unmobilized;}

function developmentScore(position,perspective){
  if(position.fullmove>14)return 0; let total=0;
  for(const color of [WHITE,BLACK]){
    const sign=signed(color,perspective),h=homeInfo(color),minors=minorDeploymentStats(position,color),developed=minors.active;
    let score=developed*12; const kingSq=position.kingSquare(color);
    if(h.castles.includes(kingSq))score+=28;
    else if(kingSq!==h.king[0]&&position.fullmove<=11)score-=20;
    const undeveloped=minors.unmobilized;
    if(kingSq===h.king[0]&&position.fullmove>=7&&undeveloped>=2)score-=Math.min(20,(position.fullmove-6)*3+undeveloped*3);
    if(position.board[h.queen[0]]!==h.queen[1]&&developed<2&&position.fullmove<=10)score-=(2-developed)*12;
    total+=sign*score;
  }
  return total;
}

function rookAndBishopStructure(position,perspective){let total=0;for(const color of [WHITE,BLACK]){const sign=signed(color,perspective),bishop=color===WHITE?'B':'b',rook=color===WHITE?'R':'r',pawn=color===WHITE?'P':'p',enemyPawn=color===WHITE?'p':'P';let bishops=0;for(const p of position.board)if(p===bishop)bishops++;if(bishops>=2)total+=sign*24;for(let sq=0;sq<64;sq++){if(position.board[sq]!==rook)continue;const file=sq%8;let ownPawn=false,opposingPawn=false;for(let row=0;row<8;row++){const p=position.board[row*8+file];if(p===pawn)ownPawn=true;else if(p===enemyPawn)opposingPawn=true;}if(!ownPawn&&!opposingPawn)total+=sign*13;else if(!ownPawn)total+=sign*7;}}return total;}

function loosePieceScore(position,perspective,attacks){let total=0;for(let sq=0;sq<64;sq++){const piece=position.board[sq];if(!piece||typeOf(piece)==='k')continue;const color=colorOf(piece),enemy=opposite(color);if(!attacks[enemy].counts[sq])continue;const defended=Boolean(attacks[color].counts[sq]),value=PIECE_VALUES[typeOf(piece)]||0;const exposure=defended?(typeOf(piece)==='q'?18:typeOf(piece)==='r'?12:7):Math.max(10,Math.min(220,Math.round(value*.24)));total-=signed(color,perspective)*exposure;}return total;}

function rayPressure(position,kingSq,attackerColor){let pressure=0;const [kr,kc]=rowCol(kingSq);const scan=(dirs,sliders,base)=>{for(const [dr,dc] of dirs){let rr=kr+dr,cc=kc+dc,distance=1;while(inBounds(rr,cc)){const p=position.board[rr*8+cc];if(p){if(colorOf(p)===attackerColor&&sliders.includes(typeOf(p)))pressure+=Math.max(4,base-distance*3);break;}rr+=dr;cc+=dc;distance++;}}};scan(BISHOP_DIRS,['b','q'],22);scan(ROOK_DIRS,['r','q'],25);return pressure;}

function kingSafetyFor(position,color,attacks){
  const kingSq=position.kingSquare(color);if(kingSq<0)return-MATE_SCORE;const enemy=opposite(color),[r,c]=rowCol(kingSq);let safety=0;const forward=color===WHITE?-1:1;let shield=0;
  for(const dc of [-1,0,1]){const rr=r+forward,cc=c+dc;if(inBounds(rr,cc)&&position.board[rr*8+cc]===(color===WHITE?'P':'p'))shield++;}
  safety+=shield*18;if((color===WHITE&&['g1','c1'].includes(squareName(kingSq)))||(color===BLACK&&['g8','c8'].includes(squareName(kingSq))))safety+=18;
  const adjacent=[];for(const [dr,dc] of KING_DELTAS){const rr=r+dr,cc=c+dc;if(inBounds(rr,cc))adjacent.push(rr*8+cc);}let attackedEscapes=0,safeEscapes=0;for(const sq of adjacent){const occupant=position.board[sq];if(occupant&&colorOf(occupant)===color)continue;if(attacks[enemy].counts[sq])attackedEscapes++;else safeEscapes++;}
  safety+=safeEscapes*5-attackedEscapes*10;const ray=rayPressure(position,kingSq,enemy);safety-=ray;
  let nearbyAttackers=0,nearbyDefenders=0;for(let i=0;i<64;i++){const p=position.board[i];if(!p)continue;const [pr,pc]=rowCol(i),dist=Math.max(Math.abs(pr-r),Math.abs(pc-c));if(dist<=3&&typeOf(p)!=='k'){if(colorOf(p)===enemy)nearbyAttackers+=typeOf(p)==='q'?3:typeOf(p)==='r'?2:1;else nearbyDefenders+=typeOf(p)==='q'?2:1;}}
  safety+=nearbyDefenders*3-nearbyAttackers*7;if(attacks[enemy].counts[kingSq])safety-=45;
  let dangerSignals=0;if(shield<=1)dangerSignals++;if(attackedEscapes>=3)dangerSignals++;if(ray>=16)dangerSignals++;if(nearbyAttackers>=5)dangerSignals++;if(attacks[enemy].counts[kingSq])dangerSignals+=2;
  const h=homeInfo(color);if(kingSq===h.king[0]&&position.fullmove>=9&&!([...h.rights].some(x=>position.castling.includes(x))))dangerSignals++;
  if(dangerSignals>=4)safety-=Math.min(120,12*(dangerSignals-3)*(dangerSignals-3));
  return safety;
}

function squareName(index){const files='abcdefgh',row=Math.floor(index/8),col=index%8;return`${files[col]}${8-row}`;}
function openingKingDiscipline(position,color){if(position.fullmove>14)return 0;const kingSq=position.kingSquare(color),homeKing=color===WHITE?60:4;if(kingSq!==homeKing)return 0;const homeRow=color===WHITE?6:1,pawn=color===WHITE?'P':'p';let score=0;for(const file of [5,6,7]){let pawnSq=-1;for(let row=0;row<8;row++){const sq=row*8+file;if(position.board[sq]===pawn){pawnSq=sq;break;}}if(pawnSq<0){score-=15;continue;}const [row]=rowCol(pawnSq),advance=color===WHITE?homeRow-row:row-homeRow;if(advance<=0)score+=4;else score-=advance===1?9:24+(advance-2)*8;}const right=color===WHITE?'K':'k';if(position.castling.includes(right)){score+=8;const fSq=color===WHITE?61:5,gSq=color===WHITE?62:6;if(!position.board[fSq])score+=5;if(!position.board[gSq])score+=7;}return score;}

function attackPotential(position,color,attacks){const enemy=opposite(color),kingSq=position.kingSquare(enemy);if(kingSq<0)return MATE_SCORE;const [kr,kc]=rowCol(kingSq),zone=[kingSq];for(const [dr,dc] of KING_DELTAS){const rr=kr+dr,cc=kc+dc;if(inBounds(rr,cc))zone.push(rr*8+cc);}let weightedHits=0,hitCount=0;for(const sq of zone){weightedHits+=attacks[color].weights[sq];hitCount+=attacks[color].counts[sq];}let score=weightedHits*1.45;if(hitCount>=2)score+=Math.min(48,hitCount*6);score+=rayPressure(position,kingSq,color)*1.35;return score;}
function tempoAndInitiative(position,perspective,attacks){const us=perspective,them=opposite(us);let score=position.turn===us?7:-7;const usKing=position.kingSquare(us),themKing=position.kingSquare(them);if(themKing>=0&&attacks[us].counts[themKing])score+=34;if(usKing>=0&&attacks[them].counts[usKing])score-=38;return score;}

export function evaluateBreakdown(position,perspective=position.turn){const attacks=buildAttackPair(position);const material=materialScore(position,perspective),activity=pieceSquareActivity(position,perspective),mobility=mobilityScore(position,perspective),pawns=pawnStructure(position,perspective,attacks),development=developmentScore(position,perspective),structure=rookAndBishopStructure(position,perspective),loose=loosePieceScore(position,perspective,attacks),ownKing=kingSafetyFor(position,perspective,attacks),enemyKing=kingSafetyFor(position,opposite(perspective),attacks),kingSafety=(ownKing-enemyKing)*1.5,kingDiscipline=(openingKingDiscipline(position,perspective)-openingKingDiscipline(position,opposite(perspective)))*1.35,attack=(attackPotential(position,perspective,attacks)-attackPotential(position,opposite(perspective),attacks))*1.15,initiative=tempoAndInitiative(position,perspective,attacks),total=material+activity+mobility+pawns+development+structure+loose+kingSafety+kingDiscipline+attack+initiative;return{material,activity,mobility,pawns,development,structure,loose,kingSafety,kingDiscipline,attack,initiative,total:Math.round(total)};}
export function evaluate(position,perspective=position.turn){return evaluateBreakdown(position,perspective).total;}

function isMinorHomeSquare(color,type,square){const h=homeInfo(color),set=type==='n'?h.knights:type==='b'?h.bishops:[];return set.some(([sq])=>sq===square);}

export function personalityMoveBonus(position,move){
  const us=position.turn,them=opposite(us),next=position.makeMove(move),beforeAttacks=buildAttackPair(position),afterAttacks=buildAttackPair(next);let bonus=0;const beforeMaterial=materialBalance(position,us),afterMaterial=materialBalance(next,us),movedValue=PIECE_VALUES[typeOf(move.piece)]||0,capturedValue=move.captured?(PIECE_VALUES[typeOf(move.captured)]||0):0,hangingRisk=afterAttacks[them].counts[move.to]?Math.max(0,movedValue-capturedValue):0,sacrifice=Math.max(0,beforeMaterial-afterMaterial,hangingRisk),givesCheck=next.isInCheck(them);
  const readinessBefore=attackReadiness(position,us),readinessAfter=attackReadiness(next,us);

  // Forcing chess keeps the proven baseline weight even during mobilization.
  // If there is a real check/capture/promotion, Vanta may take it. Readiness
  // only suppresses decorative aggression, never a concrete tactic.
  if(givesCheck)bonus+=36;if(move.flags&FLAGS.CAPTURE)bonus+=5;if(move.promotion)bonus+=35;const beforeAttack=attackPotential(position,us,beforeAttacks),afterAttack=attackPotential(next,us,afterAttacks);bonus+=Math.max(-15,Math.min(38,(afterAttack-beforeAttack)*.8));const enemyKingBefore=kingSafetyFor(position,them,beforeAttacks),enemyKingAfter=kingSafetyFor(next,them,afterAttacks);bonus+=Math.max(-10,Math.min(45,(enemyKingBefore-enemyKingAfter)*.55));const ownKingBefore=kingSafetyFor(position,us,beforeAttacks),ownKingAfter=kingSafetyFor(next,us,afterAttacks);if(ownKingAfter<ownKingBefore)bonus-=Math.min(80,(ownKingBefore-ownKingAfter)*1.3);const disciplineLoss=openingKingDiscipline(position,us)-openingKingDiscipline(next,us);if(disciplineLoss>0)bonus-=Math.min(55,disciplineLoss*1.35);

  if(position.fullmove<=12){
    const type=typeOf(move.piece),undeveloped=undevelopedMinorCount(position,us),tactical=givesCheck||Boolean(move.flags&FLAGS.CAPTURE)||Boolean(move.promotion);
    if(['n','b'].includes(type)){
      if(isMinorHomeSquare(us,type,move.from))bonus+=readinessBefore.phase==='mobilize'?16:10;
      else if(undeveloped>=2&&!tactical)bonus-=readinessBefore.phase==='mobilize'?24:18;
    }
    if(type==='p'&&[0,1,6,7].includes(move.from%8)&&undeveloped>=2&&!tactical)bonus-=readinessBefore.phase==='mobilize'?12:9;
    if(type==='q'&&readinessBefore.developedMinors<3&&!tactical)bonus-=10;
    const readinessGain=readinessAfter.score-readinessBefore.score;
    if(readinessBefore.phase!=='assault'&&!tactical&&readinessGain>0)bonus+=Math.min(12,Math.round(readinessGain*.5));
  }

  // Once the army is actually ready, turn the original Vanta aggression up,
  // but only by tens of centipawns. Objective search still decides whether the
  // candidate belongs in the root window at all.
  if(readinessBefore.phase==='assault'){
    const joined=Math.max(0,readinessAfter.attackers-readinessBefore.attackers);
    bonus+=joined*6;
    if(givesCheck)bonus+=8;
    if(givesCheck&&readinessAfter.attackers>=3)bonus+=5;
    if(afterAttack>beforeAttack)bonus+=Math.min(10,Math.round((afterAttack-beforeAttack)*.12));
  }else if(readinessBefore.phase==='pressure'){
    const joined=Math.max(0,readinessAfter.attackers-readinessBefore.attackers);
    bonus+=joined*3;
  }

  if(sacrifice>0){const compensation=Math.max(0,afterAttack-beforeAttack)+(givesCheck?34:0)+Math.max(0,enemyKingBefore-enemyKingAfter)*.45;const unsupported=Math.max(0,sacrifice-compensation*3.5);bonus+=Math.min(52,compensation*.72)-unsupported*.18;}
  return Math.round(bonus);
}
export function materialBalance(position,perspective){let score=0;for(const p of position.board)if(p)score+=signed(colorOf(p),perspective)*PIECE_VALUES[typeOf(p)];return score;}

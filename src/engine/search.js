import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { evaluate, personalityMoveBonus, MATE_SCORE } from './evaluation.js';
import { strengthConfig, VANTA_PERSONALITY } from './personality.js';
import {
  staticExchangeEval, mateInOneMove, isKingZoneMove, kingSafetyCritical,
  isAdvancedPawnPush,
} from './tactical.js';

const INF = 1_000_000;
const MATE_TT_THRESHOLD = MATE_SCORE - 2000;

export class SearchEngine {
  constructor(config = {}) {
    this.config = { ...strengthConfig(1500), ...config };
    this.tt = new Map();
    this.history = new Map();
    this.killers = Array.from({length:64},()=>[null,null]);
    this.resetStats();
  }

  resetStats() {
    this.nodes=0; this.qnodes=0; this.ttHits=0; this.cutoffs=0; this.start=0; this.deadline=0; this.stopped=false;
    this.seeCalls=0; this.rootMateRejects=0; this.seeCache=new Map(); this.mateOneCache=new Map();
  }

  stop() { this.stopped=true; }
  timeUp() { return this.stopped || this.nodes >= this.config.nodeLimit || (this.deadline && performanceNow() >= this.deadline); }

  see(position,move) {
    this.seeCalls++;
    return staticExchangeEval(position,move,this.seeCache);
  }

  findMateInOne(position) {
    const key=position.hash.toString();
    if(this.mateOneCache.has(key)) {
      const uci=this.mateOneCache.get(key);
      return uci ? position.moveFromUci(uci) : null;
    }
    const move=mateInOneMove(position);
    this.mateOneCache.set(key,move?moveToUci(move):'');
    return move;
  }

  search(position, options = {}) {
    this.resetStats();
    this.start=performanceNow();
    const moveTimeMs=options.moveTimeMs ?? this.config.moveTimeMs;
    this.deadline=this.start+moveTimeMs;
    const maxDepth=options.maxDepth ?? this.config.maxDepth;
    let best=null, completedDepth=0, rootLines=[];

    for(let depth=1;depth<=maxDepth;depth++) {
      const result=this.searchRoot(position,depth,options);
      if(result.lines.length && (!best || result.complete)) {
        best=result; rootLines=result.lines;
        if(result.complete) completedDepth=depth;
      }
      if(!result.complete || this.timeUp()) break;
      if(Math.abs(result.score)>=MATE_SCORE-1000) break;
    }

    const elapsed=Math.max(1,performanceNow()-this.start);
    if(!best) {
      const excluded=new Set(options.excludeMoves||[]);
      const allLegal=position.legalMoves().filter(move=>!excluded.has(moveToUci(move)));
      const safe=allLegal.filter(move=>!this.findMateInOne(position.makeMove(move)));
      const fallback=safe.length?safe:allLegal;
      if(fallback.length) best={bestMove:fallback[0],score:evaluate(position.makeMove(fallback[0]),position.turn),pv:[fallback[0]],lines:[]};
      else best={bestMove:null,score:evaluate(position,position.turn),pv:[],lines:[]};
    }

    const chosen=this.personalitySelect(position, rootLines.length?rootLines:best.lines || [], best);
    return {
      move: chosen.move || best.bestMove,
      score: chosen.score ?? best.score,
      objectiveScore: chosen.objectiveScore ?? best.score,
      pv: chosen.pv || best.pv,
      depth: completedDepth,
      nodes:this.nodes,
      qnodes:this.qnodes,
      ttHits:this.ttHits,
      cutoffs:this.cutoffs,
      seeCalls:this.seeCalls,
      rootMateRejects:this.rootMateRejects,
      timeMs:Math.round(elapsed),
      nps:Math.round((this.nodes+this.qnodes)*1000/elapsed),
      candidates:(rootLines.length?rootLines:best.lines||[]).slice(0,6).map(x=>({
        uci:moveToUci(x.move),score:x.score,pv:x.pv.map(moveToUci),personality:x.personality||0,see:x.see??0,
      })),
    };
  }

  searchRoot(position, depth, options={}) {
    const excluded=new Set(options.excludeMoves||[]);
    const forcedMate=this.findMateInOne(position);
    if(forcedMate && !excluded.has(moveToUci(forcedMate))) {
      const line={move:forcedMate,score:MATE_SCORE-1,pv:[forcedMate],personality:0,see:this.see(position,forcedMate),check:true,promotion:Boolean(forcedMate.promotion),exact:true};
      return {bestMove:forcedMate,score:line.score,pv:line.pv,lines:[line],complete:true};
    }

    let moves=this.orderMoves(position,position.legalMoves(),0,null).filter(move=>!excluded.has(moveToUci(move)));
    if(!moves.length) return {bestMove:null,score:evaluate(position,position.turn),pv:[],lines:[],complete:true};

    // Tactical safety is hierarchical: if at least one move survives the next
    // move without being mated, moves that allow mate-in-one are not candidates.
    const safety=moves.map(move=>({move,mateLoss:Boolean(this.findMateInOne(position.makeMove(move)))}));
    const safe=safety.filter(x=>!x.mateLoss).map(x=>x.move);
    if(safe.length) {
      this.rootMateRejects += safety.length-safe.length;
      moves=safe;
    }

    const lines=[];
    let rootAlpha=-INF;
    let searched=0;
    for(const move of moves) {
      if(this.timeUp()) break;
      const next=position.makeMove(move);
      const see=this.see(position,move);
      const check=next.isInCheck(next.turn);
      const riskySacrifice=see<=-70;
      const extension=(riskySacrifice || move.promotion || isAdvancedPawnPush(position,move))?1:0;
      const childDepth=Math.max(0,depth-1+extension);
      let pv=[];
      let score;
      let exact=searched===0;

      if(searched===0) {
        score=-this.negamax(next,childDepth,-INF,INF,1,pv,[position.hash],4);
      } else {
        score=-this.negamax(next,childDepth,-INF,-rootAlpha,1,pv,[position.hash],4);
        if(score>rootAlpha && !this.timeUp()) {
          pv=[];
          score=-this.negamax(next,childDepth,-INF,INF,1,pv,[position.hash],4);
          exact=true;
        }
      }

      const line={move,score,pv:[move,...pv],personality:personalityMoveBonus(position,move),see,check,promotion:Boolean(move.promotion),exact};
      lines.push(line); searched++;
      if(score>rootAlpha) rootAlpha=score;
    }

    lines.sort((a,b)=>b.score-a.score);
    const provisionalBest=lines[0];
    if(provisionalBest && !this.timeUp()) {
      const exactWindow=(this.config.selectionWindow??55)+35;
      const threshold=provisionalBest.score-exactWindow;
      for(const line of lines) {
        if(this.timeUp()) break;
        if(line.exact || line.score<threshold) continue; // fail-low upper bound is already too poor.
        const next=position.makeMove(line.move);
        const extension=(line.see<=-70 || line.promotion || isAdvancedPawnPush(position,line.move))?1:0;
        const pv=[];
        line.score=-this.negamax(next,Math.max(0,depth-1+extension),-INF,INF,1,pv,[position.hash],4);
        line.pv=[line.move,...pv]; line.exact=true;
      }
      lines.sort((a,b)=>b.score-a.score);
    }

    const best=lines[0] || {move:null,score:evaluate(position,position.turn),pv:[]};
    return {bestMove:best.move,score:best.score,pv:best.pv,lines,complete:searched===moves.length};
  }

  negamax(position,depth,alpha,beta,ply,pvOut,pathHashes,extensionsLeft=4) {
    this.nodes++;
    if((this.nodes & 511)===0 && this.timeUp()) return evaluate(position,position.turn);

    let priorOccurrences=0;
    for(const hash of pathHashes) if(hash===position.hash) priorOccurrences++;
    if(priorOccurrences>=2) return this.repetitionUtility(position);

    const status=position.status(1);
    if(status.over) {
      if(status.reason==='checkmate') return -MATE_SCORE+ply;
      return 0;
    }
    if(depth<=0) return this.quiescence(position,alpha,beta,ply,0);

    const key=position.hash.toString();
    const tt=this.tt.get(key);
    if(tt && tt.depth>=depth) {
      this.ttHits++;
      const ttScore=scoreFromTT(tt.score,ply);
      if(tt.flag==='exact') return ttScore;
      if(tt.flag==='lower') alpha=Math.max(alpha,ttScore);
      else if(tt.flag==='upper') beta=Math.min(beta,ttScore);
      if(alpha>=beta) return ttScore;
    }

    const inCheck=position.isInCheck();
    if(inCheck && extensionsLeft>0) { depth++; extensionsLeft--; }
    const originalAlpha=alpha;
    const originalBeta=beta;
    let bestScore=-INF,bestMove=null,bestPv=[];
    const moves=this.orderMoves(position,position.legalMoves(),ply,tt?.move||null);
    const criticalKing=kingSafetyCritical(position,position.turn);
    const forcedNode=moves.length===1;

    for(let i=0;i<moves.length;i++) {
      const move=moves[i];
      if(this.timeUp()) break;
      const next=position.makeMove(move);
      const check=next.isInCheck(next.turn);
      const advanced=isAdvancedPawnPush(position,move);
      const kingZone=!check && !(move.flags&FLAGS.CAPTURE) && isKingZoneMove(position,move);
      let childDepth=depth-1;
      let childExtensions=extensionsLeft;
      if(childExtensions>0 && (move.promotion || advanced || forcedNode)) { childDepth++; childExtensions--; }

      let reduction=0;
      if(depth>=3 && i>=5 && !inCheck && !criticalKing && !forcedNode && !(move.flags & FLAGS.CAPTURE) && !move.promotion && !check && !kingZone && !advanced) reduction=1;

      let childPv=[];
      pathHashes.push(position.hash);
      let score=-this.negamax(next,Math.max(0,childDepth-reduction),-beta,-alpha,ply+1,childPv,pathHashes,childExtensions);
      if(reduction && score>alpha && !this.timeUp()) {
        childPv=[];
        score=-this.negamax(next,Math.max(0,childDepth),-beta,-alpha,ply+1,childPv,pathHashes,childExtensions);
      }
      pathHashes.pop();

      if(score>bestScore) { bestScore=score; bestMove=move; bestPv=[move,...childPv]; }
      if(score>alpha) alpha=score;
      if(alpha>=beta) {
        this.cutoffs++;
        if(!(move.flags & FLAGS.CAPTURE)) {
          const u=moveToUci(move); const k=this.killers[ply]||[null,null];
          if(k[0]!==u) this.killers[ply]=[u,k[0]];
          this.history.set(u,(this.history.get(u)||0)+depth*depth);
        }
        break;
      }
    }

    if(bestMove==null) return evaluate(position,position.turn);
    pvOut.push(...bestPv);
    const flag=bestScore<=originalAlpha?'upper':bestScore>=originalBeta?'lower':'exact';
    this.tt.set(key,{depth,score:scoreToTT(bestScore,ply),flag,move:moveToUci(bestMove)});
    if(this.tt.size>150000) {
      let n=0; for(const k of this.tt.keys()) { this.tt.delete(k); if(++n>30000) break; }
    }
    return bestScore;
  }

  quiescence(position,alpha,beta,ply,qDepth=0) {
    this.qnodes++;
    if(this.timeUp()) return evaluate(position,position.turn);

    const inCheck=position.isInCheck();
    const legal=position.legalMoves();
    if(legal.length===0) return inCheck ? -MATE_SCORE+ply : 0;
    if(position.halfmove>=100) return 0;

    const stand=evaluate(position,position.turn);
    if(!inCheck) {
      if(stand>=beta) return beta;
      if(stand>alpha) alpha=stand;
    }
    if((qDepth>=6 && !inCheck) || qDepth>=10) return alpha;

    let moves;
    if(inCheck) moves=legal;
    else {
      moves=legal.filter(move=>{
        if((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
        const next=position.makeMove(move);
        return next.isInCheck(next.turn); // quiet checks, including quiet mating moves.
      });
    }
    moves=this.orderMoves(position,moves,ply,null);

    for(const move of moves) {
      const next=position.makeMove(move);
      const check=next.isInCheck(next.turn);
      if(!inCheck && (move.flags & FLAGS.CAPTURE)) {
        const see=this.see(position,move);
        if(see<0 && !check && !move.promotion && stand+see+100<=alpha) continue;
      }
      const score=-this.quiescence(next,-beta,-alpha,ply+1,qDepth+1);
      if(score>=beta) return beta;
      if(score>alpha) alpha=score;
    }
    return alpha;
  }

  orderMoves(position,moves,ply,ttMove) {
    const killers=this.killers[ply]||[];
    const scoreMove = m => {
      const u=moveToUci(m);
      let s=0;
      if(ttMove===u) s+=120000;
      const next=position.makeMove(m);
      if(next.isInCheck(next.turn)) s+=52000;
      if(m.promotion) {
        const see=this.see(position,m);
        s+=36000+(PIECE_VALUES[m.promotion]||0)*3+see*8;
      }
      if(m.flags & FLAGS.CAPTURE) {
        const victim=PIECE_VALUES[typeOf(m.captured)]||0;
        const see=this.see(position,m);
        s+=22000+victim*3+see*18;
      }
      if(killers[0]===u) s+=9000; else if(killers[1]===u) s+=7000;
      s+=(this.history.get(u)||0);
      return s;
    };
    return [...moves].sort((a,b)=>scoreMove(b)-scoreMove(a));
  }

  personalitySelect(position,lines,bestFallback) {
    if(!lines?.length) return {move:bestFallback.bestMove,score:bestFallback.score,objectiveScore:bestFallback.score,pv:bestFallback.pv};
    const exactLines=lines.filter(l=>l.exact!==false);
    const pool=exactLines.length?exactLines:lines;
    const bestScore=pool[0].score;
    if(Math.abs(bestScore)>=MATE_SCORE-1000) return {move:pool[0].move,score:bestScore,objectiveScore:bestScore,pv:pool[0].pv};
    const window=this.config.selectionWindow ?? 55;
    const eligible=pool.filter(l=>l.score>=bestScore-window);
    const scored=eligible.map(l=>{
      const deterministicNoise=this.config.evalNoise ? pseudoNoise(position.hash,l.move,this.config.evalNoise) : 0;
      let personality=l.personality||0;
      // Negative SEE is not forbidden. It simply has to be justified by the
      // objective search instead of winning the personality contest by itself.
      if((l.see??0)<=-70) personality=Math.min(personality,l.check||l.promotion?28:8);
      const composite=l.score+personality+deterministicNoise;
      return {...l,composite};
    }).sort((a,b)=>b.composite-a.composite);
    const pick=scored[0]||pool[0];
    return {move:pick.move,score:pick.composite,objectiveScore:pick.score,pv:pick.pv};
  }

  repetitionUtility(position) {
    const staticScore=evaluate(position,position.turn);
    const material=materialBalance(position,position.turn);
    const aversion=180+Math.round((VANTA_PERSONALITY.drawAversion/100)*520);
    if(material>0 || staticScore>=80) return -aversion;
    if(material<0 || staticScore<=-80) return Math.round(aversion*0.35);
    return 0;
  }

  predictBranches(position,count=4,options={}) {
    const predictionDepth=Math.max(2,Math.min(4,(options.depth ?? this.config.maxDepth)-1));
    const opponentSearch=new SearchEngine({...this.config,maxDepth:predictionDepth,moveTimeMs:Math.max(60,Math.floor((options.timeMs??220)/2)),nodeLimit:60000,selectionWindow:0,evalNoise:0});
    const root=opponentSearch.searchRoot(position,predictionDepth,{});
    const candidates=root.lines.slice(0,count);
    const branches=[];
    for(const cand of candidates) {
      const after=position.makeMove(cand.move);
      const responseEngine=new SearchEngine({...this.config,maxDepth:predictionDepth,moveTimeMs:Math.max(45,Math.floor((options.timeMs??220)/count)),nodeLimit:50000});
      const response=responseEngine.search(after,{maxDepth:predictionDepth,moveTimeMs:Math.max(45,Math.floor((options.timeMs??220)/count))});
      if(response.move) branches.push({
        opponentMove:moveToUci(cand.move),
        engineMove:moveToUci(response.move),
        evaluation:-cand.score,
        depth:predictionDepth,
        continuation:[moveToUci(cand.move),...response.pv.map(moveToUci)].slice(0,6),
      });
    }
    return branches;
  }
}

function performanceNow() { return globalThis.performance?.now?.() ?? Date.now(); }
function pseudoNoise(hash,move,amplitude) {
  let x=Number((hash ^ BigInt(move.from*131+move.to*17+(move.promotion?.charCodeAt(0)||0))) & 0xffffffffn)>>>0;
  x ^= x<<13; x ^= x>>>17; x ^= x<<5;
  return Math.round((((x>>>0)/0xffffffff)*2-1)*amplitude);
}
function materialBalance(position,color) {
  let score=0;
  for(const piece of position.board) {
    if(!piece) continue;
    const value=PIECE_VALUES[typeOf(piece)]||0;
    score+=colorOf(piece)===color?value:-value;
  }
  return score;
}
function scoreToTT(score,ply) {
  if(score>=MATE_TT_THRESHOLD) return score+ply;
  if(score<=-MATE_TT_THRESHOLD) return score-ply;
  return score;
}
function scoreFromTT(score,ply) {
  if(score>=MATE_TT_THRESHOLD) return score-ply;
  if(score<=-MATE_TT_THRESHOLD) return score+ply;
  return score;
}

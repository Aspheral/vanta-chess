import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { evaluate, personalityMoveBonus, MATE_SCORE } from './evaluation.js';
import { strengthConfig, VANTA_PERSONALITY } from './personality.js';

const INF = 1_000_000;

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
  }

  stop() { this.stopped=true; }
  timeUp() { return this.stopped || this.nodes >= this.config.nodeLimit || (this.deadline && performanceNow() >= this.deadline); }

  search(position, options = {}) {
    this.resetStats();
    this.start=performanceNow();
    const moveTimeMs=options.moveTimeMs ?? this.config.moveTimeMs;
    this.deadline=this.start+moveTimeMs;
    const maxDepth=options.maxDepth ?? this.config.maxDepth;
    let best=null, completedDepth=0, rootLines=[];
    for(let depth=1;depth<=maxDepth;depth++) {
      const result=this.searchRoot(position,depth,options);
      if(this.timeUp() && completedDepth>0) break;
      if(result.bestMove) { best=result; completedDepth=depth; rootLines=result.lines; }
      if(Math.abs(result.score)>=MATE_SCORE-1000) break;
    }
    const elapsed=Math.max(1,performanceNow()-this.start);
    if(!best) {
      const excluded=new Set(options.excludeMoves||[]);
      const allLegal=position.legalMoves();
      const legal=allLegal.filter(move=>!excluded.has(moveToUci(move)));
      const fallback=legal.length?legal:allLegal;
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
      timeMs:Math.round(elapsed),
      nps:Math.round((this.nodes+this.qnodes)*1000/elapsed),
      candidates:(rootLines.length?rootLines:best.lines||[]).slice(0,6).map(x=>({uci:moveToUci(x.move),score:x.score,pv:x.pv.map(moveToUci),personality:x.personality||0})),
    };
  }

  searchRoot(position, depth, options={}) {
    const excluded=new Set(options.excludeMoves||[]);
    let moves=this.orderMoves(position,position.legalMoves(),0,null).filter(move=>!excluded.has(moveToUci(move)));
    const lines=[];
    for(const move of moves) {
      if(this.timeUp()) break;
      const next=position.makeMove(move);
      const pv=[];
      // Personality selection needs comparable root values. Internal nodes still use
      // alpha-beta windows, but each root candidate is resolved with a full window
      // instead of exposing fail-low/fail-high bounds as if they were exact scores.
      const score=-this.negamax(next,depth-1,-INF,INF,1,pv,[position.hash]);
      lines.push({move,score,pv:[move,...pv],personality:personalityMoveBonus(position,move)});
    }
    lines.sort((a,b)=>b.score-a.score);
    const best=lines[0] || {move:null,score:evaluate(position,position.turn),pv:[]};
    return {bestMove:best.move,score:best.score,pv:best.pv,lines};
  }

  negamax(position,depth,alpha,beta,ply,pvOut,pathHashes) {
    this.nodes++;
    if((this.nodes & 1023)===0 && this.timeUp()) return evaluate(position,position.turn);
    // A repeated position is a draw only on its third occurrence, not the second.
    // The previous implementation treated the first recurrence as a draw, which
    // made Vanta far more repetition-happy than actual chess rules require.
    let priorOccurrences=0;
    for(const hash of pathHashes) if(hash===position.hash) priorOccurrences++;
    if(priorOccurrences>=2) return this.repetitionUtility(position);
    const status=position.status(1);
    if(status.over) {
      if(status.reason==='checkmate') return -MATE_SCORE+ply;
      return 0;
    }
    if(depth<=0) return this.quiescence(position,alpha,beta,ply);
    const key=position.hash.toString();
    const tt=this.tt.get(key);
    if(tt && tt.depth>=depth) {
      this.ttHits++;
      if(tt.flag==='exact') return tt.score;
      if(tt.flag==='lower') alpha=Math.max(alpha,tt.score);
      else if(tt.flag==='upper') beta=Math.min(beta,tt.score);
      if(alpha>=beta) return tt.score;
    }
    const inCheck=position.isInCheck();
    if(inCheck && depth<8) depth++;
    const originalAlpha=alpha;
    let bestScore=-INF,bestMove=null,bestPv=[];
    const moves=this.orderMoves(position,position.legalMoves(),ply,tt?.move||null);
    for(let i=0;i<moves.length;i++) {
      const move=moves[i];
      if(this.timeUp()) break;
      const next=position.makeMove(move);
      let childPv=[];
      let reduction=0;
      if(depth>=3 && i>=5 && !inCheck && !(move.flags & FLAGS.CAPTURE) && !move.promotion) reduction=1;
      let score=-this.negamax(next,depth-1-reduction,-beta,-alpha,ply+1,childPv,[...pathHashes,position.hash]);
      if(reduction && score>alpha) {
        childPv=[];
        score=-this.negamax(next,depth-1,-beta,-alpha,ply+1,childPv,[...pathHashes,position.hash]);
      }
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
    const flag=bestScore<=originalAlpha?'upper':bestScore>=beta?'lower':'exact';
    this.tt.set(key,{depth,score:bestScore,flag,move:moveToUci(bestMove)});
    if(this.tt.size>150000) {
      let n=0; for(const k of this.tt.keys()) { this.tt.delete(k); if(++n>30000) break; }
    }
    return bestScore;
  }

  quiescence(position,alpha,beta,ply) {
    this.qnodes++;
    const inCheck=position.isInCheck();
    let moves=inCheck?position.legalMoves():position.legalMoves({capturesOnly:true});
    if(inCheck && moves.length===0) return -MATE_SCORE+ply;
    const stand=evaluate(position,position.turn);
    if(!inCheck) {
      if(stand>=beta) return beta;
      if(stand>alpha) alpha=stand;
    }
    if(ply>8 || this.timeUp()) return alpha;
    moves=this.orderMoves(position,moves,ply,null);
    for(const move of moves) {
      if(!inCheck && (move.flags & FLAGS.CAPTURE)) {
        const victim=PIECE_VALUES[typeOf(move.captured)]||0;
        const attacker=PIECE_VALUES[typeOf(move.piece)]||0;
        if(stand+victim+120<alpha && victim<attacker) continue;
      }
      const score=-this.quiescence(position.makeMove(move),-beta,-alpha,ply+1);
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
      if(ttMove===u) s+=100000;
      const next=position.makeMove(m);
      if(next.isInCheck(next.turn)) s+=50000;
      if(m.flags & FLAGS.CAPTURE) s+=20000+(PIECE_VALUES[typeOf(m.captured)]||0)*10-(PIECE_VALUES[typeOf(m.piece)]||0);
      if(m.promotion) s+=30000+(PIECE_VALUES[m.promotion]||0);
      if(killers[0]===u) s+=9000; else if(killers[1]===u) s+=7000;
      s+=(this.history.get(u)||0);
      return s;
    };
    return [...moves].sort((a,b)=>scoreMove(b)-scoreMove(a));
  }

  personalitySelect(position,lines,bestFallback) {
    if(!lines?.length) return {move:bestFallback.bestMove,score:bestFallback.score,objectiveScore:bestFallback.score,pv:bestFallback.pv};
    const bestScore=lines[0].score;
    if(Math.abs(bestScore)>=MATE_SCORE-1000) return {move:lines[0].move,score:bestScore,objectiveScore:bestScore,pv:lines[0].pv};
    const window=this.config.selectionWindow ?? 55;
    const eligible=lines.filter(l=>l.score>=bestScore-window);
    const scored=eligible.map((l,i)=>{
      const deterministicNoise=this.config.evalNoise ? pseudoNoise(position.hash,l.move,this.config.evalNoise) : 0;
      const composite=l.score+(l.personality||0)+deterministicNoise;
      return {...l,composite};
    }).sort((a,b)=>b.composite-a.composite);
    const pick=scored[0]||lines[0];
    return {move:pick.move,score:pick.composite,objectiveScore:pick.score,pv:pick.pv};
  }

  repetitionUtility(position) {
    const staticScore=evaluate(position,position.turn);
    const material=materialBalance(position,position.turn);
    const aversion=180+Math.round((VANTA_PERSONALITY.drawAversion/100)*520);
    // Vanta treats a draw as a bad result when the side to move is materially
    // ahead OR objectively winning. When behind, a repetition is an acceptable
    // defensive resource. Negamax flips this value correctly for the opponent.
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

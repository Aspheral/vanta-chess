import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChessGame } from '../chess/game.js';
import { WHITE, BLACK, PIECE_VALUES, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { SearchEngine as CurrentSearch } from './search.js';
import { staticExchangeEval, mateInOneMove } from './tactical.js';

const legacyRoot=resolve(process.env.LEGACY_ROOT||'legacy');
const { SearchEngine: LegacySearch }=await import(pathToFileURL(resolve(legacyRoot,'src/engine/search.js')).href);
const MOVE_MS=Number(process.env.QUALITY_MOVE_MS||140);
const SF_MS=Number(process.env.QUALITY_SF_MS||35);
const MAX_PLIES=Number(process.env.QUALITY_MAX_PLIES||90);
const NODE_LIMIT=Number(process.env.QUALITY_NODE_LIMIT||80000);

const OPENINGS=[
  {name:'Italian',moves:['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6']},
  {name:'Sicilian',moves:['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6']},
  {name:'Queens Gambit',moves:['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6']},
];

class UciStockfish {
  constructor(binary) {
    this.proc=spawn(binary,[],{stdio:['pipe','pipe','inherit']});
    this.waiters=[];
    this.info=[];
    this.rl=createInterface({input:this.proc.stdout});
    this.rl.on('line',line=>{
      if(line.startsWith('info ')) this.info.push(line);
      for(const waiter of [...this.waiters]) {
        if(waiter.test(line)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter),1);
          waiter.resolve(line);
        }
      }
    });
  }
  send(cmd){this.proc.stdin.write(`${cmd}\n`);}
  wait(test,ms=10000){return new Promise((resolve,reject)=>{const w={test,resolve,timer:setTimeout(()=>{this.waiters=this.waiters.filter(x=>x!==w);reject(new Error('Stockfish timeout'));},ms)};this.waiters.push(w);});}
  async init(){
    this.send('uci'); await this.wait(x=>x==='uciok');
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 64');
    this.send('setoption name UCI_LimitStrength value false');
    this.send('isready'); await this.wait(x=>x==='readyok');
  }
  async analyze(history,searchMove=null) {
    this.info=[];
    this.send(history.length?`position startpos moves ${history.join(' ')}`:'position startpos');
    this.send(`go movetime ${SF_MS}${searchMove?` searchmoves ${searchMove}`:''}`);
    const bestLine=await this.wait(x=>x.startsWith('bestmove '),SF_MS+5000);
    let score=null,depth=0;
    for(const line of this.info) {
      const d=Number(line.match(/\bdepth\s+(\d+)/)?.[1]||0);
      const mate=line.match(/\bscore\s+mate\s+(-?\d+)/);
      const cp=line.match(/\bscore\s+cp\s+(-?\d+)/);
      if((mate||cp)&&d>=depth) {
        depth=d;
        score=mate?{type:'mate',value:Number(mate[1])}:{type:'cp',value:Number(cp[1])};
      }
    }
    return {bestMove:bestLine.split(/\s+/)[1],score,depth};
  }
  quit(){try{this.send('quit');}catch{};this.rl.close();this.proc.kill();}
}

async function findStockfish(){
  for(const p of [process.env.STOCKFISH_BIN,'/usr/games/stockfish','/usr/bin/stockfish'].filter(Boolean)) {try{await access(p);return p;}catch{}}
  return 'stockfish';
}

function scoreValue(score) {
  if(!score) return 0;
  if(score.type==='cp') return score.value;
  if(score.value>0) return 100000-Math.min(90,score.value)*1000;
  return -100000+Math.min(90,Math.abs(score.value))*1000;
}

function phase(position) {
  if(position.fullmove<=12) return 'opening';
  let npm=0;
  for(const p of position.board) if(p && !['p','k'].includes(typeOf(p))) npm+=PIECE_VALUES[typeOf(p)]||0;
  return npm<=2600?'endgame':'middlegame';
}

function fresh(Search){return new Search({maxDepth:5,moveTimeMs:MOVE_MS,nodeLimit:NODE_LIMIT,selectionWindow:55,evalNoise:12});}
function setup(opening){const g=new ChessGame();for(const u of opening.moves)g.playUci(u);return g;}
function blankMetrics(){return {moves:0,totalCpl:0,cpls:[],errors100:0,blunders300:0,missedWins:0,mateMisses:0,negativeSee:0,severeSee:0,soundSevereSac:0,unsoundSevereSac:0,avoidableMate1:0,phases:{opening:[],middlegame:[],endgame:[]}};}

async function adjudicate(sf,history,position,move) {
  const uci=moveToUci(move);
  const best=await sf.analyze(history);
  const played=best.bestMove===uci?best:await sf.analyze(history,uci);
  const bestV=scoreValue(best.score), playedV=scoreValue(played.score);
  const raw=Math.max(0,bestV-playedV);
  const cpl=Math.min(2000,raw);
  return {uci,bestMove:best.bestMove,bestScore:best.score,playedScore:played.score,cpl,bestValue:bestV,playedValue:playedV,sfDepth:Math.min(best.depth,played.depth||best.depth)};
}

function record(bucket,position,move,a) {
  bucket.moves++;
  bucket.totalCpl+=a.cpl;
  bucket.cpls.push(a.cpl);
  bucket.phases[phase(position)].push(a.cpl);
  if(a.cpl>=100) bucket.errors100++;
  if(a.cpl>=300) bucket.blunders300++;
  if(a.bestValue>=200 && a.playedValue<=0) bucket.missedWins++;
  if(a.bestScore?.type==='mate' && a.bestScore.value>0 && !(a.playedScore?.type==='mate'&&a.playedScore.value>0)) bucket.mateMisses++;
  const see=staticExchangeEval(position,move);
  if(see<0) bucket.negativeSee++;
  if(see<=-200) {
    bucket.severeSee++;
    if(a.cpl<=75) bucket.soundSevereSac++;
    if(a.cpl>=250) bucket.unsoundSevereSac++;
  }
  const next=position.makeMove(move);
  if(next.status().over===false && mateInOneMove(next)) {
    const avoidable=position.legalMoves().some(m=>{
      const n=position.makeMove(m);
      return n.status().over || !mateInOneMove(n);
    });
    if(avoidable) bucket.avoidableMate1++;
  }
  return see;
}

function finish(bucket){
  const sorted=[...bucket.cpls].sort((a,b)=>a-b);
  const median=sorted.length?(sorted.length%2?sorted[(sorted.length-1)/2]:(sorted[sorted.length/2-1]+sorted[sorted.length/2])/2):0;
  const phaseOut={};
  for(const [name,list] of Object.entries(bucket.phases)) phaseOut[name]={moves:list.length,acpl:list.length?Number((list.reduce((a,b)=>a+b,0)/list.length).toFixed(1)):0};
  return {...bucket,acpl:bucket.moves?Number((bucket.totalCpl/bucket.moves).toFixed(1)):0,medianCpl:Number(median.toFixed(1)),phases:phaseOut,cpls:undefined};
}

async function play(sf,opening,revisedColor,totals) {
  const game=setup(opening);
  let plies=0;
  const rows=[];
  while(!game.status().over && plies<MAX_PLIES) {
    const position=game.position;
    const revisedTurn=position.turn===revisedColor;
    const Search=revisedTurn?CurrentSearch:LegacySearch;
    const side=revisedTurn?'revised':'legacy';
    const result=fresh(Search).search(position,{moveTimeMs:MOVE_MS,maxDepth:5});
    if(!result.move) break;
    const analysis=await adjudicate(sf,game.history.map(x=>x.uci),position,result.move);
    const see=record(totals[side],position,result.move,analysis);
    rows.push({ply:game.cursor+1,side,phase:phase(position),move:analysis.uci,cpl:analysis.cpl,see,bestMove:analysis.bestMove,bestScore:analysis.bestScore,playedScore:analysis.playedScore});
    game.play(result.move);
    plies++;
  }
  const s=game.status();
  return {opening:opening.name,revisedColor,result:s.over?s.result:'1/2-1/2',reason:s.over?s.reason:'ply cap',plies,rows};
}

const sf=new UciStockfish(await findStockfish());
await sf.init();
try {
  const totals={revised:blankMetrics(),legacy:blankMetrics()};
  const games=[];
  for(const opening of OPENINGS) for(const revisedColor of [WHITE,BLACK]) {
    const g=await play(sf,opening,revisedColor,totals);
    games.push(g);
    console.log(`${opening.name.padEnd(14)} revised ${revisedColor} ${g.result} ${g.reason} ${g.plies} plies`);
  }
  const report={generatedAt:new Date().toISOString(),methodology:{vantaMoveMs:MOVE_MS,stockfishMoveAnalysisMs:SF_MS,maxPlies:MAX_PLIES,openings:OPENINGS.map(x=>x.name),colorsSwapped:true,cplCap:2000},summary:{revised:finish(totals.revised),legacy:finish(totals.legacy)},games};
  console.log('\nQUALITY_JSON');
  console.log(JSON.stringify(report,null,2));
} finally { sf.quit(); }

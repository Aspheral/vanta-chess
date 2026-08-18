import { ChessGame } from '../chess/game.js';
import { moveToUci } from '../chess/position.js';
import { SearchEngine } from './search.js';
import { evaluate } from './evaluation.js';

const GAME = [
  'b1c3','g8f6','g1f3','b8c6','e2e4','f6g4','d2d4','a7a5','c1f4','b7b6','f1c4','c8b7',
  'd4d5','g4h2','h1h2','c6b4','a2a3','b7a6','c4a6','b4a6','c3b5','c7c5','e4e5','c5c4',
  'd5d6','a6c5','b5c7','d8c7','d6c7','c5e4','f3d4','c4c3','e5e6','f7e6','d4e6','d7e6',
  'd1d4','c3b2','a1d1','b2b1q','d1b1','e4d6','b1d1','b6b5','f4d6','e7d6','d4b6','e8f7',
  'b6b8','a8a6','c7c8q','f7f6','d1d6','f8d6','h2h3','h8c8','h3f3','f6g6','b8b7','a6a8',
  'b7e4','g6h6','e4g4','d6a3','f3h3'
];

const CASES = [
  { id:'A-unsound-Nxh2', plies:13, side:'b', bad:'g4h2', note:'after 7.d5; Vanta to move' },
  { id:'B-dangerous-passer', plies:25, side:'b', bad:'a6c5', note:'after 13.d6; Vanta chose 13...Nc5 and allowed Nc7+' },
  { id:'C-promotion-recapture', plies:39, side:'b', bad:null, note:'after 20.Rd1; assess b2-b1=Q and immediate recapture' },
  { id:'D-quiet-mate-threat', plies:63, side:'b', bad:'d6a3', note:'after 32.Qg4; must prevent Rh3#' },
];

function positionAfter(plies) {
  const game = new ChessGame();
  for (let i=0;i<plies;i++) {
    const uci=GAME[i];
    const move=game.position.moveFromUci(uci);
    if (!move) throw new Error(`Illegal audit move ${i+1}: ${uci} in ${game.position.toFEN()}`);
    game.play(move);
  }
  return game.position;
}

function inspect(position, timeMs, depth) {
  const engine=new SearchEngine({moveTimeMs:timeMs,maxDepth:depth,nodeLimit:600000,selectionWindow:55,evalNoise:12});
  const result=engine.search(position,{moveTimeMs:timeMs,maxDepth:depth});
  return {
    move: result.move ? moveToUci(result.move) : null,
    score: result.score,
    objectiveScore: result.objectiveScore,
    depth: result.depth,
    nodes: result.nodes,
    qnodes: result.qnodes,
    nps: result.nps,
    timeMs: result.timeMs,
    pv: result.pv.map(moveToUci),
    candidates: result.candidates,
  };
}

const report={generatedAt:new Date().toISOString(),commit:process.env.GITHUB_SHA||null,cases:[]};
for(const c of CASES){
  const position=positionAfter(c.plies);
  if(position.turn!==c.side) throw new Error(`${c.id}: wrong side to move`);
  const legal=position.legalMoves().map(moveToUci);
  const base350=inspect(position,350,5);
  const deep1500=inspect(position,1500,7);
  report.cases.push({...c,fen:position.toFEN(),staticEval:evaluate(position,position.turn),legalCount:legal.length,badMoveLegal:c.bad?legal.includes(c.bad):null,base350,deep1500});
  console.log(`\n=== ${c.id} ===`);
  console.log(position.toFEN());
  console.log('350ms',JSON.stringify(base350));
  console.log('1500ms',JSON.stringify(deep1500));
}
console.log('\nAUDIT_JSON');
console.log(JSON.stringify(report,null,2));

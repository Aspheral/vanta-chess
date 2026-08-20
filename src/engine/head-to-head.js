import { pathToFileURL } from 'node:url';
import { resolve, join } from 'node:path';

const OLD_ROOT=resolve(process.env.OLD_ROOT||'.');
const NEW_ROOT=resolve(process.env.NEW_ROOT||'.');
const MOVE_TIME_MS=Number(process.env.MOVE_TIME_MS||120);
const MAX_PLIES=Number(process.env.MAX_PLIES||100);

async function importFrom(root,path){
  return import(`${pathToFileURL(join(root,path)).href}?v=${Date.now()}-${Math.random()}`);
}

const [{SearchEngine:OldSearch},{Position:OldPosition},{SearchEngine:NewSearch},{ChessGame},{rootTacticalRisk}] = await Promise.all([
  importFrom(OLD_ROOT,'src/engine/search.js'),
  importFrom(OLD_ROOT,'src/chess/position.js'),
  importFrom(NEW_ROOT,'src/engine/search.js'),
  importFrom(NEW_ROOT,'src/chess/game.js'),
  importFrom(NEW_ROOT,'src/engine/tactics.js'),
]);
const {Position:NewPosition,moveToUci}=await importFrom(NEW_ROOT,'src/chess/position.js');

const OPENINGS=[
  ['Italian',['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6']],
  ['Sicilian',['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6']],
  ['Queens Gambit',['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6']],
  ['English',['c2c4','e7e5','b1c3','g8f6','g2g3','d7d5']],
  ['French',['e2e4','e7e6','d2d4','d7d5','b1c3','g8f6']],
  ['Caro-Kann',['e2e4','c7c6','d2d4','d7d5','b1c3','d5e4']],
  ['Kings Indian',['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6']],
  ['Nimzo-Indian',['d2d4','g8f6','c2c4','e7e6','b1c3','f8b4']],
  ['Scandinavian',['e2e4','d7d5','e4d5','d8d5','b1c3','d5d8']],
  ['Pirc',['e2e4','d7d6','d2d4','g8f6','b1c3','g7g6']],
  ['Ruy Lopez',['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6']],
  ['London',['d2d4','d7d5','g1f3','g8f6','c1f4','e7e6']],
];

function setup(moves){const g=new ChessGame();for(const u of moves)g.playUci(u);return g;}
function point(result,color){if(result==='1/2-1/2')return .5;if(result==='1-0')return color==='w'?1:0;if(result==='0-1')return color==='b'?1:0;return .5;}
function newEngine(){return new NewSearch({maxDepth:6,moveTimeMs:MOVE_TIME_MS,nodeLimit:260000,selectionWindow:32,evalNoise:0});}
function oldEngine(){return new OldSearch({maxDepth:6,moveTimeMs:MOVE_TIME_MS,nodeLimit:260000,selectionWindow:32,evalNoise:0});}

function runSearch(kind,fen){
  if(kind==='new')return newEngine().search(NewPosition.fromFEN(fen),{moveTimeMs:MOVE_TIME_MS,maxDepth:6});
  return oldEngine().search(OldPosition.fromFEN(fen),{moveTimeMs:MOVE_TIME_MS,maxDepth:6});
}

function chosenUci(result){
  if(!result?.move)return null;
  if(typeof result.move==='string')return result.move;
  return moveToUci(result.move);
}

const games=[];
const totals={newWins:0,draws:0,oldWins:0,newDepth:0,oldDepth:0,newMoves:0,oldMoves:0,newRisk:0,oldRisk:0};
for(const [name,opening] of OPENINGS){
  for(const newColor of ['w','b']){
    const game=setup(opening);
    const start=game.cursor;
    let terminal=null;
    while(game.cursor-start<MAX_PLIES){
      const status=game.status();if(status.over){terminal=status;break;}
      const kind=game.position.turn===newColor?'new':'old';
      const fen=game.position.toFEN();
      const result=runSearch(kind,fen);
      const uci=chosenUci(result);
      if(!uci||!game.position.moveFromUci(uci)){terminal={over:true,result:'1/2-1/2',reason:'invalid/no move'};break;}
      const neutralMove=game.position.moveFromUci(uci);
      const risk=rootTacticalRisk(game.position,neutralMove);
      if(kind==='new'){
        totals.newDepth+=result.depth||0;totals.newMoves++;if(risk>=300)totals.newRisk++;
      }else{
        totals.oldDepth+=result.depth||0;totals.oldMoves++;if(risk>=300)totals.oldRisk++;
      }
      game.play(neutralMove);
    }
    if(!terminal)terminal={over:true,result:'1/2-1/2',reason:'ply cap'};
    const p=point(terminal.result,newColor);
    if(p===1)totals.newWins++;else if(p===.5)totals.draws++;else totals.oldWins++;
    games.push({opening:name,newColor,result:terminal.result,reason:terminal.reason,newPoint:p,plies:game.cursor-start});
    console.log(`${name} new=${newColor}: ${terminal.result} ${terminal.reason} (${game.cursor-start} plies)`);
  }
}

const report={
  moveTimeMs:MOVE_TIME_MS,maxPlies:MAX_PLIES,games:games.length,
  score:{newWins:totals.newWins,draws:totals.draws,oldWins:totals.oldWins,newPoints:totals.newWins+totals.draws*.5},
  averageDepth:{new:Number((totals.newDepth/Math.max(1,totals.newMoves)).toFixed(2)),old:Number((totals.oldDepth/Math.max(1,totals.oldMoves)).toFixed(2))},
  highTacticalRiskMoves:{new:totals.newRisk,old:totals.oldRisk},
  details:games,
};
console.log('\n=== Old vs New Vanta ===');
console.log(JSON.stringify(report,null,2));

const score=report.score.newPoints/report.games;
if(score<0.54){
  console.error(`New Vanta scored only ${(score*100).toFixed(1)}%; strength gate requires >=54%.`);
  process.exitCode=1;
}

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ChessGame } from '../chess/game.js';
import { WHITE, BLACK, opposite } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { SearchEngine as CurrentSearch } from './search.js';
import { staticExchangeEval, mateInOneMove } from './tactical.js';

const legacyRoot=resolve(process.env.LEGACY_ROOT||'legacy');
const { SearchEngine: LegacySearch }=await import(pathToFileURL(resolve(legacyRoot,'src/engine/search.js')).href);
const MOVE_MS=Number(process.env.SELFPLAY_MOVE_MS||180);
const MAX_PLIES=Number(process.env.SELFPLAY_MAX_PLIES||110);
const NODE_LIMIT=Number(process.env.SELFPLAY_NODE_LIMIT||100000);

const OPENINGS=[
  {name:'Italian',moves:['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6']},
  {name:'Sicilian',moves:['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6']},
  {name:'Queens Gambit',moves:['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6']},
  {name:'French',moves:['e2e4','e7e6','d2d4','d7d5','b1c3','g8f6']},
  {name:'Nimzo',moves:['d2d4','g8f6','c2c4','e7e6','b1c3','f8b4']},
  {name:'Kings Indian',moves:['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7']},
];

function freshEngine(Search) {
  return new Search({maxDepth:5,moveTimeMs:MOVE_MS,nodeLimit:NODE_LIMIT,selectionWindow:55,evalNoise:12});
}

function openingGame(opening) {
  const game=new ChessGame();
  for(const uci of opening.moves) {
    const move=game.position.moveFromUci(uci);
    if(!move) throw new Error(`Bad opening ${opening.name}: ${uci}`);
    game.play(move);
  }
  return game;
}

function resultPoint(result,revisedColor) {
  if(result==='1/2-1/2'||result==='*') return .5;
  return (result==='1-0'&&revisedColor===WHITE)||(result==='0-1'&&revisedColor===BLACK)?1:0;
}

function safeUci(move){return move?moveToUci(move):null;}

async function play(opening,revisedColor) {
  const game=openingGame(opening);
  const metrics={
    revised:{moves:0,nodes:0,timeMs:0,depth:0,negativeSee:0,severeSee:0,missedMate1:0,allowedMate1:0},
    legacy:{moves:0,nodes:0,timeMs:0,depth:0,negativeSee:0,severeSee:0,missedMate1:0,allowedMate1:0},
  };
  const moves=[...opening.moves];
  let plies=0;
  let cap=false;

  while(!game.status().over && plies<MAX_PLIES) {
    const position=game.position;
    const revisedTurn=position.turn===revisedColor;
    const Search=revisedTurn?CurrentSearch:LegacySearch;
    const bucket=revisedTurn?metrics.revised:metrics.legacy;
    const forcedMate=mateInOneMove(position);
    const engine=freshEngine(Search);
    const result=engine.search(position,{moveTimeMs:MOVE_MS,maxDepth:5});
    const move=result.move;
    if(!move) break;

    bucket.moves++;
    bucket.nodes+=result.nodes||0;
    bucket.timeMs+=result.timeMs||0;
    bucket.depth+=result.depth||0;
    const see=staticExchangeEval(position,move);
    if(see<0) bucket.negativeSee++;
    if(see<=-200) bucket.severeSee++;
    if(forcedMate && position.makeMove(move).status().reason!=='checkmate') bucket.missedMate1++;

    const next=position.makeMove(move);
    if(next.status().over===false && mateInOneMove(next)) bucket.allowedMate1++;
    game.play(move);
    moves.push(safeUci(move));
    plies++;
  }

  if(!game.status().over) cap=true;
  const status=game.status();
  const result=cap?'1/2-1/2':status.result;
  return {
    opening:opening.name,revisedColor,result,point:resultPoint(result,revisedColor),reason:cap?'ply cap':status.reason,
    plies,moves,metrics,
  };
}

const games=[];
for(const opening of OPENINGS) {
  for(const revisedColor of [WHITE,BLACK]) {
    const game=await play(opening,revisedColor);
    games.push(game);
    console.log(`${opening.name.padEnd(14)} revised ${revisedColor} ${game.result} ${game.reason} ${game.plies} plies`);
  }
}

function aggregate(side) {
  const out={moves:0,nodes:0,timeMs:0,depth:0,negativeSee:0,severeSee:0,missedMate1:0,allowedMate1:0};
  for(const g of games) for(const k of Object.keys(out)) out[k]+=g.metrics[side][k];
  return {
    ...out,
    avgDepth:out.moves?Number((out.depth/out.moves).toFixed(2)):0,
    avgNodes:out.moves?Math.round(out.nodes/out.moves):0,
    avgMoveMs:out.moves?Number((out.timeMs/out.moves).toFixed(1)):0,
  };
}

const points=games.reduce((s,g)=>s+g.point,0);
const summary={
  games:games.length,
  revisedWins:games.filter(g=>g.point===1).length,
  draws:games.filter(g=>g.point===.5).length,
  revisedLosses:games.filter(g=>g.point===0).length,
  revisedPoints:points,
  revisedScore:Number((points/games.length).toFixed(3)),
  revised:aggregate('revised'),
  legacy:aggregate('legacy'),
};
const report={generatedAt:new Date().toISOString(),methodology:{moveTimeMs:MOVE_MS,maxPlies:MAX_PLIES,nodeLimit:NODE_LIMIT,openings:OPENINGS.map(x=>x.name),colorsSwapped:true},summary,games};
console.log('\nSELFPLAY_JSON');
console.log(JSON.stringify(report,null,2));

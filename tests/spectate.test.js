import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ChessGame} from '../src/chess/game.js';

const openings=[
  ['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6','b5a4','g8f6','e1g1','f8e7'],
  ['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6','d2d3','f8c5'],
  ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','a7a6'],
  ['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6','c1g5','f8e7'],
  ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6'],
  ['c2c4','e7e5','b1c3','g8f6','g2g3','d7d5','c4d5','f6d5'],
  ['e2e4','c7c6','d2d4','d7d5','b1c3','d5e4','c3e4','c8f5'],
  ['d2d4','g8f6','c2c4','e7e6','g2g3','d7d5','f1g2','f8e7'],
];

test('every spectate opening seed is legal from the initial position',()=>{
  for(const line of openings){
    const game=new ChessGame();
    for(const uci of line)assert.doesNotThrow(()=>game.playUci(uci),`illegal opening move ${uci}`);
  }
});

test('spectate boot path and ultra profile are wired into the browser client',()=>{
  const boot=fs.readFileSync(new URL('../src/boot.js',import.meta.url),'utf8');
  const ui=fs.readFileSync(new URL('../src/spectate-ui.js',import.meta.url),'utf8');
  assert.match(boot,/spectate.*===.*1/s);
  assert.match(boot,/Spectate/);
  assert.match(ui,/targetElo:3000/);
  assert.match(ui,/maxDepth:12/);
  assert.match(ui,/nodeLimit:4500000/);
  assert.match(ui,/StockfishClient/);
});

test('Stockfish is pinned and has a browser-safe fallback',()=>{
  const source=fs.readFileSync(new URL('../src/stockfish-client.js',import.meta.url),'utf8');
  assert.match(source,/18\.0\.8/);
  assert.match(source,/stockfish-18-lite-single\.js/);
  assert.match(source,/stockfish-18-asm\.js/);
  assert.match(source,/go movetime/);
});

test('analysis best-move arrow has a dark outline and luminous core',()=>{
  const arrows=fs.readFileSync(new URL('../src/ui/arrows.js',import.meta.url),'utf8');
  const css=fs.readFileSync(new URL('../src/spectate.css',import.meta.url),'utf8');
  assert.match(arrows,/analysis-arrow-outline/);
  assert.match(arrows,/analysis-arrow-core/);
  assert.match(arrows,/#b7ff6a/);
  assert.match(css,/analysis-best-arrow/);
  assert.match(css,/drop-shadow/);
});

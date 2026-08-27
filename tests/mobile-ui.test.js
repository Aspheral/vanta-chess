import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const boardJs=readFileSync(new URL('../src/ui/board.js',import.meta.url),'utf8');
const boardCss=readFileSync(new URL('../src/board-refresh.css',import.meta.url),'utf8');
const polishCss=readFileSync(new URL('../src/game-polish.css',import.meta.url),'utf8');
const piecesJs=readFileSync(new URL('../src/ui/pieces.js',import.meta.url),'utf8');

test('normal mobile play has pointer-based piece dragging',()=>{
  assert.match(boardJs,/piece\.addEventListener\('pointerdown'/);
  assert.match(boardJs,/piece\.addEventListener\('pointermove'/);
  assert.match(boardJs,/this\.onMoveRequest\?\.\(from,to,legal\)/);
  assert.match(boardJs,/pointerType==='mouse'/);
});

test('the chess board owns touch gestures so dragging cannot scroll the page',()=>{
  assert.match(boardCss,/\.board-shell[\s\S]*?touch-action:none/);
  assert.match(boardCss,/\.piece[\s\S]*?touch-action:none/);
  assert.match(boardCss,/overscroll-behavior:contain/);
});

test('legal move targets have explicit high-contrast mobile markers',()=>{
  assert.match(boardCss,/--move-dot:#b8ff7d/);
  assert.match(boardCss,/\.square\.legal-target:before/);
  assert.match(boardCss,/\.square\.legal-capture:before/);
  assert.match(boardCss,/@media\(max-width:520px\)[\s\S]*?legal-target/);
});

test('mobile controls and the SVG piece set are built for touch and visual depth',()=>{
  assert.match(polishCss,/--tap-size:52px/);
  assert.match(polishCss,/\.controls \.btn\{min-height:56px/);
  assert.match(piecesJs,/piece-shadow/);
  assert.match(piecesJs,/piece-highlight/);
  assert.match(piecesJs,/piece-cut/);
});

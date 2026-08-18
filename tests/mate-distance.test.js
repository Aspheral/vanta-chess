import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { MATE_SCORE } from '../src/engine/evaluation.js';
import { mateInOneMove } from '../src/engine/tactical.js';

function search(fen,{time=1800,depth=7}={}) {
  const p=Position.fromFEN(fen);
  const e=new SearchEngine({moveTimeMs:time,maxDepth:depth,nodeLimit:600000,selectionWindow:0,evalNoise:0});
  return {p,r:e.search(p,{moveTimeMs:time,maxDepth:depth})};
}

test('mate distance: mate in one is terminal and preferred immediately',()=>{
  const fen='6k1/5ppp/8/8/8/8/6PP/3R2K1 w - - 0 1';
  const {p,r}=search(fen,{time:300,depth:4});
  assert.equal(moveToUci(mateInOneMove(p)),'d1d8');
  assert.equal(moveToUci(r.move),'d1d8');
  assert.ok(r.objectiveScore>=MATE_SCORE-2,`score ${r.objectiveScore}`);
});

test('mate distance: sound queen sacrifice resolves as forced mate in two',()=>{
  const fen='5r1k/6pp/4Q2N/8/8/8/8/K7 w - - 0 1';
  const {p,r}=search(fen,{time:1000,depth:6});
  assert.equal(moveToUci(r.move),'e6g8',`PV ${r.pv.map(moveToUci).join(' ')}`);
  const afterSac=p.makeMove(p.moveFromUci('e6g8'));
  const forced=afterSac.moveFromUci('f8g8');
  assert.ok(forced);
  const afterForced=afterSac.makeMove(forced);
  assert.equal(moveToUci(mateInOneMove(afterForced)),'h6f7');
  assert.ok(r.objectiveScore>=MATE_SCORE-6,`score ${r.objectiveScore}`);
});

test('mate distance: proven mate-in-three remains visible through TT and extensions',()=>{
  // From the public matetools proven-mate corpus (bm #3).
  const fen='2k5/2N5/1PKP4/2P5/8/8/8/8 w - - 0 1';
  const {r}=search(fen,{time:2500,depth:7});
  assert.ok(r.objectiveScore>=MATE_SCORE-10,`expected a short forced mate, got ${r.objectiveScore}, PV ${r.pv.map(moveToUci).join(' ')}`);
  assert.ok(r.pv.length>=1&&r.pv.length<=5,`unexpected mate PV ${r.pv.map(moveToUci).join(' ')}`);
});

test('defense: a quiet mate-in-one threat cannot be ignored for material',()=>{
  const fen='r1r5/6pp/3bp2k/pp6/6Q1/P4R2/2P2PP1/4K3 b - - 7 32';
  const {p,r}=search(fen,{time:700,depth:4});
  const greedy=p.moveFromUci('d6a3');
  assert.equal(moveToUci(mateInOneMove(p.makeMove(greedy))),'f3h3');
  assert.equal(mateInOneMove(p.makeMove(r.move)),null,`chosen ${moveToUci(r.move)} still permits mate in one`);
});

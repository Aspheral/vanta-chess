import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';

test('engine finds mate in one',()=>{
  const p=Position.fromFEN('6k1/8/6KQ/8/8/8/8/8 w - - 0 1');
  const e=new SearchEngine({maxDepth:3,moveTimeMs:1000,nodeLimit:100000,selectionWindow:0,evalNoise:0});
  const r=e.search(p);
  const next=p.makeMove(r.move);
  assert.equal(next.status().reason,'checkmate',`played ${moveToUci(r.move)}`);
});

test('engine does not hang queen when clean capture exists',()=>{
  const p=Position.fromFEN('6k1/8/8/8/3q4/8/3R4/6K1 w - - 0 1');
  const e=new SearchEngine({maxDepth:3,moveTimeMs:1000,nodeLimit:100000,selectionWindow:0,evalNoise:0});
  const r=e.search(p);
  assert.ok(['d2d4','d2f2'].includes(moveToUci(r.move)), `played ${moveToUci(r.move)}`);
  const pv=r.pv.map(moveToUci);
  assert.ok(pv.includes('d4f2') || moveToUci(r.move)==='d2d4');
});

test('ponder branches contain legal opponent move and legal response',()=>{
  const p=Position.fromFEN('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
  const e=new SearchEngine({maxDepth:3,moveTimeMs:120,nodeLimit:50000});
  const branches=e.predictBranches(p,3,{depth:3,timeMs:180});
  assert.ok(branches.length>=1);
  for(const b of branches) {
    const om=p.moveFromUci(b.opponentMove); assert.ok(om,b.opponentMove);
    const after=p.makeMove(om);
    assert.ok(after.moveFromUci(b.engineMove),b.engineMove);
  }
});

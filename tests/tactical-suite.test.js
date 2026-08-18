import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { evaluate } from '../src/engine/evaluation.js';
import { staticExchangeEval, mateInOneMove } from '../src/engine/tactical.js';

const TEST_CONFIG={maxDepth:4,moveTimeMs:1000,nodeLimit:300000,selectionWindow:0,evalNoise:0};
const search=fen=>new SearchEngine(TEST_CONFIG).search(Position.fromFEN(fen),{moveTimeMs:1000,maxDepth:4});

test('tactical catalog: back-rank mate is found immediately',()=>{
  const fen='6k1/5ppp/8/8/8/8/6PP/3R2K1 w - - 0 1';
  const p=Position.fromFEN(fen);
  const mate=mateInOneMove(p);
  assert.ok(mate);
  assert.equal(moveToUci(mate),'d1d8');
  assert.equal(moveToUci(search(fen).move),'d1d8');
});

test('tactical catalog: royal fork is preferred over quiet play',()=>{
  const fen='4k3/5q2/8/5N2/8/8/8/6K1 w - - 0 1';
  const r=search(fen);
  assert.equal(moveToUci(r.move),'f5d6',`played ${moveToUci(r.move)} PV ${r.pv.map(moveToUci).join(' ')}`);
  const p=Position.fromFEN(fen);
  const fork=p.makeMove(p.moveFromUci('f5d6'));
  assert.equal(fork.isInCheck(),true);
  assert.equal(fork.isSquareAttacked(13,'w'),true);
});

test('tactical catalog: pinned recapture is excluded from legal SEE',()=>{
  const p=Position.fromFEN('4k3/2p1r3/1B6/8/8/8/8/4R1K1 w - - 0 1');
  const move=p.moveFromUci('b6c7');
  assert.ok(move);
  assert.equal(staticExchangeEval(p,move),100);
  const after=p.makeMove(move);
  assert.equal(after.moveFromUci('e7c7'),null,'pinned rook must not be counted as a legal recapture');
});

test('tactical catalog: x-ray attacker appears after the front bishop moves',()=>{
  const p=Position.fromFEN('6k1/8/5n2/3p4/8/8/6B1/6KQ w - - 0 1');
  const move=p.moveFromUci('g2d5');
  assert.ok(move);
  const see=staticExchangeEval(p,move);
  assert.ok(see>=70&&see<=100,`expected Bxd5 Nxd5 Qxd5 x-ray sequence, SEE ${see}`);
});

test('tactical catalog: non-capture queen sacrifice is preserved when search proves mate',()=>{
  const fen='5r1k/6pp/4Q2N/8/8/8/8/K7 w - - 0 1';
  const p=Position.fromFEN(fen);
  const sac=p.moveFromUci('e6g8');
  assert.ok(sac);
  assert.equal(staticExchangeEval(p,sac),0,'capture SEE intentionally stays neutral on a quiet sacrifice');
  const afterSac=p.makeMove(sac);
  const forced=afterSac.moveFromUci('f8g8');
  assert.ok(forced,'...Rxg8 must be the tactical acceptance of the queen sacrifice');
  const afterRook=afterSac.makeMove(forced);
  const mate=afterRook.moveFromUci('h6f7');
  assert.ok(mate);
  assert.equal(afterRook.makeMove(mate).status().reason,'checkmate');
  const r=search(fen);
  assert.equal(moveToUci(r.move),'e6g8',`Vanta must preserve sound sacrifices: ${r.pv.map(moveToUci).join(' ')}`);
});

test('tactical catalog: knight underpromotion can be the forcing move',()=>{
  const fen='8/4P1k1/5q2/8/8/8/K7/8 w - - 0 1';
  const p=Position.fromFEN(fen);
  const knight=p.moveFromUci('e7e8n');
  assert.ok(knight);
  const after=p.makeMove(knight);
  assert.equal(after.isInCheck(),true,'e8=N+ must check the king');
  assert.equal(after.isSquareAttacked(21,'w'),true,'the promoted knight must also attack the queen on f6');
  const r=search(fen);
  assert.equal(moveToUci(r.move),'e7e8n',`missed underpromotion fork: ${r.pv.map(moveToUci).join(' ')}`);
});

test('tactical catalog: advanced passed pawn urgency is nonlinear',()=>{
  const far=Position.fromFEN('7k/8/8/8/8/8/4P3/K7 w - - 0 1');
  const near=Position.fromFEN('7k/8/4P3/8/8/8/8/K7 w - - 0 1');
  const delta=evaluate(near,'w')-evaluate(far,'w');
  assert.ok(delta>=100,`sixth-rank passer should be dramatically more valuable, delta ${delta}`);
});

test('tactical catalog: winning side avoids a one-move stalemate trap',()=>{
  const fen='k7/2K4p/1Q6/8/8/8/8/7R w - - 0 1';
  const p=Position.fromFEN(fen);
  const trap=p.moveFromUci('h1h7');
  assert.ok(trap);
  assert.equal(p.makeMove(trap).status().reason,'stalemate');
  const r=search(fen);
  assert.notEqual(moveToUci(r.move),'h1h7','Vanta threw away a win by stalemate');
});

test('tactical catalog: discovered/double-check geometry survives legal move generation',()=>{
  const p=Position.fromFEN('4k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1');
  const move=p.moveFromUci('e2b5');
  assert.ok(move);
  const next=p.makeMove(move);
  assert.equal(next.isInCheck(),true);
  assert.equal(next.isSquareAttacked(4,'w'),true);
});

test('tactical catalog: rook skewer wins a queen behind the king',()=>{
  const fen='4q3/4k3/8/8/8/8/8/R5K1 w - - 0 1';
  const p=Position.fromFEN(fen);
  const skewer=p.moveFromUci('a1e1');
  assert.ok(skewer);
  assert.equal(p.makeMove(skewer).isInCheck(),true);
  const r=search(fen);
  assert.equal(moveToUci(r.move),'a1e1',`missed rook skewer: ${r.pv.map(moveToUci).join(' ')}`);
});

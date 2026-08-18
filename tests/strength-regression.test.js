import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessGame } from '../src/chess/game.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { staticExchangeEval, mateInOneMove } from '../src/engine/tactical.js';

const HUMAN_LOSS = [
  'b1c3','g8f6','g1f3','b8c6','e2e4','f6g4','d2d4','a7a5','c1f4','b7b6','f1c4','c8b7',
  'd4d5','g4h2','h1h2','c6b4','a2a3','b7a6','c4a6','b4a6','c3b5','c7c5','e4e5','c5c4',
  'd5d6','a6c5','b5c7','d8c7','d6c7','c5e4','f3d4','c4c3','e5e6','f7e6','d4e6','d7e6',
  'd1d4','c3b2','a1d1','b2b1q','d1b1','e4d6','b1d1','b6b5','f4d6','e7d6','d4b6','e8f7',
  'b6b8','a8a6','c7c8q','f7f6','d1d6','f8d6','h2h3','h8c8','h3f3','f6g6','b8b7','a6a8',
  'b7e4','g6h6','e4g4','d6a3','f3h3'
];

const CRITICAL = Object.freeze({
  A: 'r2qkb1r/1bpppppp/1pn5/p2P4/2B1PBn1/2N2N2/PPP2PPP/R2QK2R b KQkq - 0 7',
  B: 'r2qkb1r/3ppppp/np1P4/pN2P3/2p2B2/P4N2/1PP2PPR/R2QK3 b Qkq - 0 13',
  C: 'r3kb1r/2P1p1pp/1p2p3/p7/3QnB2/P7/1pP2PPR/3RK3 b kq - 1 20',
  D: 'r1r5/6pp/3bp2k/pp6/6Q1/P4R2/2P2PP1/4K3 b - - 7 32',
});

function engine(time=900,depth=4) {
  return new SearchEngine({maxDepth:depth,moveTimeMs:time,nodeLimit:250000,selectionWindow:55,evalNoise:12});
}

test('permanent regression: reproduce the complete 33.Rh3# human loss',()=>{
  const game=new ChessGame();
  for(const uci of HUMAN_LOSS) {
    const move=game.position.moveFromUci(uci);
    assert.ok(move,`illegal replay move ${uci} in ${game.position.toFEN()}`);
    game.play(move);
  }
  const status=game.status();
  assert.equal(status.over,true);
  assert.equal(status.reason,'checkmate');
  assert.equal(status.result,'1-0');
});

test('A: Nxh2 is classified as an unsound exchange and is not selected',()=>{
  const p=Position.fromFEN(CRITICAL.A);
  const sacrifice=p.moveFromUci('g4h2');
  assert.ok(sacrifice);
  assert.ok(staticExchangeEval(p,sacrifice)<=-180,`SEE ${staticExchangeEval(p,sacrifice)}`);
  const r=engine().search(p);
  assert.notEqual(moveToUci(r.move),'g4h2');
  assert.ok(r.candidates.some(c=>c.uci==='g4h2'&&c.see<=-180),JSON.stringify(r.candidates));
});

test('B: Vanta sees the Nc7+ deflection after 13...Nc5 and avoids that line',()=>{
  const p=Position.fromFEN(CRITICAL.B);
  const nc5=p.moveFromUci('a6c5');
  assert.ok(nc5);
  const afterNc5=p.makeMove(nc5);
  const nc7=afterNc5.moveFromUci('b5c7');
  assert.ok(nc7);
  const afterCheck=afterNc5.makeMove(nc7);
  assert.equal(afterCheck.isInCheck(),true,'Nc7+ must be recognized as check');
  const qxc7=afterCheck.moveFromUci('d8c7');
  assert.ok(qxc7);
  const afterQueen=afterCheck.makeMove(qxc7);
  const dxc7=afterQueen.moveFromUci('d6c7');
  assert.ok(dxc7);
  const final=afterQueen.makeMove(dxc7);
  assert.equal(final.board.includes('q'),false,'black queen must be gone after dxc7');
  assert.equal(final.board[10],'P','white passer must land on c7');

  const r=engine(1100,4).search(p);
  assert.notEqual(moveToUci(r.move),'a6c5',`PV ${r.pv.map(moveToUci).join(' ')}`);
});

test('C: promotion immediately captured is not valued as a free queen',()=>{
  const p=Position.fromFEN(CRITICAL.C);
  const promote=p.moveFromUci('b2b1q');
  assert.ok(promote);
  const see=staticExchangeEval(p,promote);
  assert.ok(see<0,`promotion SEE should be negative, got ${see}`);
  const after=p.makeMove(promote);
  assert.ok(after.moveFromUci('d1b1'),'Rxb1 must be seen as the immediate recapture');

  const r=engine().search(p);
  assert.notEqual(moveToUci(r.move),'b2b1q',`Vanta still chose the recaptured queen promotion: ${JSON.stringify(r.candidates)}`);
});

test('D critical: Bxa3 allows Rh3# and Vanta must select a defense',()=>{
  const p=Position.fromFEN(CRITICAL.D);
  const greed=p.moveFromUci('d6a3');
  assert.ok(greed);
  const mate=mateInOneMove(p.makeMove(greed));
  assert.ok(mate,'Bxa3 must expose a mate in one');
  assert.equal(moveToUci(mate),'f3h3');

  const r=engine(700,4).search(p);
  assert.notEqual(moveToUci(r.move),'d6a3',`Vanta repeated the mate blunder: ${r.pv.map(moveToUci).join(' ')}`);
  assert.equal(mateInOneMove(p.makeMove(r.move)),null,`chosen defense ${moveToUci(r.move)} still allows mate in one`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, FLAGS, moveToUci } from '../src/chess/position.js';
import { ChessGame } from '../src/chess/game.js';
import { moveToSAN } from '../src/chess/san.js';

function ucis(position) { return new Set(position.legalMoves().map(moveToUci)); }

test('starting position has 20 legal moves',()=>{
  const p=Position.start();
  assert.equal(p.legalMoves().length,20);
  assert.ok(ucis(p).has('e2e4'));
});

test('FEN round trips exactly',()=>{
  const fen='r3k2r/ppp2ppp/2n5/3pp3/8/2N2N2/PPP2PPP/R3K2R w KQkq d6 7 12';
  assert.equal(Position.fromFEN(fen).toFEN(),fen);
});

test('castling is generated and moves rook',()=>{
  const p=Position.fromFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  assert.ok(ucis(p).has('e1g1'));
  const m=p.moveFromUci('e1g1');
  const n=p.makeMove(m);
  assert.equal(n.board[62],'K');
  assert.equal(n.board[61],'R');
  assert.equal(n.board[63],null);
  assert.equal(n.castling.includes('K'),false);
});

test('en passant capture works',()=>{
  const p=Position.fromFEN('8/8/8/3pP3/8/8/8/K6k w - d6 0 1');
  const m=p.moveFromUci('e5d6');
  assert.ok(m);
  assert.ok(m.flags & FLAGS.EP_CAPTURE);
  const n=p.makeMove(m);
  assert.equal(n.board[27],null);
  assert.equal(n.board[19],'P');
});

test('promotion produces four choices and SAN',()=>{
  const p=Position.fromFEN('7k/P7/8/8/8/8/8/7K w - - 0 1');
  const promos=p.legalMoves().filter(m=>moveToUci(m).startsWith('a7a8'));
  assert.equal(promos.length,4);
  const q=p.moveFromUci('a7a8q');
  assert.match(moveToSAN(p,q),/^a8=Q/);
});

test('fools mate is checkmate',()=>{
  const g=new ChessGame();
  g.playUci('f2f3'); g.playUci('e7e5'); g.playUci('g2g4'); g.playUci('d8h4');
  const s=g.status();
  assert.equal(s.over,true);
  assert.equal(s.reason,'checkmate');
  assert.equal(s.result,'0-1');
  assert.equal(g.history.at(-1).san,'Qh4#');
});

test('undo redo preserves timeline and branching discards future',()=>{
  const g=new ChessGame();
  g.playUci('e2e4'); g.playUci('e7e5'); g.playUci('g1f3');
  assert.equal(g.cursor,3);
  g.undo(); g.undo();
  assert.equal(g.cursor,1);
  assert.equal(g.canRedo,true);
  g.redo();
  assert.equal(g.position.turn,'w');
  g.undo();
  g.playUci('c7c5');
  assert.equal(g.canRedo,false);
  assert.equal(g.history.at(-1).san,'c5');
});

test('threefold repetition is detected from timeline',()=>{
  const g=new ChessGame();
  for(let i=0;i<2;i++) {
    g.playUci('g1f3'); g.playUci('g8f6'); g.playUci('f3g1'); g.playUci('f6g8');
  }
  assert.equal(g.status().reason,'threefold repetition');
});

test('illegal move exposing own king is filtered',()=>{
  const p=Position.fromFEN('4r1k1/8/8/8/8/8/4R3/4K3 w - - 0 1');
  assert.equal(p.moveFromUci('e2f2'),null);
});

test('incremental Zobrist hash matches FEN reconstruction',()=>{
  let p=Position.start();
  for(const u of ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6']) {
    const m=p.moveFromUci(u); assert.ok(m,u); p=p.makeMove(m);
    assert.equal(p.hash,Position.fromFEN(p.toFEN()).hash,`hash mismatch after ${u}`);
  }
});

test('stalemate is detected',()=>{
  const p=Position.fromFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(p.status(),{over:true,result:'1/2-1/2',reason:'stalemate'});
});

test('fifty-move draw is detected',()=>{
  const p=Position.fromFEN('8/8/8/8/8/6k1/8/R5K1 w - - 100 51');
  assert.equal(p.status().reason,'fifty-move rule');
});

test('insufficient material detects king and bishop versus king',()=>{
  const p=Position.fromFEN('8/8/8/8/8/6k1/8/2B3K1 w - - 0 1');
  assert.equal(p.status().reason,'insufficient material');
});

test('SAN disambiguates same-type pieces',()=>{
  const p=Position.fromFEN('7k/8/8/8/8/8/4N3/1N4K1 w - - 0 1');
  const m=p.moveFromUci('b1c3');
  assert.equal(moveToSAN(p,m),'Nbc3');
});

test('repetition ignores unusable en-passant target but preserves a legal one', () => {
  const noCaptureEp = Position.fromFEN('7k/8/8/8/P7/8/8/K7 b - a3 0 1');
  const noCapturePlain = Position.fromFEN('7k/8/8/8/P7/8/8/K7 b - - 0 1');
  const game = new ChessGame();
  game.timeline = [{position:noCaptureEp},{position:noCapturePlain},{position:noCapturePlain}];
  game.cursor = 2;
  assert.equal(game.repetitionCount(noCaptureEp), 3);

  const legalEp = Position.fromFEN('7k/8/8/3pP3/8/8/8/K7 w - d6 0 1');
  const legalPlain = Position.fromFEN('7k/8/8/3pP3/8/8/8/K7 w - - 0 1');
  game.timeline = [{position:legalEp},{position:legalPlain},{position:legalPlain}];
  game.cursor = 2;
  assert.equal(game.repetitionCount(legalEp), 1);
  assert.equal(game.repetitionCount(legalPlain), 2);
});

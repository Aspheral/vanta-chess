import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { ChessGame } from '../src/chess/game.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  strategicEvaluation, strategicMoveBonus, quietThreatScore, quietThreatMoves, isEndgame,
  trappedPiecePenalty,
} from '../src/engine/strategy.js';
import { repetitionExclusions, wouldRepeatExistingPosition } from '../src/engine/draw-policy.js';

function engine(ms=900, depth=3, extra={}) {
  return new SearchEngine({maxDepth:depth,moveTimeMs:ms,nodeLimit:280000,selectionWindow:32,evalNoise:0,...extra});
}

test('the Na4 cage is recognized as a trap rather than blamed on the later c3 move',()=>{
  // After 5.f4 ...b5 in the DevTheExpertBack game the a4-knight has no safe
  // square: Nb6 meets cxb6, Nc5 meets Qxc5, Nc3 meets dxc3, and b2 is occupied.
  const trapped=Position.fromFEN('rnb1kb1r/p1p1pppp/3q1n2/1p2N3/N2p1P2/8/PPPPP1PP/R1BQKB1R w KQkq b6 0 6');
  assert.ok(trappedPiecePenalty(trapped,'w')>=160,`trap penalty ${trappedPiecePenalty(trapped,'w')}`);

  // Vacating b2 before ...b5 leaves Nb2 as an escape. The trap evaluator must
  // distinguish prophylaxis from the already-lost position.
  const before=Position.fromFEN('rnb1kb1r/ppp1pppp/3q1n2/4N3/N2p4/8/PPPPPPPP/R1BQKB1R w KQkq - 2 5');
  const b3=before.moveFromUci('b2b3');
  assert.ok(b3);
  const afterB3=before.makeMove(b3);
  const b5=afterB3.moveFromUci('b7b5');
  assert.ok(b5);
  const escaped=afterB3.makeMove(b5);
  assert.ok(trappedPiecePenalty(escaped,'w')+80<trappedPiecePenalty(trapped,'w'),
    `${trappedPiecePenalty(escaped,'w')} vs ${trappedPiecePenalty(trapped,'w')}`);
});

test('Vanta avoids Na4 before the b5 cage can form',()=>{
  // 1.Nf3 Nf6 2.Nc3 d5 3.Ne5 d4. The actual game continued 4.Na4?, moving
  // the same knight again while both bishops and the other knight still need
  // useful work. That move is the strategic decision that makes ...Qd6, f4,
  // ...b5 such an easy cage later.
  const p=Position.fromFEN('rnbqkb1r/ppp1pppp/5n2/4N3/3p4/2N5/PPPPPPPP/R1BQKB1R w KQkq - 0 4');
  const na4=p.moveFromUci('c3a4');
  assert.ok(na4);
  assert.ok(strategicMoveBonus(p,na4)<=-30,`Na4 strategic bonus ${strategicMoveBonus(p,na4)}`);
  const r=engine(1100,3).search(p,{moveTimeMs:1100,maxDepth:3});
  assert.notEqual(moveToUci(r.move),'c3a4',`still chose Na4: ${JSON.stringify(r.candidates)}`);
});

test('opening move economy penalizes knight tourism while pieces remain home',()=>{
  const p=Position.fromFEN('rnbqkbnr/pppp1ppp/8/4p3/8/2N5/PPPPPPPP/R1BQKBNR w KQkq - 2 2');
  const repeat=p.moveFromUci('c3b5');
  const develop=p.moveFromUci('g1f3');
  assert.ok(repeat&&develop);
  assert.ok(strategicMoveBonus(p,repeat)<=-30,`repeat bonus ${strategicMoveBonus(p,repeat)}`);
  assert.ok(strategicMoveBonus(p,develop)>strategicMoveBonus(p,repeat));
});

test('a second quiet queen move pays a large development debt',()=>{
  const p=Position.fromFEN('rnbqkbnr/pppp1ppp/8/4p3/4P3/1Q6/PPPP1PPP/RNB1KBNR w KQkq - 2 2');
  const queenTour=p.moveFromUci('b3c4');
  const develop=p.moveFromUci('g1f3');
  assert.ok(queenTour&&develop);
  assert.ok(strategicMoveBonus(p,queenTour)<=-40,`queen tourism bonus ${strategicMoveBonus(p,queenTour)}`);
  assert.ok(strategicMoveBonus(p,develop)>strategicMoveBonus(p,queenTour));
});

test('castling receives explicit opening completion value',()=>{
  const p=Position.fromFEN('r3k2r/ppp2ppp/2npbn2/8/2B1P3/2NP1N2/PPP2PPP/R3K2R w KQkq - 0 8');
  const castle=p.moveFromUci('e1g1');
  assert.ok(castle,'expected legal O-O');
  assert.ok(strategicMoveBonus(p,castle)>=30,`castling bonus ${strategicMoveBonus(p,castle)}`);
});

test('quiet pawn forks are part of the tactical horizon',()=>{
  const p=Position.fromFEN('7k/8/8/8/4n1b1/8/5P2/7K w - - 0 1');
  const fork=p.moveFromUci('f2f3');
  assert.ok(fork);
  assert.ok(quietThreatScore(p,fork)>=80,`fork threat score ${quietThreatScore(p,fork)}`);
  assert.ok(quietThreatMoves(p).some(move=>moveToUci(move)==='f2f3'));
});

test('queenless endgame evaluation rewards an active king',()=>{
  const center=Position.fromFEN('7k/8/8/8/3K4/8/6P1/7R w - - 0 1');
  const corner=Position.fromFEN('7k/8/8/8/8/8/6P1/K6R w - - 0 1');
  assert.ok(isEndgame(center));
  assert.ok(strategicEvaluation(center,'w')>=strategicEvaluation(corner,'w')+16,
    `${strategicEvaluation(center,'w')} vs ${strategicEvaluation(corner,'w')}`);
});

test('endgame passer pushes gain tempo-aware strategic value',()=>{
  const p=Position.fromFEN('7k/8/4P3/8/8/8/8/6K1 w - - 0 1');
  const push=p.moveFromUci('e6e7');
  assert.ok(push);
  assert.ok(strategicMoveBonus(p,push)>=15,`passer push bonus ${strategicMoveBonus(p,push)}`);
});

test('rook behind a passed pawn is valued over a disconnected rook',()=>{
  const behind=Position.fromFEN('7k/8/4P3/4R3/8/8/8/6K1 w - - 0 1');
  const side=Position.fromFEN('7k/8/4P3/R7/8/8/8/6K1 w - - 0 1');
  assert.ok(strategicEvaluation(behind,'w')>strategicEvaluation(side,'w'),
    `${strategicEvaluation(behind,'w')} vs ${strategicEvaluation(side,'w')}`);
});

test('twofold shuffling is excluded when a progress move exists',()=>{
  const game=new ChessGame('6k1/8/8/8/8/8/8/R5K1 w - - 0 10');
  game.playUci('a1a2');
  game.playUci('g8f8');
  game.playUci('a2a1');
  game.playUci('f8g8');
  const repeat=game.position.moveFromUci('a1a2');
  assert.ok(repeat);
  assert.equal(wouldRepeatExistingPosition(game,repeat),true);
  const excluded=repetitionExclusions(game,0);
  assert.ok(excluded.includes('a1a2'),JSON.stringify(excluded));
  assert.ok(excluded.length<game.position.legalMoves().length,'progress policy must leave legal alternatives');
});

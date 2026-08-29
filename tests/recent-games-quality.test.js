import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { ChessGame } from '../src/chess/game.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  rootStrategicAdjustment, strategicPositionValue, immediateMaterialLossRisk,
  rootSafetyRisk, isForcingQuietThreat,
} from '../src/engine/quality.js';
import { repetitionExclusions, shouldRejectRepetitionMove } from '../src/engine/draw-policy.js';

function engine(ms=700,depth=3) {
  return new SearchEngine({maxDepth:depth,moveTimeMs:ms,nodeLimit:260000,selectionWindow:32,evalNoise:0});
}

test('recent DevTheExpertBack loss: Vanta sees that 5.f4 allows the quiet b5 knight trap',()=>{
  // The a4 knight is not actually rescuable after 5...b5: Nc3 meets ...dxc3,
  // Nb6 meets ...axb6, and Nc5 can be taken by the queen. The real error is
  // therefore one move earlier, allowing the quiet trap with 5.f4?.
  const p=Position.fromFEN('rnb1kb1r/ppp1pppp/3q1n2/4N3/N2p4/8/PPPPPPPP/R1BQKB1R w KQkq - 2 5');
  const f4=p.moveFromUci('f2f4');
  assert.ok(f4);
  assert.ok(rootSafetyRisk(p,f4)>=560,`f4 trap risk ${rootSafetyRisk(p,f4)}`);
  const r=engine(900,4).search(p,{moveTimeMs:900,maxDepth:4});
  if(moveToUci(r.move)==='f2f4') {
    const probe=engine(5000,2);
    const root=probe.searchRoot(p,2,{});
    const diagnostic=root.lines.map(line=>({
      uci:moveToUci(line.move),score:line.score,risk:rootSafetyRisk(p,line.move),quality:rootStrategicAdjustment(p,line.move)
    })).sort((a,b)=>b.score-a.score);
    assert.fail(`still selected f4; root diagnostic ${JSON.stringify(diagnostic)}`);
  }
});

test('recent danh loss: pawn hunting Qxg7 cannot outrank saving the attacked b5 knight',()=>{
  const p=Position.fromFEN('r3k1nr/1pp1qppp/p1n1p3/1N1p4/P5b1/RP3N2/2PPPPPP/Q3KB1R w Kkq - 0 9');
  const qxg7=p.moveFromUci('a1g7');
  assert.ok(qxg7);
  assert.ok(immediateMaterialLossRisk(p,qxg7)>=600,`Qxg7 risk ${immediateMaterialLossRisk(p,qxg7)}`);
  const r=engine(900,4).search(p,{moveTimeMs:900,maxDepth:4});
  assert.notEqual(moveToUci(r.move),'a1g7',JSON.stringify(r.candidates));
});

test('opening move economy penalizes knight tourism while undeveloped pieces remain',()=>{
  const p=Position.fromFEN('rnbqkbnr/ppp1pppp/8/8/3p4/2N2N2/PPPPPPPP/R1BQKB1R w KQkq - 0 3');
  const nb5=p.moveFromUci('c3b5');
  const e3=p.moveFromUci('e2e3');
  assert.ok(nb5&&e3);
  assert.ok(rootStrategicAdjustment(p,nb5)<=-25,`Nb5 adjustment ${rootStrategicAdjustment(p,nb5)}`);
  assert.ok(rootStrategicAdjustment(p,e3)>rootStrategicAdjustment(p,nb5));
});

test('early repeat queen moves are taxed until the minor pieces are mobilized',()=>{
  const p=Position.fromFEN('rnb1kbnr/pppp1ppp/4p3/8/2Q5/5N2/PPPP1PPP/RNB1KB1R w KQkq - 2 4');
  const qb3=p.moveFromUci('c4b3');
  assert.ok(qb3);
  assert.ok(rootStrategicAdjustment(p,qb3)<=-40,`Qb3 adjustment ${rootStrategicAdjustment(p,qb3)}`);
});

test('castling receives explicit urgency and voluntary king wandering is punished',()=>{
  const p=Position.fromFEN('r1bqk2r/pppp1ppp/2n2n2/4p3/2B1P3/2N2N2/PPPP1PPP/R1BQK2R w KQkq - 6 6');
  const castle=p.moveFromUci('e1g1');
  const kingMove=p.moveFromUci('e1f1');
  assert.ok(castle&&kingMove);
  assert.ok(rootStrategicAdjustment(p,castle)>=30,`castle ${rootStrategicAdjustment(p,castle)}`);
  assert.ok(rootStrategicAdjustment(p,kingMove)<=-40,`Kf1 ${rootStrategicAdjustment(p,kingMove)}`);
});

test('endgame specialist values an active king over a cornered king',()=>{
  const active=Position.fromFEN('k7/8/8/8/3K4/8/4P3/8 w - - 0 1');
  const passive=Position.fromFEN('k7/8/8/8/8/8/4P3/7K w - - 0 1');
  assert.ok(strategicPositionValue(active,'w')>strategicPositionValue(passive,'w')+15,
    `${strategicPositionValue(active,'w')} vs ${strategicPositionValue(passive,'w')}`);
});

test('endgame specialist rewards a rook behind its passed pawn',()=>{
  const behind=Position.fromFEN('6k1/8/4P3/8/8/8/6K1/4R3 w - - 0 1');
  const side=Position.fromFEN('6k1/8/4P3/8/8/8/6K1/R7 w - - 0 1');
  assert.ok(strategicPositionValue(behind,'w')>strategicPositionValue(side,'w')+10,
    `${strategicPositionValue(behind,'w')} vs ${strategicPositionValue(side,'w')}`);
});

test('twofold cycling is treated as avoidable lack of progress while Vanta is better',()=>{
  const game=new ChessGame();
  for(const uci of ['g1f3','g8f6','f3g1','f6g8']) game.playUci(uci);
  const repeat=game.position.moveFromUci('g1f3');
  assert.ok(repeat);
  assert.equal(game.wouldCauseTwofold(repeat),true);
  const exclusions=repetitionExclusions(game,100);
  assert.ok(exclusions.includes('g1f3'),JSON.stringify(exclusions));
  assert.equal(shouldRejectRepetitionMove(game,repeat,100),true);
});

test('quiet pawn forks are explicitly tactical near the search frontier',()=>{
  const p=Position.fromFEN('6k1/8/8/8/4n1b1/8/5P2/6K1 w - - 0 1');
  const fork=p.moveFromUci('f2f3');
  assert.ok(fork);
  assert.equal(isForcingQuietThreat(p,fork),true);
});

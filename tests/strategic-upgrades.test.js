import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  hangingPieceExposure, strictHangingPieceGate,
} from '../src/engine/material-safety.js';
import {
  openingMoveEconomyBonus, applyOpeningMoveEconomyGate,
} from '../src/engine/opening-economy.js';
import {
  endgameSpecialistBreakdown, endgameSpecialistScore, endgameWeight, endgameVolatility,
} from '../src/engine/endgame-specialist.js';

function playUci(moves) {
  let position = Position.start();
  for (const uci of moves) {
    const move = position.moveFromUci(uci);
    assert.ok(move, `expected legal move ${uci} in ${position.toFEN()}`);
    position = position.makeMove(move);
  }
  return position;
}

// Same practical motif as the DevTheExpertBack game, isolated from the second
// simultaneous knight threat in the original position. This tests the rule we
// actually want: when a clean escape exists, Vanta may not ignore a pawn attack
// and donate the knight for vague activity.
const HANGING_KNIGHT=Position.fromFEN('4k3/8/8/1p6/N7/8/2P5/4K3 w - - 0 1');

test('strict hanging-piece gate blocks an avoidable attacked-knight abandonment',()=>{
  const p=HANGING_KNIGHT;
  const blunder=p.moveFromUci('c2c3');
  const rescue=p.moveFromUci('a4c5');
  assert.ok(blunder&&rescue);
  const exposure=hangingPieceExposure(p,blunder);
  assert.ok(exposure.loss>=180,`c3 exposure only ${JSON.stringify(exposure)}`);
  assert.equal(exposure.victimType,'n');
  assert.equal(hangingPieceExposure(p,rescue).loss,0);

  const gated=strictHangingPieceGate(p,[
    {move:blunder,score:28,pv:[blunder],exact:true},
    {move:rescue,score:0,pv:[rescue],exact:true},
  ]);
  assert.equal(gated.lines.some(line=>moveToUci(line.move)==='c2c3'),false);
  assert.equal(gated.lines.some(line=>moveToUci(line.move)==='a4c5'),true);
});

test('strict hanging-piece gate still permits a search-proven sacrifice',()=>{
  const p=HANGING_KNIGHT;
  const risky=p.moveFromUci('c2c3');
  const safe=p.moveFromUci('a4c5');
  const gated=strictHangingPieceGate(p,[
    {move:risky,score:260,pv:[risky],exact:true},
    {move:safe,score:0,pv:[safe],exact:true},
  ]);
  assert.equal(gated.lines.some(line=>moveToUci(line.move)==='c2c3'),true,'large objective compensation should override the safety gate');
});

test('opening move economy strongly prefers mobilizing a bishop over another knight tour',()=>{
  const p=Position.fromFEN('rnbqkb1r/ppp1pppp/5n2/3p4/8/2N1PN2/PPPP1PPP/R1BQKB1R w KQkq - 1 3');
  const tour=p.moveFromUci('f3e5');
  const develop=p.moveFromUci('f1b5');
  assert.ok(tour&&develop);
  const tourBonus=openingMoveEconomyBonus(p,tour);
  const developBonus=openingMoveEconomyBonus(p,develop);
  assert.ok(tourBonus<=-30,`knight tour bonus ${tourBonus}`);
  assert.ok(developBonus>=18,`bishop development bonus ${developBonus}`);

  const gated=applyOpeningMoveEconomyGate(p,[
    {move:tour,score:30,pv:[tour],exact:true},
    {move:develop,score:0,pv:[develop],exact:true},
  ]);
  assert.equal(gated.lines.some(line=>moveToUci(line.move)==='f3e5'),false);
  assert.equal(gated.lines.some(line=>moveToUci(line.move)==='f1b5'),true);
});

test('opening move economy does not punish a repeated minor move when that piece is already attacked',()=>{
  const p=playUci(['g1f3','g8f6','b1c3','d7d5','f3e5','d5d4']);
  const na4=p.moveFromUci('c3a4');
  assert.ok(na4);
  assert.ok(openingMoveEconomyBonus(p,na4)>=-5,`necessary Na4 retreat was overtaxed: ${openingMoveEconomyBonus(p,na4)}`);
});

test('opening move economy taxes repeated queen adventures while minors remain home',()=>{
  const p=Position.fromFEN('rnb1kbnr/pppp1ppp/4p3/8/2Q5/5N2/PPPPPPPP/RNB1KB1R w KQkq - 2 4');
  const queenShuffle=p.moveFromUci('c4b5');
  assert.ok(queenShuffle);
  assert.ok(openingMoveEconomyBonus(p,queenShuffle)<=-55,`queen shuffle bonus ${openingMoveEconomyBonus(p,queenShuffle)}`);
});

test('endgame specialist activates in low material and rewards active kings',()=>{
  const central=Position.fromFEN('7k/8/8/8/4K3/8/4P3/8 w - - 0 1');
  const corner=Position.fromFEN('7k/8/8/8/8/8/4P3/K7 w - - 0 1');
  assert.equal(endgameWeight(central),1);
  const active=endgameSpecialistBreakdown(central,'w');
  const passive=endgameSpecialistBreakdown(corner,'w');
  assert.ok(active.kingActivity>passive.kingActivity,`${JSON.stringify({active,passive})}`);
  assert.ok(endgameSpecialistScore(central,'w')>endgameSpecialistScore(corner,'w'));
});

test('endgame specialist rewards a rook correctly placed behind its passed pawn',()=>{
  const behind=Position.fromFEN('7k/8/4P3/8/3K4/8/8/4R3 w - - 0 1');
  const sideways=Position.fromFEN('7k/8/4P3/8/3K4/8/8/R7 w - - 0 1');
  const a=endgameSpecialistBreakdown(behind,'w');
  const b=endgameSpecialistBreakdown(sideways,'w');
  assert.ok(a.passers>=b.passers+15,`${JSON.stringify({behind:a,sideways:b})}`);
});

test('advanced passed-pawn endings are marked volatile for search selectivity without changing clock policy',()=>{
  const p=Position.fromFEN('7k/8/4P3/8/4K3/8/8/8 w - - 0 1');
  assert.ok(endgameVolatility(p)>=50,`endgame volatility ${endgameVolatility(p)}`);
});

test('search integration keeps an avoidable hanging-piece blunder out of the final choice',()=>{
  const p=HANGING_KNIGHT;
  const engine=new SearchEngine({maxDepth:3,moveTimeMs:900,nodeLimit:240000,selectionWindow:32,evalNoise:0});
  const result=engine.search(p,{moveTimeMs:900,maxDepth:3});
  assert.notEqual(moveToUci(result.move),'c2c3',`still abandoned the knight: ${JSON.stringify(result.candidates)}`);
  assert.equal(hangingPieceExposure(p,result.move).loss,0,`selected exposed move ${moveToUci(result.move)}`);
});

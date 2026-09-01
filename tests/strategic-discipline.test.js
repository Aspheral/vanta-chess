import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPgn, fenBeforePly } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { rootTacticalRisk } from '../src/engine/tactics.js';
import {
  openingMoveDiscipline, strategicPositionScore, rootImmediateMaterialLoss,
  quietTacticalThreatScore, isEndgameCriticalMove,
} from '../src/engine/strategic-discipline.js';

function engine(ms=850, depth=3, extra={}) {
  return new SearchEngine({
    maxDepth: depth,
    moveTimeMs: ms,
    nodeLimit: 280000,
    selectionWindow: 32,
    evalNoise: 0,
    ...extra,
  });
}

const DEV_LOSS = `[Result "0-1"]
1. Nf3 Nf6 2. Nc3 d5 3. Ne5 d4 4. Na4 Qd6 5. f4 b5 6. c3 bxa4 7. Qxa4+ Bd7 8. Qb3 e6 9. Qc4 dxc3 10. Qxc3 Nc6 11. Kd1 Rd8 12. h4 Nd5 13. Qg3 Nxf4 14. Nd3 Nxd3 15. Qxd3 Qxd3 16. exd3 Nd4 17. h5 e5 18. Rb1 Bg4+ 19. Ke1 Bc5 20. Kf2 Nf5+ 21. d4 Rxd4 22. Bb5+ Ke7 23. Kf1 Rf4+ 24. Ke1 Bf2+ 25. Kf1 Ng3# 0-1`;

const A6_LOSS = `[Result "0-1"]
1. Nc3 d5 2. Nf3 Nc6 3. a4 Bg4 4. b3 e6 5. Ba3 Bxa3 6. Rxa3 Qd6 7. Nb5 Qe7 8. Qa1 a6 9. Qxg7 axb5 10. Ra2 Qf6 11. Qxg4 bxa4 12. bxa4 Nh6 13. Qg5 Qxg5 14. Nxg5 Nb4 15. Rb2 Rxa4 16. f3 O-O 17. c3 Nc6 18. Rxb7 Ra1+ 19. Kf2 Rc8 20. Kg1 d4 21. cxd4 Nxd4 22. e3 Ndf5 23. Rb2 Kg7 24. e4 Nd4 25. e5 Kh8 26. Rb7 Rg8 27. h4 Nhf5 28. Nxf7+ Kg7 29. Rxc7 Ng3 30. Ng5+ Kg6 31. h5+ Kxg5 32. f4+ Kxf4 33. Rh4+ Kxe5 34. Rc5+ Kd6 35. Rxd4+ Kxc5 36. Rc4+ Kd5 37. d3 Rxf1+ 38. Kh2 Rh1# 0-1`;

const FORK_GAME = `[Result "0-1"]
1. e4 Nc6 2. c3 Nf6 3. Qe2 d5 4. e5 Ne4 5. d3 Bg4 6. f3 Nxe5 7. dxe4 Bh5 8. Nd2 c6 9. g4 Bg6 10. f4 Nd7 11. f5 dxe4 12. fxg6 hxg6 13. Nxe4 Ne5 0-1`;

test('opening move economy prefers developing a home bishop over more knight tourism',()=>{
  const p=Position.fromFEN('r1bqkb1r/pppp1ppp/2n2n2/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 4 4');
  const repeat=p.moveFromUci('f3g5');
  const develop=p.moveFromUci('f1c4');
  assert.ok(repeat&&develop);
  assert.ok(openingMoveDiscipline(p,develop)>=openingMoveDiscipline(p,repeat)+35,
    `${openingMoveDiscipline(p,develop)} vs ${openingMoveDiscipline(p,repeat)}`);
});

test('repeated early queen wandering is much less attractive than normal development',()=>{
  const p=Position.fromFEN('r1bqkbnr/pppp1ppp/2n5/4p2Q/4P3/8/PPPP1PPP/RNB1KBNR w KQkq - 2 3');
  const queenAgain=p.moveFromUci('h5f3');
  const develop=p.moveFromUci('g1f3');
  assert.ok(queenAgain&&develop);
  assert.ok(openingMoveDiscipline(p,develop)>=openingMoveDiscipline(p,queenAgain)+45,
    `${openingMoveDiscipline(p,develop)} vs ${openingMoveDiscipline(p,queenAgain)}`);
});

test('castling is strongly preferred to voluntarily walking the king while rights remain',()=>{
  const p=Position.fromFEN('r2qk2r/ppp2ppp/2n2n2/3pp3/3PP3/2N2N2/PPP2PPP/R2QK2R w KQkq - 0 8');
  const castle=p.moveFromUci('e1g1');
  const walk=p.moveFromUci('e1f1');
  assert.ok(castle&&walk);
  assert.ok(openingMoveDiscipline(p,castle)>=openingMoveDiscipline(p,walk)+70,
    `${openingMoveDiscipline(p,castle)} vs ${openingMoveDiscipline(p,walk)}`);
});

test('endgame specialist values an active king more than an edge-bound king',()=>{
  const active=Position.fromFEN('8/8/2k5/8/4K3/8/5p2/8 b - - 0 1');
  const passive=Position.fromFEN('1k6/8/8/8/4K3/8/5p2/8 b - - 0 1');
  assert.ok(strategicPositionScore(active,'b')>=strategicPositionScore(passive,'b')+15,
    `${strategicPositionScore(active,'b')} vs ${strategicPositionScore(passive,'b')}`);
});

test('endgame specialist rewards placing a rook behind its passed pawn',()=>{
  const behind=Position.fromFEN('7k/8/3P4/8/8/8/8/3R3K w - - 0 1');
  const side=Position.fromFEN('7k/8/3P4/8/8/8/8/R6K w - - 0 1');
  assert.ok(strategicPositionScore(behind,'w')>=strategicPositionScore(side,'w')+12,
    `${strategicPositionScore(behind,'w')} vs ${strategicPositionScore(side,'w')}`);
});

test('Vanta prevents the DevTheExpertBack knight trap at 4.Na4 instead of pretending move six can save it',()=>{
  const replay=replayPgn(DEV_LOSS);
  const p=Position.fromFEN(fenBeforePly(replay,7)); // before 4.Na4
  const na4=p.moveFromUci('c3a4');
  const nb5=p.moveFromUci('c3b5');
  assert.ok(na4&&nb5);
  assert.ok(openingMoveDiscipline(p,na4)<=-25,`Na4 discipline ${openingMoveDiscipline(p,na4)}`);
  const diagnostics={
    na4:{risk:rootTacticalRisk(p,na4),loss:rootImmediateMaterialLoss(p,na4),discipline:openingMoveDiscipline(p,na4)},
    nb5:{risk:rootTacticalRisk(p,nb5),loss:rootImmediateMaterialLoss(p,nb5),discipline:openingMoveDiscipline(p,nb5)},
  };
  const r=engine(950,3).search(p,{moveTimeMs:950,maxDepth:3});
  assert.notEqual(moveToUci(r.move),'c3a4',JSON.stringify({diagnostics,candidates:r.candidates}));
});

test('after the trap is sprung every legal Na4 retreat already loses the knight immediately',()=>{
  const replay=replayPgn(DEV_LOSS);
  const p=Position.fromFEN(fenBeforePly(replay,11)); // after ...b5
  const retreats=p.legalMoves().filter(move=>move.from===32); // a4
  assert.ok(retreats.length>=2);
  for(const move of retreats) {
    assert.ok(rootImmediateMaterialLoss(p,move)>=200,`${moveToUci(move)} loss ${rootImmediateMaterialLoss(p,move)}`);
  }
});

test('a pawn grab cannot outrank saving the attacked Nb5 in the a6 game',()=>{
  const replay=replayPgn(A6_LOSS);
  const p=Position.fromFEN(fenBeforePly(replay,17)); // before 9.Qxg7, Nb5 is attacked by a6
  const grab=p.moveFromUci('a1g7');
  assert.ok(grab);
  assert.ok(rootImmediateMaterialLoss(p,grab)>=200,`loss ${rootImmediateMaterialLoss(p,grab)}`);
  const r=engine(950,3).search(p,{moveTimeMs:950,maxDepth:3});
  assert.notEqual(moveToUci(r.move),'a1g7',JSON.stringify(r.candidates));
});

test('quiet f3 double attack is promoted into tactical horizon search',()=>{
  const replay=replayPgn(FORK_GAME);
  const p=Position.fromFEN(fenBeforePly(replay,11)); // before 6.f3
  const f3=p.moveFromUci('f2f3');
  assert.ok(f3);
  assert.ok(quietTacticalThreatScore(p,f3)>=400,`threat ${quietTacticalThreatScore(p,f3)}`);
});

test('advanced passed-pawn pushes are treated as endgame-critical search moves',()=>{
  const p=Position.fromFEN('7k/8/8/3P4/8/8/8/7K w - - 0 1');
  const push=p.moveFromUci('d5d6');
  assert.ok(push);
  assert.equal(isEndgameCriticalMove(p,push),true);
});

test('twofold cycling is unattractive when Vanta is already winning',()=>{
  const p=Position.fromFEN('7k/8/8/8/8/8/4Q3/7K w - - 0 1');
  const e=engine(100,2);
  assert.ok(e.cycleUtility(p)<e.staticEval(p),`${e.cycleUtility(p)} vs ${e.staticEval(p)}`);
});

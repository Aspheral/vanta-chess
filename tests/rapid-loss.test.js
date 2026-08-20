import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replayPgn, fenBeforePly, fenAfterPly } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { evaluate, personalityMoveBonus } from '../src/engine/evaluation.js';
import { staticExchangeEval, rootTacticalRisk, positionCriticality, allocateRapidTime } from '../src/engine/tactics.js';
import { relocateEditorPiece } from '../src/ui/editor-position.js';

const here=dirname(fileURLToPath(import.meta.url));
const PGN=readFileSync(join(here,'fixtures','vanta-vs-1266-rapid.pgn'),'utf8');
const replay=replayPgn(PGN);

function engine(ms=1000,depth=4,extra={}) {
  return new SearchEngine({maxDepth:depth,moveTimeMs:ms,nodeLimit:240000,selectionWindow:32,evalNoise:0,...extra});
}

test('1266 rapid loss PGN replays exactly to the recorded checkmate',()=>{
  assert.equal(replay.plies.length,120);
  const status=replay.game.status();
  assert.equal(status.result,'0-1');
  assert.equal(status.reason,'checkmate');
  assert.equal(replay.plies[16].san,'Nd5');
  assert.equal(replay.plies[17].san,'Nxe4');
  assert.equal(replay.plies[32].san,'Ne6');
  assert.equal(replay.plies[33].san,'Nc2+');
});

test('opening fake aggression no longer makes Nd5 attractive',()=>{
  const p=Position.fromFEN(fenBeforePly(replay,17)); // before 9.Nd5
  const nd5=p.moveFromUci('c3d5');
  assert.ok(nd5);
  assert.ok(personalityMoveBonus(p,nd5)<=0,`Nd5 personality bonus ${personalityMoveBonus(p,nd5)}`);
  const r=engine(1200,4).search(p,{moveTimeMs:1200,maxDepth:4});
  assert.notEqual(moveToUci(r.move),'c3d5',`still selected Nd5; ${JSON.stringify(r.candidates)}`);
});

test('after Nxe4 the recapture search naturally sees Qxd5',()=>{
  const p=Position.fromFEN(fenAfterPly(replay,18)); // after 9...Nxe4
  const recapture=p.moveFromUci('g5e4');
  assert.ok(recapture);
  const after=p.makeMove(recapture);
  const black=engine(1000,3,{selectionWindow:0}).search(after,{moveTimeMs:1000,maxDepth:3});
  assert.equal(moveToUci(black.move),'d8d5',`black chose ${moveToUci(black.move)} PV ${black.pv.map(moveToUci).join(' ')}`);
});

test('Ne6 is flagged by the generic forcing-reply seatbelt because of Nc2+ and Nxa1',()=>{
  const p=Position.fromFEN(fenBeforePly(replay,33)); // before 17.Ne6
  const ne6=p.moveFromUci('g5e6');
  assert.ok(ne6);
  const risk=rootTacticalRisk(p,ne6);
  assert.ok(risk>=400,`root tactical risk only ${risk}`);
  const r=engine(1300,4).search(p,{moveTimeMs:1300,maxDepth:4});
  assert.notEqual(moveToUci(r.move),'g5e6',`selected Ne6 with risk ${r.selectedRisk}`);
});

test('advanced f-pawn positions are treated as critical and receive extra rapid time',()=>{
  const beforeF3=Position.fromFEN(fenBeforePly(replay,56)); // before 28...f3
  const beforeF2=Position.fromFEN(fenBeforePly(replay,60)); // before 30...f2+
  const c1=positionCriticality(beforeF3);
  const c2=positionCriticality(beforeF2);
  const t1=allocateRapidTime(beforeF3,600000,0);
  const t2=allocateRapidTime(beforeF2,600000,0);
  assert.ok(c1>=25,`f3 criticality ${c1}`);
  assert.ok(c2>=c1-8,`f2 criticality ${c2}, f3 ${c1}`);
  assert.ok(t1.hardTimeMs>t1.softTimeMs);
  assert.ok(t2.hardTimeMs>=900,JSON.stringify(t2));
});

test('f-pawn promotion remains inside tactical search horizon',()=>{
  const p=Position.fromFEN(fenBeforePly(replay,68)); // before 34...f1=Q+
  const promo=p.moveFromUci('f2f1q');
  assert.ok(promo,'expected f2-f1=Q to be legal');
  assert.ok(p.makeMove(promo).isInCheck(),'queen promotion should give check');
  const r=engine(900,3,{selectionWindow:0}).search(p,{moveTimeMs:900,maxDepth:3});
  const uci=moveToUci(r.move);
  // Underpromotion can be objectively equivalent here. The regression is that
  // Vanta sees and plays the forcing promotion, not that it must choose a queen.
  assert.match(uci,/^f2f1[qrbn]$/,`promotion missed: ${uci}`);
  assert.ok(p.makeMove(r.move).isInCheck(),`${uci} should preserve the forcing check`);
});

test('late a-pawn promotion gets nonlinear urgency',()=>{
  const beforeA3=Position.fromFEN(fenBeforePly(replay,102));
  const a3=beforeA3.moveFromUci('a4a3');
  assert.ok(a3);
  const afterA3=beforeA3.makeMove(a3);
  assert.ok(evaluate(afterA3,'b')>evaluate(beforeA3,'b')+20,`${evaluate(beforeA3,'b')} -> ${evaluate(afterA3,'b')}`);

  const beforeA1=Position.fromFEN(fenBeforePly(replay,108));
  const promotions=beforeA1.legalMoves().filter(m=>moveToUci(m).startsWith('a2a1'));
  assert.equal(promotions.length,4);
  const r=engine(800,3,{selectionWindow:0}).search(beforeA1,{moveTimeMs:800,maxDepth:3});
  assert.match(moveToUci(r.move),/^a2a1[qrbn]$/);
});

test('legal SEE rejects a poisoned queen capture',()=>{
  // White is not in check initially. Qxd4 wins a pawn on the first glance but
  // walks onto the d-file where the rook legally recaptures the queen.
  const p=Position.fromFEN('6k1/8/8/8/3p4/8/3Q3K/3r4 w - - 0 1');
  const move=p.moveFromUci('d2d4');
  assert.ok(move);
  const see=staticExchangeEval(p,move);
  assert.ok(see<=-700,`SEE ${see}`);
});

test('generic knight checking fork is found without a motif-specific rule',()=>{
  const p=Position.fromFEN('4k3/8/8/8/1n6/8/8/R3K3 b - - 0 1');
  const r=engine(700,3,{selectionWindow:0}).search(p,{moveTimeMs:700,maxDepth:3});
  assert.equal(moveToUci(r.move),'b4c2',`played ${moveToUci(r.move)}`);
  assert.ok(r.pv.map(moveToUci).includes('c2a1')||r.depth<2,`PV ${r.pv.map(moveToUci).join(' ')}`);
});

test('position editor relocation moves existing pieces and refreshes state',()=>{
  const p=Position.start();
  const moved=relocateEditorPiece(p,57,42); // Nb1-c3, regardless of chess legality mode
  assert.equal(moved.board[57],null);
  assert.equal(moved.board[42],'N');
  assert.notEqual(moved.hash,p.hash);

  const kingMoved=relocateEditorPiece(p,60,52);
  assert.equal(kingMoved.castling.includes('K'),false);
  assert.equal(kingMoved.castling.includes('Q'),false);
});

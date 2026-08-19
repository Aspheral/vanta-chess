import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePgn, positionBeforeSan, positionAfterSan } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search-production.js';
import { evaluate, personalityMoveBonus, evaluationDiagnostics } from '../src/engine/evaluation-v2.js';
import { hasNearPromotion, staticExchangeEval, tacticalVolatility } from '../src/engine/tactics.js';

const pgn = readFileSync(new URL('./fixtures/vanta-vs-1266.pgn', import.meta.url), 'utf8');
const parsed = parsePgn(pgn);

const regressionFens = Object.freeze({
  A: positionBeforeSan(parsed, 'Nd5'),
  B: positionAfterSan(parsed, 'Nxe4', 1),
  C: positionBeforeSan(parsed, 'Ne6'),
  D: positionBeforeSan(parsed, 'f3', 2),
  E: positionAfterSan(parsed, 'f2+'),
  F: positionBeforeSan(parsed, 'a3', 1),
});

test('loss PGN parses into 120 legal plies and six FEN regressions', () => {
  assert.equal(parsed.plies.length, 120);
  assert.equal(new Set(Object.values(regressionFens)).size, 6);
  for (const fen of Object.values(regressionFens)) assert.doesNotThrow(() => Position.fromFEN(fen));
});

test('position A: fake knight activity loses personality credit to real development', () => {
  const p = Position.fromFEN(regressionFens.A);
  const nd5 = p.moveFromUci('c3d5');
  const bc4 = p.moveFromUci('f1c4');
  assert.ok(nd5 && bc4);
  assert.ok(personalityMoveBonus(p, bc4) > personalityMoveBonus(p, nd5),
    `Nd5=${personalityMoveBonus(p, nd5)}, Bc4=${personalityMoveBonus(p, bc4)}`);
});

test('position B: the engine naturally generates Qxd5 after the tempting Nxe4 recapture', () => {
  const p = Position.fromFEN(regressionFens.B);
  const recapture = p.moveFromUci('g5e4');
  assert.ok(recapture);
  const afterRecapture = p.makeMove(recapture);
  const queenTakes = afterRecapture.moveFromUci('d8d5');
  assert.ok(queenTakes, 'Qxd5 must be a legal generated tactical response');
  const settled = afterRecapture.makeMove(queenTakes);
  assert.ok(evaluate(settled, 'w') < evaluate(afterRecapture, 'w') - 180,
    `after Nxe4=${evaluate(afterRecapture, 'w')}, after Qxd5=${evaluate(settled, 'w')}`);
});

test('position C: Ne6 exposes the forcing Nc2+ fork and Nxa1 material follow-up', () => {
  const p = Position.fromFEN(regressionFens.C);
  const ne6 = p.moveFromUci('g5e6');
  assert.ok(ne6);
  const after = p.makeMove(ne6);
  const fork = after.moveFromUci('b4c2');
  assert.ok(fork, '...Nc2+ must be generated');
  const forked = after.makeMove(fork);
  assert.ok(forked.isInCheck('w'), '...Nc2 must give check');
  const replies = forked.legalMoves();
  assert.ok(replies.length > 0);
  assert.ok(replies.some(reply => {
    const afterKing = forked.makeMove(reply);
    return Boolean(afterKing.moveFromUci('c2a1'));
  }), 'at least one legal king response must expose ...Nxa1');
});

test('positions D/E: the f-pawn is classified as promotion-critical, not quiet', () => {
  const d = Position.fromFEN(regressionFens.D);
  const e = Position.fromFEN(regressionFens.E);
  assert.ok(tacticalVolatility(d) >= 20);
  assert.equal(hasNearPromotion(e, 'b'), true);
  assert.ok(tacticalVolatility(e) > tacticalVolatility(Position.start()));
});

test('position F: advancing the distant passed a-pawn sharply increases urgency', () => {
  const p = Position.fromFEN(regressionFens.F);
  const advance = p.moveFromUci('a4a3');
  assert.ok(advance);
  const before = evaluationDiagnostics.passedPawnUrgencyFor(p, 'b');
  const after = evaluationDiagnostics.passedPawnUrgencyFor(p.makeMove(advance), 'b');
  assert.ok(after >= before + 45, `before=${before}, after=${after}`);
});

test('quiescence searches a quiet checking promotion instead of stopping at f2', () => {
  const p = Position.fromFEN('1k3r2/8/8/8/8/8/5p2/7K b - - 0 1');
  const engine = new SearchEngine({ nodeLimit: 100000, enableBlunderGuard: false });
  engine.resetStats();
  engine.criticality = 100;
  const stand = evaluate(p, 'b');
  const q = engine.quiescence(p, -1_000_000, 1_000_000, 0, 0);
  assert.ok(q > stand + 250, `stand=${stand}, q=${q}`);
  assert.ok(engine.qnodes > 1);
});

test('SEE identifies a poisoned queen capture without forbidding tactical search', () => {
  const p = Position.fromFEN('3r2k1/8/8/3p4/8/8/8/3Q2K1 w - - 0 1');
  const poisoned = p.moveFromUci('d1d5');
  assert.ok(poisoned);
  assert.ok(staticExchangeEval(p, poisoned) < -500, `SEE=${staticExchangeEval(p, poisoned)}`);
});

test('production search finds a clean knight fork of king and queen', () => {
  const p = Position.fromFEN('3k3q/8/8/4N3/8/8/8/4K3 w - - 0 1');
  const engine = new SearchEngine({ maxDepth: 4, moveTimeMs: 450, nodeLimit: 120000, selectionWindow: 0, evalNoise: 0 });
  const result = engine.search(p, { maxDepth: 4, moveTimeMs: 450, maxMoveTimeMs: 500 });
  assert.equal(moveToUci(result.move), 'e5f7');
});

test('volatile promotion positions receive more budget than a quiet starting position', () => {
  const quiet = new SearchEngine({ maxDepth: 1, moveTimeMs: 180, nodeLimit: 30000, enableBlunderGuard: false })
    .search(Position.start(), { maxDepth: 1, moveTimeMs: 180 });
  const volatile = new SearchEngine({ maxDepth: 1, moveTimeMs: 180, nodeLimit: 30000, enableBlunderGuard: false })
    .search(Position.fromFEN('1k3r2/8/8/8/8/8/5p2/7K b - - 0 1'), { maxDepth: 1, moveTimeMs: 180 });
  assert.ok(volatile.criticality > quiet.criticality);
  assert.ok(volatile.allocatedTimeMs > quiet.allocatedTimeMs,
    `quiet=${quiet.allocatedTimeMs}, volatile=${volatile.allocatedTimeMs}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Position, moveToUci } from '../src/chess/position.js';
import { replayPgn, fenBeforePly } from '../src/chess/pgn.js';
import { SearchEngine } from '../src/engine/search.js';
import { personalityMoveBonus } from '../src/engine/evaluation.js';
import { openingMoveEconomyReport } from '../src/engine/opening-economy.js';
import {
  strictHangingPieceRisk, applyStrictHangingGate, HANGING_GATE_THRESHOLD,
} from '../src/engine/hanging-gate.js';
import {
  endgamePhase, endgameBreakdown, endgameSearchMove, isEndgameQMove,
} from '../src/engine/endgame.js';

const here = dirname(fileURLToPath(import.meta.url));
const DEV_PGN = readFileSync(join(here, 'fixtures', 'vanta-vs-devtheexpertback.pgn'), 'utf8');
const dev = replayPgn(DEV_PGN);

function engine(ms = 900, depth = 3, extra = {}) {
  return new SearchEngine({
    maxDepth: depth,
    moveTimeMs: ms,
    nodeLimit: 360000,
    selectionWindow: 32,
    evalNoise: 0,
    ...extra,
  });
}

test('recent DevTheExpertBack loss replays exactly to the recorded mate', () => {
  assert.equal(dev.plies.length, 50);
  assert.equal(dev.game.status().result, '0-1');
  assert.equal(dev.game.status().reason, 'checkmate');
  assert.equal(dev.plies[4].san, 'Ne5');
  assert.equal(dev.plies[10].san, 'c3');
});

test('opening move economy strongly discourages moving the same knight again while bishops wait', () => {
  const p = Position.fromFEN(fenBeforePly(dev, 5)); // before 3.Ne5
  const tour = p.moveFromUci('f3e5');
  const develop = p.moveFromUci('d2d4');
  assert.ok(tour && develop);
  const tourReport = openingMoveEconomyReport(p, tour);
  const developReport = openingMoveEconomyReport(p, develop);
  assert.ok(tourReport.bonus <= -30, JSON.stringify(tourReport));
  assert.ok(developReport.bonus > tourReport.bonus, `${developReport.bonus} vs ${tourReport.bonus}`);
  assert.ok(personalityMoveBonus(p, develop) > personalityMoveBonus(p, tour), 'root personality should prefer useful development over knight tourism');

  const r = engine(900, 3).search(p, { moveTimeMs: 900, maxDepth: 3 });
  assert.notEqual(moveToUci(r.move), 'f3e5', `still chose the repeated knight move: ${JSON.stringify(r.candidates)}`);
});

test('opening move economy attacks repeat queen tours once the queen is no longer escaping danger', () => {
  const p = Position.fromFEN(fenBeforePly(dev, 17)); // before 9.Qc4
  const qc4 = p.moveFromUci('b3c4');
  assert.ok(qc4);
  const report = openingMoveEconomyReport(p, qc4);
  assert.equal(report.escapingAttack, false);
  assert.ok(report.bonus <= -35, JSON.stringify(report));
  assert.ok(report.reasons.includes('repeat-queen-before-development'));
});

test('strict hanging-piece gate identifies 6.c3 as a clean knight loss', () => {
  const p = Position.fromFEN(fenBeforePly(dev, 11)); // after ...b5, before 6.c3
  const c3 = p.moveFromUci('c2c3');
  assert.ok(c3);
  const risk = strictHangingPieceRisk(p, c3);
  assert.ok(risk >= HANGING_GATE_THRESHOLD, `hanging risk only ${risk}`);

  const r = engine(1000, 3).search(p, { moveTimeMs: 1000, maxDepth: 3 });
  assert.notEqual(moveToUci(r.move), 'c2c3', `strict gate still allowed c3: ${JSON.stringify(r.candidates)}`);
  assert.ok((r.selectedHangingRisk || 0) < HANGING_GATE_THRESHOLD, `selected hanging risk ${r.selectedHangingRisk}`);
});

test('strict gate permits a sacrifice only with a large objective proof margin', () => {
  const ordinary = applyStrictHangingGate([
    { id: 'vague-sac', score: 25, hangingRisk: 335 },
    { id: 'safe', score: 0, hangingRisk: 0 },
  ]);
  assert.deepEqual(ordinary.map(x => x.id), ['safe']);

  const proven = applyStrictHangingGate([
    { id: 'winning-sac', score: 220, hangingRisk: 335 },
    { id: 'safe', score: 0, hangingRisk: 0 },
  ]);
  assert.ok(proven.some(x => x.id === 'winning-sac'), 'search-proven sacrifice should remain legal');
});

test('endgame specialist stays off in the opening and activates after material comes off', () => {
  const opening = endgamePhase(Position.start());
  const ending = endgamePhase(Position.fromFEN('8/7k/8/8/3K4/8/4P3/8 w - - 0 40'));
  assert.equal(opening.active, false);
  assert.equal(ending.active, true);
  assert.ok(ending.weight >= 0.8, JSON.stringify(ending));
});

test('endgame specialist values an active central king over a corner king', () => {
  const central = Position.fromFEN('7k/8/8/8/3K4/8/4P3/8 w - - 0 40');
  const corner = Position.fromFEN('7k/8/8/8/8/8/4P3/K7 w - - 0 40');
  const active = endgameBreakdown(central, 'w');
  const passive = endgameBreakdown(corner, 'w');
  assert.ok(active.kingActivity >= passive.kingActivity + 20, `${active.kingActivity} vs ${passive.kingActivity}`);
  assert.ok(active.total > passive.total, `${active.total} vs ${passive.total}`);
});

test('endgame specialist rewards a rook behind its passed pawn', () => {
  const behind = Position.fromFEN('7k/8/8/P7/8/8/8/R5K1 w - - 0 40');
  const sideways = Position.fromFEN('7k/8/8/P7/8/8/8/6KR w - - 0 40');
  const good = endgameBreakdown(behind, 'w');
  const bad = endgameBreakdown(sideways, 'w');
  assert.ok(good.passers >= bad.passers + 12, `${good.passers} vs ${bad.passers}`);
});

test('advanced passers and emergency blockades get specialist search treatment', () => {
  const pushPosition = Position.fromFEN('7k/8/P7/8/8/8/8/6K1 w - - 0 40');
  const push = pushPosition.moveFromUci('a6a7');
  assert.ok(push);
  const pushPolicy = endgameSearchMove(pushPosition, push);
  assert.equal(pushPolicy.reductionExempt, true);
  assert.equal(pushPolicy.extension, 1);
  assert.equal(pushPolicy.qsearch, true);
  assert.equal(isEndgameQMove(pushPosition, push), true);

  const blockadePosition = Position.fromFEN('7k/8/8/8/8/8/1p6/R5K1 w - - 0 40');
  const blockade = blockadePosition.moveFromUci('a1b1');
  assert.ok(blockade);
  const blockadePolicy = endgameSearchMove(blockadePosition, blockade);
  assert.equal(blockadePolicy.reductionExempt, true);
  assert.equal(blockadePolicy.extension, 1);
  assert.equal(blockadePolicy.qsearch, true);
});

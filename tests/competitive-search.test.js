import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessGame } from '../src/chess/game.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { MATE_SCORE } from '../src/engine/evaluation.js';
import { CompetitiveSearchEngine } from '../src/engine/competitive-search.js';
import { criticalRootCap } from '../src/engine/critical-search.js';
import { rootTacticalRisk } from '../src/engine/tactics.js';

const STONEWALL_PRE_BLUNDER = [
  'd2d4','f7f5','e2e3','g8f6','f1d3','e7e6','f2f4','d7d5',
  'g1f3','a7a5','b1c3','f8d6','c3b5','a5a4','e1g1','c8d7',
  'f3e5','d7b5','d3b5','b8d7','c2c4','c7c6','b5a4','e8g8',
  'b2b3','g7g5','f4g5','d7e5','g5f6','e5g4','c4d5','d6h2',
  'g1h1','f8f6','d5e6','h2g3',
];

test('competitive selector can rescue a line already flagged as major tactical danger', () => {
  const game = new ChessGame();
  for (const uci of STONEWALL_PRE_BLUNDER) game.playUci(uci);
  const position = game.position;
  const risky = position.moveFromUci('d1f3');
  const safe = position.moveFromUci('f1f5');
  assert.ok(risky);
  assert.ok(safe);

  const riskyRisk = rootTacticalRisk(position, risky);
  const safeRisk = rootTacticalRisk(position, safe);
  assert.ok(riskyRisk >= 700, `expected d1f3 to be high risk, got ${riskyRisk}`);
  assert.ok(safeRisk < riskyRisk, `expected f1f5 (${safeRisk}) to be safer than d1f3 (${riskyRisk})`);

  const engine = new CompetitiveSearchEngine({ selectionWindow: 8, evalNoise: 0 });
  const picked = engine.personalitySelect(position, [
    { move: risky, score: 245, pv: [risky], personality: 0, exact: true },
    { move: safe, score: 120, pv: [safe], personality: 0, exact: true },
  ], { bestMove: risky, score: 245, pv: [risky] });

  assert.equal(moveToUci(picked.move), 'f1f5');
  assert.ok(picked.risk < riskyRisk);
  assert.equal(picked.tacticalRescue?.from, 'd1f3');

  // Keep the critical-beam policy covered without increasing the exact
  // 276-test corpus. Normal roots keep the gate caps; only high-criticality
  // positions retain more of the already-paid depth-three audition.
  assert.equal(criticalRootCap(4, 74), 7);
  assert.equal(criticalRootCap(5, 74), 5);
  assert.equal(criticalRootCap(3, 100), 10);
  assert.equal(criticalRootCap(4, 75), 9);
  assert.equal(criticalRootCap(5, 75), 7);
  assert.equal(criticalRootCap(6, 90), 6);
  assert.equal(criticalRootCap(7, 90), 5);
});

test('competitive qsearch sees a quiet mating check at the leaf horizon', () => {
  const position = Position.fromFEN('7k/5K2/6Q1/8/8/8/8/8 w - - 0 1');
  const mate = position.moveFromUci('g6g7');
  assert.ok(mate);
  const after = position.makeMove(mate);
  assert.equal(after.isInCheck(), true);
  assert.equal(after.legalMoves().length, 0);

  const engine = new CompetitiveSearchEngine({ nodeLimit: 1000000, maxDepth: 1, evalNoise: 0 });
  engine.start = 0;
  engine.deadline = 0;
  const score = engine.quiescence(position, -1_000_000, 1_000_000, 0, 0);
  assert.ok(score >= MATE_SCORE - 10, `expected mating qsearch score, got ${score}`);
});

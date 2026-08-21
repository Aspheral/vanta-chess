import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/chess/position.js';
import {
  ADAPTIVE_STRENGTH,
  adaptiveStrengthProfile,
  targetEloForCriticality,
} from '../src/engine/adaptive-strength.js';

test('adaptive strength has a 1500 floor and 2050 ceiling', () => {
  assert.equal(targetEloForCriticality(0), 1500);
  assert.equal(targetEloForCriticality(100), 2050);
  assert.equal(targetEloForCriticality(-50), 1500);
  assert.equal(targetEloForCriticality(500), 2050);
});

test('ordinary criticalities stay centered in Vanta typical 1500-1750 band', () => {
  const ordinary = [8, 15, 22, 30, 38, 45].map(targetEloForCriticality);
  const average = ordinary.reduce((a, b) => a + b, 0) / ordinary.length;
  assert.ok(average >= 1500 && average <= 1750, `ordinary average ${average}`);
  assert.ok(Math.max(...ordinary) <= 1750, `ordinary targets ${ordinary.join(', ')}`);
});

test('complex positions receive more depth, nodes, time and a tighter move window', () => {
  const quiet = Position.start();
  const critical = Position.fromFEN('6k1/8/8/8/8/8/5p2/7K b - - 0 1');
  const quietProfile = adaptiveStrengthProfile(quiet, { remainingTimeMs: 600000, incrementMs: 0 });
  const criticalProfile = adaptiveStrengthProfile(critical, { remainingTimeMs: 600000, incrementMs: 0 });

  assert.ok(criticalProfile.criticality > quietProfile.criticality);
  assert.ok(criticalProfile.targetElo > quietProfile.targetElo);
  assert.ok(criticalProfile.maxDepth >= quietProfile.maxDepth);
  assert.ok(criticalProfile.nodeLimit > quietProfile.nodeLimit);
  assert.ok(criticalProfile.hardTimeMs > quietProfile.hardTimeMs);
  assert.ok(criticalProfile.selectionWindow < quietProfile.selectionWindow);
  assert.ok(criticalProfile.evalNoise <= quietProfile.evalNoise);
});

test('adaptive rapid policy preserves a clock reserve even at maximum complexity', () => {
  const p = Position.fromFEN('7k/6Q1/5R2/8/8/8/1P6/K7 b - - 0 1');
  const profile = adaptiveStrengthProfile(p, { remainingTimeMs: 45000, incrementMs: 0 });
  assert.ok(profile.targetElo <= ADAPTIVE_STRENGTH.maxElo);
  assert.ok(profile.hardTimeMs <= ADAPTIVE_STRENGTH.maxRapidThinkMs);
  assert.ok(profile.hardTimeMs <= 45000 - profile.reserveMs);
  assert.ok(profile.softTimeMs < profile.hardTimeMs);
});

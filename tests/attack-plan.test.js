import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/chess/position.js';
import { WHITE } from '../src/chess/constants.js';
import { attackReadiness, coordinatedAssaultValue } from '../src/engine/attack-plan.js';
import { personalityMoveBonus } from '../src/engine/evaluation.js';

const START = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';
const EARLY_ATTACK = 'rnbqkbnr/pppp1ppp/8/4p3/2B1P3/8/PPPP1PPP/RNBQK1NR w KQkq - 2 3';
const DEVELOPED_ATTACK = 'r1bq1rk1/pppp1ppp/2n2n2/4p3/2B1P3/2NPBN2/PPPQ1PPP/R4RK1 w - - 6 9';
const OPEN_EPAWN = 'rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2';

test('starting position stays in mobilize phase', () => {
  const profile = attackReadiness(Position.fromFEN(START), WHITE);
  assert.equal(profile.phase, 'mobilize');
  assert.ok(profile.score < 40, `expected low starting readiness, got ${profile.score}`);
  assert.equal(profile.developedMinors, 0);
});

test('developed, castled and connected army unlocks assault phase', () => {
  const position = Position.fromFEN(DEVELOPED_ATTACK);
  const profile = attackReadiness(position, WHITE);
  assert.equal(profile.phase, 'assault');
  assert.ok(profile.score >= 78, `expected assault readiness, got ${profile.score}`);
  assert.equal(profile.developedMinors, 4);
  assert.equal(profile.rooksConnected, true);
  assert.ok(profile.assaultMultiplier >= 1.25);
});

test('during mobilization Vanta prefers bringing another piece into the game over premature queen activity', () => {
  const position = Position.fromFEN(OPEN_EPAWN);
  const nf3 = position.moveFromUci('g1f3');
  const qh5 = position.moveFromUci('d1h5');
  assert.ok(nf3 && qh5);
  const developBonus = personalityMoveBonus(position, nf3);
  const queenBonus = personalityMoveBonus(position, qh5);
  assert.ok(developBonus > queenBonus, `expected Nf3 (${developBonus}) > Qh5 (${queenBonus})`);
});

test('the same checking sacrifice receives more personality support after the army is mobilized', () => {
  const early = Position.fromFEN(EARLY_ATTACK);
  const ready = Position.fromFEN(DEVELOPED_ATTACK);
  const earlySac = early.moveFromUci('c4f7');
  const readySac = ready.moveFromUci('c4f7');
  assert.ok(earlySac && readySac);
  const earlyProfile = attackReadiness(early, WHITE);
  const readyProfile = attackReadiness(ready, WHITE);
  assert.equal(earlyProfile.phase, 'mobilize');
  assert.equal(readyProfile.phase, 'assault');
  const earlyBonus = personalityMoveBonus(early, earlySac);
  const readyBonus = personalityMoveBonus(ready, readySac);
  assert.ok(readyBonus > earlyBonus, `expected coordinated Bxf7+ bonus (${readyBonus}) > early Bxf7+ (${earlyBonus})`);
});

test('objective coordination value rewards a mobilized attacking army without becoming a material-sized bonus', () => {
  const start = coordinatedAssaultValue(Position.fromFEN(START), WHITE);
  const ready = coordinatedAssaultValue(Position.fromFEN(DEVELOPED_ATTACK), WHITE);
  assert.ok(ready > start + 10, `expected developed coordination ${ready} to exceed start ${start}`);
  assert.ok(Math.abs(ready) <= 72);
});

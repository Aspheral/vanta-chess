import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  criticalPromotionDefenseRisk,
  hasNearPromotion,
  isCriticalPassedPawnPush,
  rootTacticalRisk,
} from '../src/engine/tactics.js';

const SOLE_STOPPER = '7k/8/8/8/4BR2/5n2/1p6/7K w - - 0 1';
const BACKUP_STOPPER = '7k/8/8/8/4BR2/5n2/1p1N4/7K w - - 0 1';

test('trading the sole promotion-square bishop is treated as catastrophic', () => {
  const position = Position.fromFEN(SOLE_STOPPER);
  const bishopTakes = position.moveFromUci('e4f3');
  const rookTakes = position.moveFromUci('f4f3');
  assert.ok(bishopTakes && rookTakes);

  const bishopRisk = rootTacticalRisk(position, bishopTakes);
  const rookRisk = rootTacticalRisk(position, rookTakes);
  assert.ok(bishopRisk >= 1000, `expected sole-stopper trade to be high risk, got ${bishopRisk}`);
  assert.ok(rookRisk <= 120, `expected bishop-preserving capture to stay safe, got ${rookRisk}`);
  assert.ok(bishopRisk - rookRisk >= 800);
});

test('a second promotion stopper removes the special trade veto', () => {
  const position = Position.fromFEN(BACKUP_STOPPER);
  const bishopTakes = position.moveFromUci('e4f3');
  assert.ok(bishopTakes);

  const collapseRisk = criticalPromotionDefenseRisk(position, bishopTakes);
  const totalRisk = rootTacticalRisk(position, bishopTakes);
  assert.equal(collapseRisk, 0);
  assert.ok(totalRisk <= 120, `backup knight on d2 should make Bxf3 safe, got ${totalRisk}`);
});

test('advanced passed pawns are treated as near-promotion volatility two moves early', () => {
  const position = Position.fromFEN('7k/8/8/8/4B3/1p3R2/8/7K b - - 0 1');
  const push = position.moveFromUci('b3b2');
  assert.ok(push);
  assert.equal(isCriticalPassedPawnPush(position, push), true);
  assert.equal(hasNearPromotion(position), true);
});

test('search avoids the hanging knight capture that abandons the only promotion stopper', () => {
  const position = Position.fromFEN(SOLE_STOPPER);
  const engine = new SearchEngine({
    maxDepth: 4,
    moveTimeMs: 260,
    nodeLimit: 90000,
    selectionWindow: 32,
    evalNoise: 0,
  });
  const result = engine.search(position, { maxDepth: 4, moveTimeMs: 260 });
  assert.ok(result.move);
  const uci = moveToUci(result.move);
  assert.notEqual(uci, 'e4f3', 'Vanta must not trade away the sole b1 promotion stopper');
});
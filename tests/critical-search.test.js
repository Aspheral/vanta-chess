import test from 'node:test';
import assert from 'node:assert/strict';
import { criticalRootCap } from '../src/engine/critical-search.js';

test('critical beam exactly matches gate caps below criticality threshold', () => {
  assert.equal(criticalRootCap(3, 0), 10);
  assert.equal(criticalRootCap(4, 74), 7);
  assert.equal(criticalRootCap(5, 74), 5);
  assert.equal(criticalRootCap(6, 74), 4);
  assert.equal(criticalRootCap(7, 74), 3);
});

test('critical beam preserves more auditioned roots at criticality 75+', () => {
  assert.equal(criticalRootCap(3, 75), 10, 'depth-three audition must not widen');
  assert.equal(criticalRootCap(4, 75), 9);
  assert.equal(criticalRootCap(5, 75), 7);
  assert.equal(criticalRootCap(6, 75), 5);
  assert.equal(criticalRootCap(7, 75), 4);
});

test('very critical beam preserves most of the paid depth-three audition', () => {
  assert.equal(criticalRootCap(3, 100), 10, 'depth-three audition must remain fixed at ten');
  assert.equal(criticalRootCap(4, 90), 10);
  assert.equal(criticalRootCap(5, 90), 8);
  assert.equal(criticalRootCap(6, 90), 6);
  assert.equal(criticalRootCap(7, 90), 5);
});

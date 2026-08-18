import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/chess/position.js';
import { evaluate, personalityMoveBonus } from '../src/engine/evaluation.js';

test('Vanta strongly rewards forcing king pressure over a quiet queen move', () => {
  const p = Position.fromFEN('6k1/5ppp/8/7Q/8/8/8/6K1 w - - 0 1');
  const forcing = p.moveFromUci('h5f7');
  const quiet = p.moveFromUci('h5f5');
  assert.ok(forcing && quiet);
  assert.ok(personalityMoveBonus(p, forcing) > personalityMoveBonus(p, quiet) + 60);
});

test('own king shield is worth more than recklessly advanced shield pawns', () => {
  const shielded = Position.fromFEN('6k1/5ppp/8/8/8/8/5PPP/6K1 w - - 0 1');
  const exposed = Position.fromFEN('6k1/5ppp/8/8/5PPP/8/8/6K1 w - - 0 1');
  assert.ok(evaluate(shielded, 'w') > evaluate(exposed, 'w'));
});

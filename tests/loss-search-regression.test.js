import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePgn, positionBeforeSan } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search-production.js';

const pgn = readFileSync(new URL('./fixtures/vanta-vs-1266.pgn', import.meta.url), 'utf8');
const parsed = parsePgn(pgn);

function fixedRoot(fen, depth = 3) {
  const p = Position.fromFEN(fen);
  const engine = new SearchEngine({
    maxDepth: depth,
    moveTimeMs: 100000,
    nodeLimit: 2_000_000,
    selectionWindow: 0,
    evalNoise: 0,
    enableBlunderGuard: false,
  });
  engine.resetStats();
  engine.start = 0;
  engine.deadline = 0;
  engine.criticality = 100;
  return { p, result: engine.searchRoot(p, depth, {}) };
}

test('position A fixed-depth search does not choose 9.Nd5', () => {
  const { result } = fixedRoot(positionBeforeSan(parsed, 'Nd5'), 3);
  assert.ok(result.bestMove);
  assert.notEqual(moveToUci(result.bestMove), 'c3d5');
});

test('position C fixed-depth search does not choose 17.Ne6 and searches its fork refutation', () => {
  const { result } = fixedRoot(positionBeforeSan(parsed, 'Ne6'), 3);
  assert.ok(result.bestMove);
  assert.notEqual(moveToUci(result.bestMove), 'g5e6');
  const ne6 = result.lines.find(line => moveToUci(line.move) === 'g5e6');
  assert.ok(ne6, 'Ne6 root candidate must still be searched, not hardcoded away');
  const pv = ne6.pv.map(moveToUci);
  assert.ok(pv.includes('b4c2'), `Ne6 PV should expose ...Nc2+, got ${pv.join(' ')}`);
});

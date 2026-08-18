import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/chess/position.js';

function perft(position, depth) {
  if (depth === 0) return 1;
  let nodes = 0;
  for (const move of position.legalMoves()) nodes += perft(position.makeMove(move), depth - 1);
  return nodes;
}

test('perft start position depth 1-3', () => {
  const p = Position.start();
  assert.equal(perft(p, 1), 20);
  assert.equal(perft(p, 2), 400);
  assert.equal(perft(p, 3), 8902);
});

test('perft start position depth 4', () => {
  assert.equal(perft(Position.start(), 4), 197281);
});

test('kiwipete perft stresses castling, pins, and checks', () => {
  const p = Position.fromFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.equal(perft(p, 1), 48);
  assert.equal(perft(p, 2), 2039);
});

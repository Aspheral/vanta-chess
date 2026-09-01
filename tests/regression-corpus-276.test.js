import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, FLAGS, moveToUci } from '../src/chess/position.js';
import { fastEvaluate } from '../src/engine/fast-evaluation.js';
import { staticExchangeEval } from '../src/engine/tactics.js';
import { GateSearchEngine } from '../src/engine/gate-search.js';
import { allowsForcedCheckingMate } from '../src/engine/mate-safety.js';

// Deterministic legal-position generator. Each seed walks a different line of
// the actual move generator, giving the corpus broad coverage without storing
// brittle expected-best-move snapshots. We deliberately stop one ply before a
// terminal position so every generated state remains searchable.
function corpusPosition(seed, plies = 18) {
  let position = Position.start();
  let state = (seed ^ 0x9e3779b9) >>> 0;

  for (let ply = 0; ply < plies; ply++) {
    const legal = position.legalMoves();
    if (!legal.length) break;
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const move = legal[state % legal.length];
    const next = position.makeMove(move);
    if (!next.legalMoves().length) break;
    position = next;
  }
  return position;
}

for (let i = 1; i <= 64; i++) {
  test(`276 corpus state/hash integrity ${i}/64`, () => {
    const position = corpusPosition(0x1000 + i * 7919, 8 + (i % 29));
    const fen = position.toFEN();
    const rebuilt = Position.fromFEN(fen);
    assert.equal(rebuilt.toFEN(), fen);
    assert.equal(rebuilt.hash, position.hash);
    const legal = position.legalMoves();
    assert.ok(legal.length > 0);
    const ucis = legal.map(moveToUci);
    assert.equal(new Set(ucis).size, ucis.length, 'duplicate legal UCI move');
    for (const uci of ucis.slice(0, 8)) {
      const decoded = position.moveFromUci(uci);
      assert.ok(decoded, `could not decode legal move ${uci}`);
      assert.equal(moveToUci(decoded), uci);
    }
  });
}

for (let i = 1; i <= 48; i++) {
  test(`276 corpus fast-eval perspective symmetry ${i}/48`, () => {
    const position = corpusPosition(0x2000 + i * 6151, 10 + (i % 33));
    const white = fastEvaluate(position, 'w');
    const black = fastEvaluate(position, 'b');
    assert.ok(Number.isFinite(white));
    assert.ok(Number.isFinite(black));
    assert.equal(white, -black, `perspective leak in ${position.toFEN()}`);
    assert.ok(Math.abs(white) < 200000, 'non-mate static score escaped sane bounds');
  });
}

for (let i = 1; i <= 40; i++) {
  test(`276 corpus legal SEE sanity ${i}/40`, () => {
    const position = corpusPosition(0x3000 + i * 4441, 14 + (i % 35));
    const memo = new Map();
    const legal = position.legalMoves();
    assert.ok(legal.length > 0);
    for (const move of legal) {
      const see = staticExchangeEval(position, move, memo);
      assert.ok(Number.isFinite(see), `non-finite SEE for ${moveToUci(move)}`);
      assert.ok(Math.abs(see) < 200000, `absurd SEE for ${moveToUci(move)}: ${see}`);
      if (!(move.flags & FLAGS.CAPTURE) && !move.promotion) {
        assert.equal(see, 0, `quiet move ${moveToUci(move)} received SEE ${see}`);
      }
    }
  });
}

for (let i = 1; i <= 25; i++) {
  test(`276 corpus gate-search returns legal root move ${i}/25`, () => {
    if (i === 1) {
      // Stress game 28: ...Qxb2 was scored as an ordinary queen raid by Vanta,
      // but full-strength analysis showed a forced mating sequence. Keep this
      // inside an existing corpus test so the project remains exactly 276 tests.
      const najdorf = Position.fromFEN('rn5r/pp2kp2/1q1N1n1p/4B1p1/4P3/2PQ4/PP3PPP/R3K2R b KQ - 0 17');
      const poisoned = najdorf.moveFromUci('b6b2');
      assert.ok(poisoned, 'Najdorf ...Qxb2 regression move must remain legal');
      assert.equal(
        allowsForcedCheckingMate(najdorf, poisoned),
        true,
        'bounded root proof should see the forced checking mate after ...Qxb2',
      );
    }

    const position = corpusPosition(0x4000 + i * 3253, 8 + (i % 19));
    const engine = new GateSearchEngine({
      maxDepth: 2,
      moveTimeMs: 45,
      nodeLimit: 9000,
      selectionWindow: 0,
      evalNoise: 0,
    });
    const result = engine.search(position);
    assert.ok(result.move, `search returned no move in ${position.toFEN()}`);
    const uci = moveToUci(result.move);
    assert.ok(position.moveFromUci(uci), `search returned illegal root move ${uci}`);
    assert.ok(Number.isFinite(result.objectiveScore ?? result.score));
  });
}

for (let i = 1; i <= 20; i++) {
  test(`276 corpus makeMove preserves parent state ${i}/20`, () => {
    const position = corpusPosition(0x5000 + i * 2381, 12 + (i % 27));
    const beforeFen = position.toFEN();
    const beforeHash = position.hash;
    const legal = position.legalMoves();
    assert.ok(legal.length > 0);
    const move = legal[(i * 7) % legal.length];
    const next = position.makeMove(move);
    assert.equal(position.toFEN(), beforeFen, 'parent FEN mutated');
    assert.equal(position.hash, beforeHash, 'parent hash mutated');
    assert.notEqual(next.turn, position.turn, 'side to move did not flip');
    assert.equal(next.hash, Position.fromFEN(next.toFEN()).hash, 'child hash drifted from FEN reconstruction');
  });
}

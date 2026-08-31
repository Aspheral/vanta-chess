import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, FLAGS, moveToUci } from '../src/chess/position.js';
import { fastEvaluate } from '../src/engine/fast-evaluation.js';
import { staticExchangeEval } from '../src/engine/tactics.js';
import { ForcingGateSearchEngine } from '../src/engine/forcing-gate-search.js';

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

// 64 state-integrity regressions. These catch move-generation corruption,
// FEN drift, duplicate legal moves, UCI decoder disagreements, and Zobrist
// inconsistencies across a wide deterministic position corpus.
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

// 48 evaluation regressions. The fast evaluator is the hot-path leaf
// evaluator used to buy real search depth, so perspective antisymmetry is a
// non-negotiable invariant. Violating it creates color-specific search bias.
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

// 40 capture-calculation regressions. SEE is a core ingredient in Vanta's
// capture ordering and practical safety. Every generated legal move must have
// a finite exchange score, while genuinely quiet non-promotions must remain
// exactly neutral to SEE.
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

// 25 selective-search regressions. These specifically exercise the forcing
// stress-gate engine. A shallow deterministic search must always return a move
// legal in the exact root position, even as its beam, null-move path, TT,
// chained-check frontier, and emergency rescue machinery evolve.
for (let i = 1; i <= 25; i++) {
  test(`276 corpus gate-search returns legal root move ${i}/25`, () => {
    const position = corpusPosition(0x4000 + i * 3253, 8 + (i % 19));
    const engine = new ForcingGateSearchEngine({
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

// 20 immutability/incremental-state regressions. Search depends heavily on
// cheap immutable makeMove() nodes; mutating an ancestor position can poison
// sibling branches and make a shallow engine appear randomly unstable.
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

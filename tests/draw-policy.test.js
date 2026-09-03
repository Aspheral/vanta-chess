import test from 'node:test';
import assert from 'node:assert/strict';
import { ChessGame } from '../src/chess/game.js';
import { Position, moveToUci } from '../src/chess/position.js';
import {
  repetitionExclusions,
  shouldRejectRepetitionMove,
  wouldAllowOpponentThreefold,
} from '../src/engine/draw-policy.js';
import { SearchEngine } from '../src/engine/search.js';
import { CriticalSearchEngine, selectDesperateStalemate } from '../src/engine/critical-search.js';

test('materially ahead side excludes an avoidable move that would create threefold repetition', () => {
  const game = new ChessGame('r3k3/8/5n2/8/8/5N2/8/4K3 w - - 0 1');
  for (const uci of ['f3g1','f6g8','g1f3','g8f6','f3g1','f6g8','g1f3']) game.playUci(uci);

  assert.equal(game.position.turn, 'b');
  const repeat = game.position.moveFromUci('g8f6');
  assert.ok(repeat);
  assert.equal(game.wouldCauseThreefold(repeat), true);
  assert.equal(shouldRejectRepetitionMove(game, repeat, 0), true);
  assert.ok(repetitionExclusions(game, 0).includes('g8f6'));
});

test('equal-material but winning side excludes a threefold move from objective evaluation', () => {
  const game = new ChessGame();
  for (const uci of ['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6','f3g1']) game.playUci(uci);

  const repeat = game.position.moveFromUci('f6g8');
  assert.ok(repeat);
  assert.equal(game.wouldCauseThreefold(repeat), true);

  // Equality is no longer a draw-neutral zone. With playable winning chances,
  // Vanta keeps the game alive instead of volunteering a half-point.
  assert.ok(repetitionExclusions(game, 0).includes('f6g8'));
  assert.ok(repetitionExclusions(game, 150).includes('f6g8'));
  assert.equal(shouldRejectRepetitionMove(game, repeat, 150), true);

  // Once the objective evaluation says the position is genuinely lost, the
  // same repetition becomes a valid survival resource.
  assert.deepEqual(repetitionExclusions(game, -300), []);
  assert.equal(shouldRejectRepetitionMove(game, repeat, -300), false);

  // The production search class must agree internally, otherwise it can waste
  // its tree steering toward loops that the root policy later has to reject.
  const engine = new CriticalSearchEngine({ evalNoise: 0 });
  assert.ok(engine.repetitionUtility(game.position) < 0);
  const losing = Position.fromFEN('q6k/8/8/8/8/8/8/4K3 w - - 0 1');
  assert.ok(engine.repetitionUtility(losing) > 0);

  // Exact live stress regression from the Dutch game that still repeated at
  // roughly +3.75. Rebuild the game immediately before 56...Ra2 and verify the
  // history-aware policy identifies that move as the third occurrence.
  const dutch = new ChessGame();
  const dutchHistory = [
    'd2d4','f7f5','c2c4','g8f6','b1c3','g7g6','h2h4','f8g7','c1g5','e8g8',
    'd1d2','f6e4','c3e4','f5e4','g1h3','b8c6','g5h6','f8f7','e1c1','g7d4',
    'h4h5','g6h5','h3g5','f7f2','g5h3','f2f6','e2e3','d4e5','h6g5','f6d6',
    'd2f2','a7a5','f2h4','c6b4','d1d6','c7d6','c1b1','d8b6','g5h6','b4d5',
    'b2b3','d5c3','b1c2','a5a4','h4e7','a4b3','a2b3','a8a2','c2c1','a2a1',
    'c1c2','a1a2','c2c1','a2a1','c1c2',
  ];
  for (const uci of dutchHistory) dutch.playUci(uci);
  const dutchRepeat = dutch.position.moveFromUci('a1a2');
  assert.ok(dutchRepeat);
  assert.equal(dutch.wouldCauseThreefold(dutchRepeat), true);
  assert.equal(shouldRejectRepetitionMove(dutch, dutchRepeat, 375), true);
  assert.ok(repetitionExclusions(dutch, 375).includes('a1a2'));
});

test('winning Vanta rejects a move that lets the opponent complete threefold next ply', () => {
  const game = new ChessGame();
  for (const uci of ['g1f3','g8f6','f3g1','f6g8','g1f3','g8f6']) game.playUci(uci);

  assert.equal(game.position.turn, 'w');
  const concession = game.position.moveFromUci('f3g1');
  assert.ok(concession);
  // This move is only occurrence #2 of its resulting position.
  assert.equal(game.wouldCauseThreefold(concession), false);
  // But ...Nf6-g8 would immediately restore the initial position for #3.
  assert.equal(wouldAllowOpponentThreefold(game, concession), true);
  assert.ok(repetitionExclusions(game, 150).includes('f3g1'));
  assert.equal(shouldRejectRepetitionMove(game, concession, 150), true);
});

test('root exclusions are honored by the search engine', () => {
  const position = Position.start();
  const keep = 'a2a3';
  const excludeMoves = position.legalMoves().map(moveToUci).filter(uci => uci !== keep);
  const engine = new SearchEngine({ maxDepth: 1, moveTimeMs: 1000, nodeLimit: 100000, selectionWindow: 0, evalNoise: 0 });
  const result = engine.search(position, { maxDepth: 1, moveTimeMs: 1000, excludeMoves });
  assert.equal(moveToUci(result.move), keep);

  // In this synthetic lost-result scenario Kc7 creates immediate stalemate:
  // black Ka8 has no legal square, but is not in check. The desperate draw
  // strategy must recognize that escape even if the original result chose a
  // different move.
  const stalematePosition = Position.fromFEN('k7/8/2K5/8/3B4/8/8/8 w - - 0 1');
  const knownStalemate = stalematePosition.moveFromUci('c6c7');
  assert.ok(knownStalemate);
  const afterKnown = stalematePosition.makeMove(knownStalemate);
  assert.equal(afterKnown.isInCheck(), false);
  assert.equal(afterKnown.legalMoves().length, 0);

  const fallback = stalematePosition.legalMoves().find(move => moveToUci(move) !== 'c6c7');
  assert.ok(fallback);
  const rescue = selectDesperateStalemate(stalematePosition, {
    move: fallback,
    score: -900,
    objectiveScore: -900,
    candidates: [],
  });
  assert.ok(rescue);
  assert.equal(rescue.forced, true);
  assert.equal(rescue.kind, 'immediate-stalemate');
  const afterRescue = stalematePosition.makeMove(rescue.move);
  assert.equal(afterRescue.isInCheck(), false);
  assert.equal(afterRescue.legalMoves().length, 0);
});

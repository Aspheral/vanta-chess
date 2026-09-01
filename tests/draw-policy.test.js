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
  assert.deepEqual(repetitionExclusions(game, 0), []);
  assert.ok(repetitionExclusions(game, 150).includes('f6g8'));
  assert.equal(shouldRejectRepetitionMove(game, repeat, 150), true);
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
});

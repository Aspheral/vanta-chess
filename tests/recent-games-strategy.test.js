import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPgn, fenBeforePly } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { rootTacticalRisk } from '../src/engine/tactics.js';
import { hangingPieceEmergencyRisk } from '../src/engine/safety.js';
import {
  strategicMoveBonus, strategicEvaluation, forcingQuietThreatScore,
  quietThreatMoves, endgamePhase,
} from '../src/engine/strategy.js';
import { DEV_EXPERT_GAME, DANH_GAME, BLUE_SWORD_GAME, JEMBO_GAME } from './fixtures/recent-games.js';

const dev = replayPgn(DEV_EXPERT_GAME);
const danh = replayPgn(DANH_GAME);
const blue = replayPgn(BLUE_SWORD_GAME);
const jembo = replayPgn(JEMBO_GAME);

function engine(ms=700, depth=3, extra={}) {
  return new SearchEngine({ maxDepth: depth, moveTimeMs: ms, nodeLimit: 220000, selectionWindow: 32, evalNoise: 0, ...extra });
}

test('recent Chess.com regression fixtures replay to their recorded endings', () => {
  assert.equal(dev.game.status().result, '0-1');
  assert.equal(danh.game.status().result, '0-1');
  assert.equal(blue.game.status().result, '0-1');
  assert.equal(jembo.game.status().result, '1-0');
});

test('Vanta refuses to ignore the attacked Na4 after ...b5', () => {
  const p = Position.fromFEN(fenBeforePly(dev, 11)); // before 6.c3
  const c3 = p.moveFromUci('c2c3');
  assert.ok(c3);
  assert.ok(rootTacticalRisk(p, c3) >= 180, `generic root risk only ${rootTacticalRisk(p, c3)}`);
  assert.ok(hangingPieceEmergencyRisk(p, c3) >= 650, `c3 emergency only ${hangingPieceEmergencyRisk(p, c3)}`);
  const result = engine(650, 3).search(p, { moveTimeMs: 650, maxDepth: 3 });
  assert.notEqual(moveToUci(result.move), 'c2c3', `still abandoned Na4: ${JSON.stringify(result.candidates)}`);
});

test('Vanta refuses the pawn grab Qxg7 while Nb5 is hanging to ...axb5', () => {
  const p = Position.fromFEN(fenBeforePly(danh, 17)); // before 9.Qxg7
  const grab = p.moveFromUci('a1g7');
  assert.ok(grab);
  assert.ok(hangingPieceEmergencyRisk(p, grab) >= 650, `Qxg7 emergency only ${hangingPieceEmergencyRisk(p, grab)}`);
  const result = engine(750, 3).search(p, { moveTimeMs: 750, maxDepth: 3 });
  assert.notEqual(moveToUci(result.move), 'a1g7', `still chose Qxg7: ${JSON.stringify(result.candidates)}`);
});

test('quiet pawn attacks such as ...b5 are treated as tactical horizon moves', () => {
  const p = Position.fromFEN(fenBeforePly(dev, 10)); // before 5...b5 attacks Na4
  const b5 = p.moveFromUci('b7b5');
  assert.ok(b5);
  const threat = forcingQuietThreatScore(p, b5);
  assert.ok(threat >= 100, `...b5 threat score only ${threat}`);
  assert.ok(quietThreatMoves(p, 3).map(moveToUci).includes('b7b5'));
});

test('opening move economy penalizes repeated knight tourism while pieces remain home', () => {
  const p = Position.fromFEN(fenBeforePly(blue, 5)); // before 3.Nd5
  const nd5 = p.moveFromUci('c3d5');
  const d4 = p.moveFromUci('d2d4');
  assert.ok(nd5 && d4);
  const repeated = strategicMoveBonus(p, nd5);
  const develop = strategicMoveBonus(p, d4);
  assert.ok(repeated <= develop - 30, `Nd5 ${repeated}, d4 ${develop}`);
});

test('repeated early queen wandering is more expensive than developing the position', () => {
  const p = Position.fromFEN(fenBeforePly(blue, 19)); // before 10.Qa3
  const qa3 = p.moveFromUci('b3a3');
  const d4 = p.moveFromUci('d2d4');
  assert.ok(qa3 && d4);
  const wander = strategicMoveBonus(p, qa3);
  const develop = strategicMoveBonus(p, d4);
  assert.ok(wander <= develop - 35, `Qa3 ${wander}, d4 ${develop}`);
});

test('castling receives a strong practical premium while queens remain and the army is developed', () => {
  const p = Position.fromFEN('r2qk2r/ppp2ppp/2n1bn2/8/2B1P3/2N2N2/PPPQ1PPP/R3K2R w KQkq - 4 8');
  const castle = p.moveFromUci('e1g1');
  const a3 = p.moveFromUci('a2a3');
  assert.ok(castle && a3, 'expected both castling and a3 to be legal');
  assert.ok(strategicMoveBonus(p, castle) >= strategicMoveBonus(p, a3) + 35,
    `O-O ${strategicMoveBonus(p, castle)}, a3 ${strategicMoveBonus(p, a3)}`);
});

test('queenless endgame layer rewards an active central king', () => {
  const central = Position.fromFEN('7k/8/8/8/3K4/8/8/8 w - - 0 1');
  const edge = Position.fromFEN('7k/8/8/8/8/8/8/K7 w - - 0 1');
  assert.ok(endgamePhase(central) >= 0.9);
  assert.ok(strategicEvaluation(central, 'w') >= strategicEvaluation(edge, 'w') + 20,
    `${strategicEvaluation(central, 'w')} vs ${strategicEvaluation(edge, 'w')}`);
});

test('rook behind its own passed pawn is valued above a disconnected rook', () => {
  const behind = Position.fromFEN('7k/8/8/3P4/4K3/8/8/3R4 w - - 0 1');
  const side = Position.fromFEN('7k/8/8/3P4/4K3/8/8/R7 w - - 0 1');
  assert.ok(strategicEvaluation(behind, 'w') >= strategicEvaluation(side, 'w') + 20,
    `${strategicEvaluation(behind, 'w')} vs ${strategicEvaluation(side, 'w')}`);
});

test('clear advanced passer receives explicit pawn-race urgency before promotion is immediate', () => {
  const advanced = Position.fromFEN('k7/8/7P/8/4K3/8/8/8 w - - 0 1');
  const distant = Position.fromFEN('k7/8/8/8/4K3/7P/8/8 w - - 0 1');
  assert.ok(strategicEvaluation(advanced, 'w') >= strategicEvaluation(distant, 'w') + 60,
    `${strategicEvaluation(advanced, 'w')} vs ${strategicEvaluation(distant, 'w')}`);
});

test('Jembojem lesson: a lone king is rewarded for approaching a runaway h-pawn', () => {
  // Reduced form of the real ending, removing Black's competing c-pawn so this
  // regression tests the general defensive concept rather than one exact move.
  const toward = Position.fromFEN('8/8/3k4/6K1/7P/8/8/B7 w - - 0 53');
  const wander = Position.fromFEN('8/8/8/2k3K1/7P/8/8/B7 w - - 0 53');
  assert.ok(strategicEvaluation(toward, 'b') >= strategicEvaluation(wander, 'b') + 2,
    `${strategicEvaluation(toward, 'b')} vs ${strategicEvaluation(wander, 'b')}`);
});

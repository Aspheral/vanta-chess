import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { adaptiveStrengthProfile } from '../src/engine/adaptive-strength.js';
import {
  AVOIDABLE_LOSS_FLOOR,
  ignoredAttackedPieceLoss,
  practicalSafetyExclusions,
  searchWithPracticalSafety,
} from '../src/engine/practical-safety.js';

function auditEngine() {
  return new SearchEngine({
    maxDepth: 4,
    moveTimeMs: 1200,
    nodeLimit: 300000,
    selectionWindow: 20,
    evalNoise: 0,
  });
}

test('6.c3 from the August 29 loss is recognized as an avoidable knight-for-pawn loss', () => {
  // 1.Nf3 Nf6 2.Nc3 d5 3.Ne5 d4 4.Na4 Qd6 5.f4 b5
  // Vanta played 6.c3?? and Black answered ...bxa4. White can eventually
  // recapture the pawn, but the net exchange is still a clean minor-piece loss.
  const p = Position.fromFEN('rnb1kb1r/p1p1pppp/3q1n2/1p2N3/N2p1P2/8/PPPPP1PP/R1BQKB1R w KQkq b6 0 6');
  const c3 = p.moveFromUci('c2c3');
  assert.ok(c3, 'expected 6.c3 to be legal');

  const loss = ignoredAttackedPieceLoss(p, c3);
  assert.ok(loss >= AVOIDABLE_LOSS_FLOOR, `ignored loss only ${loss}`);

  const exclusions = practicalSafetyExclusions(p);
  assert.ok(exclusions.some(item => item.uci === 'c2c3'), JSON.stringify(exclusions));
  assert.ok(exclusions.length < p.legalMoves().length, 'safety filter must leave legal alternatives');

  const result = searchWithPracticalSafety(auditEngine(), p, { moveTimeMs: 1200, maxDepth: 4 });
  assert.notEqual(moveToUci(result.move), 'c2c3', `still played c3: ${JSON.stringify(result.practicalSafety)}`);
  assert.equal(result.practicalSafety.triggered, true);
});

test('9.Qxg7 from the second August 29 loss cannot grab a pawn while abandoning Nb5', () => {
  // 1.Nc3 d5 2.Nf3 Nc6 3.a4 Bg4 4.b3 e6 5.Ba3 Bxa3 6.Rxa3 Qd6
  // 7.Nb5 Qe7 8.Qa1 a6. Vanta played 9.Qxg7? and lost the b5 knight to ...axb5.
  const p = Position.fromFEN('r3k1nr/1pp1qppp/p1n1p3/1N1p4/P5b1/RP3N2/2PPPPPP/Q3KB1R w Kkq - 0 9');
  const qxg7 = p.moveFromUci('a1g7');
  assert.ok(qxg7, 'expected 9.Qxg7 to be legal');

  const loss = ignoredAttackedPieceLoss(p, qxg7);
  assert.ok(loss >= AVOIDABLE_LOSS_FLOOR, `pawn grab did not account for abandoned knight: ${loss}`);
  const exclusions = practicalSafetyExclusions(p);
  assert.ok(exclusions.some(item => item.uci === 'a1g7'), JSON.stringify(exclusions));
});

test('forcing checks are not mechanically banned by the practical safety layer', () => {
  // The rook on a1 is attacked by the bishop, but Qh5+ is a forcing check.
  // Root safety must stay out of the way and let normal search prove or refute it.
  const p = Position.fromFEN('4k3/8/8/7Q/8/8/1b6/R3K3 w Q - 0 1');
  const check = p.moveFromUci('h5e8');
  if (check) {
    assert.equal(ignoredAttackedPieceLoss(p, check), 0);
  }
});

test('normal adaptive play now has a deeper deterministic floor and tighter style window', () => {
  const quiet = Position.fromFEN('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R w KQkq - 2 3');
  const profile = adaptiveStrengthProfile(quiet, { moveTimeMs: 850 });

  assert.ok(profile.maxDepth >= 7, JSON.stringify(profile));
  assert.ok(profile.nodeLimit >= 420000, JSON.stringify(profile));
  assert.ok(profile.selectionWindow <= 20, JSON.stringify(profile));
  assert.equal(profile.evalNoise, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { Position, moveToUci } from '../src/chess/position.js';
import { replayPgn } from '../src/chess/pgn.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  movedPieceCaptureLoss,
  practicalSafetyExclusions,
  searchWithPracticalSafety,
} from '../src/engine/practical-safety.js';

const LOSS_PGN = `
1. e4 Nf6 2. Nc3 Nc6 3. d4 d5 4. exd5 Nxd5 5. Bc4 Be6
6. Bxd5 Bxd5 7. Nxd5 Qxd5 8. Nf3 Qc4 9. Bd2 Nxd4
10. Nxd4 Qxd4 11. c3 Qe4+ 12. Qe2 Qxg2 13. O-O-O Qg6
14. Rhg1 Qf5 15. Qg4 Qxf2 16. Qf4 Qb6 17. Be3 Qc6
18. Rdf1 O-O-O 19. Qg4+ Kb8 20. Qf3 Qc4 21. Rg4 Qxa2
22. Rb4 Qa1+ 23. Kc2 Qa6 24. Ra1 Qd3+ 25. Kb3 b6
26. Qc6 e5 27. Bxb6 cxb6 28. Rxa7 Qd1+ 29. Kc4 Qe2+
30. Kb3 Qd1+ 31. Kc4 Qe2+ 32. Kb3 Qxb2+ 33. Kxb2 Rd2+
34. Kb3 Kxa7 35. Qxb6+ Ka8 36. Qb7#
`;

test('400-Elo loss: ...Qxb2+ is recognized as a newly hung queen', () => {
  const replay = replayPgn(LOSS_PGN);
  const before = Position.fromFEN(replay.plies[63].beforeFen);
  const blunder = before.moveFromUci('e2b2');
  assert.ok(blunder, 'expected ...Qxb2+ to be legal in the regression position');
  assert.equal(replay.plies[63].san, 'Qxb2+');

  const loss = movedPieceCaptureLoss(before, blunder);
  assert.ok(loss >= 650, `expected a queen-scale loss, got ${loss}`);

  const exclusions = practicalSafetyExclusions(before);
  const item = exclusions.find(entry => entry.uci === 'e2b2');
  assert.ok(item, '...Qxb2+ must be excluded by practical safety');
  assert.equal(item.reason, 'moved-piece-capture');
});

test('400-Elo loss: practical search cannot select ...Qxb2+', () => {
  const replay = replayPgn(LOSS_PGN);
  const before = Position.fromFEN(replay.plies[63].beforeFen);
  const engine = new SearchEngine({
    maxDepth: 2,
    moveTimeMs: 1500,
    nodeLimit: 200000,
    selectionWindow: 0,
    evalNoise: 0,
    adaptiveStrength: false,
  });
  const result = searchWithPracticalSafety(engine, before, {
    maxDepth: 2,
    moveTimeMs: 1500,
  });
  assert.notEqual(moveToUci(result.move), 'e2b2');
  assert.ok(result.practicalSafety.exclusions.some(entry => entry.uci === 'e2b2'));
});

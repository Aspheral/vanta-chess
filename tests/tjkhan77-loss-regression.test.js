import test from 'node:test';
import assert from 'node:assert/strict';
import { replayPgn } from '../src/chess/pgn.js';
import { moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import {
  movedPieceCaptureLoss,
  practicalSafetyExclusions,
  searchWithPracticalSafety,
} from '../src/engine/practical-safety.js';

const GAME = `
[Date "2026.08.29"]
[White "Tjkhan77"]
[Black "itzvanta"]
[Result "1-0"]
[WhiteElo "1268"]
[BlackElo "1258"]

1. e4 Nc6 2. d4 Nf6 3. Nc3 d5 4. e5 Ne4 5. Nxe4 dxe4
6. Bb5 Bd7 7. Qe2 Nxd4 8. Bxd7+ Qxd7 9. Qxe4 Nc6 10. Nf3 Qe6
11. O-O O-O-O 12. Be3 f5 13. Qa4 Nxe5 14. Qxa7 Qd5 15. Rad1 Nxf3+
16. gxf3 Qd6 17. Rxd6 Rxd6 18. Qa8+ Kd7 19. Qxb7 Rg6+ 20. Kh1 Kd8
21. Rd1+ Ke8 22. Qxc7 Kf7 23. Bd4 Kg8 24. Qc4+ Re6 25. Qxe6# 1-0`;

const BEFORE_QD6 = `
1. e4 Nc6 2. d4 Nf6 3. Nc3 d5 4. e5 Ne4 5. Nxe4 dxe4
6. Bb5 Bd7 7. Qe2 Nxd4 8. Bxd7+ Qxd7 9. Qxe4 Nc6 10. Nf3 Qe6
11. O-O O-O-O 12. Be3 f5 13. Qa4 Nxe5 14. Qxa7 Qd5 15. Rad1 Nxf3+
16. gxf3`;

test('reported Tjkhan77 game replays exactly to checkmate', () => {
  const { game, plies } = replayPgn(GAME);
  assert.equal(plies.length, 49);
  assert.equal(game.status().over, true);
  assert.equal(game.status().result, '1-0');
  assert.equal(game.status().reason, 'checkmate');
});

test('16...Qd6 is recognized as a queen-for-rook material blunder', () => {
  const { game } = replayPgn(BEFORE_QD6);
  const position = game.position;
  const move = position.moveFromUci('d5d6');
  assert.ok(move, 'Qd6 must be legal in the reported position');

  const loss = movedPieceCaptureLoss(position, move);
  assert.ok(loss >= 300, `expected queen-scale exchange loss, got ${loss}`);

  const exclusions = practicalSafetyExclusions(position);
  const qd6 = exclusions.find(item => item.uci === 'd5d6');
  assert.ok(qd6, 'Qd6 must be hard-excluded at root');
  assert.equal(qd6.reason, 'moved-piece-capture');

  const engine = new SearchEngine({
    maxDepth: 2,
    moveTimeMs: 1500,
    nodeLimit: 150000,
    selectionWindow: 0,
    evalNoise: 0,
  });
  const result = searchWithPracticalSafety(engine, position, { maxDepth: 2, moveTimeMs: 1500 });
  assert.notEqual(moveToUci(result.move), 'd5d6');
});

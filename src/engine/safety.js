import { PIECE_VALUES, colorOf, typeOf, opposite } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

/**
 * A narrow root safety gate for the practical failure seen repeatedly in the
 * Chess.com sample: a piece is already attacked, Vanta plays somewhere else,
 * and the opponent simply takes it. Net SEE of roughly two pawns is already a
 * serious minor-piece emergency even though it is below the older 240cp gate.
 *
 * This deliberately ignores forcing checks and pieces that move away. It is not
 * a blanket ban on sacrifices. Search may still sacrifice the endangered piece
 * itself, play a forcing move, or accept the loss when every safer line is more
 * than roughly a pawn worse objectively.
 */
export function hangingPieceEmergencyRisk(position, move, seeMemo = new Map()) {
  if (!move) return 100000;
  const us = position.turn;
  const enemy = opposite(us);
  const after = position.makeMove(move);
  if (after.isInCheck()) return 0;

  const captures = after.legalMoves({ capturesOnly: true });
  let risk = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== us || !['n', 'b', 'r', 'q'].includes(typeOf(piece))) continue;
    if (after.board[sq] !== piece) continue;
    if (!position.isSquareAttacked(sq, enemy)) continue;

    let bestGain = 0;
    for (const capture of captures) {
      if (capture.to !== sq || !(capture.flags & FLAGS.CAPTURE)) continue;
      bestGain = Math.max(bestGain, staticExchangeEval(after, capture, seeMemo));
    }
    if (bestGain < 160) continue;

    const victim = PIECE_VALUES[typeOf(piece)] || 0;
    // This is a gate severity, not the literal material loss. A clean ignored
    // minor is serious enough to widen the root rescue window decisively.
    const base = victim >= PIECE_VALUES.r ? 1100 : 950;
    // A fork can leave two pieces hanging at once. Using only the maximum hid
    // the difference between "save one" and "ignore both", which recreated the
    // 6...Nxe5 failure after f3. Add the independent emergencies instead.
    risk += base + Math.min(300, Math.max(0, bestGain - 160));
  }

  return Math.min(2200, Math.round(risk));
}

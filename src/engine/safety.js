import { PIECE_VALUES, colorOf, typeOf, opposite } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

function materialBalance(position, color) {
  let score = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    score += colorOf(piece) === color ? value : -value;
  }
  return score;
}

/**
 * A narrow root safety gate for the practical failure seen repeatedly in the
 * Chess.com sample: a piece is already attacked, Vanta plays somewhere else,
 * and the opponent simply takes it. Net SEE of roughly two pawns is already a
 * serious minor-piece emergency even though it is below the older 240cp gate.
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
    const base = victim >= PIECE_VALUES.r ? 1100 : 950;
    risk += base + Math.min(300, Math.max(0, bestGain - 160));
  }

  return Math.min(2200, Math.round(risk));
}

/**
 * Vanta is allowed to sacrifice, but when already materially worse it should
 * not spend additional exchange material merely for vague activity. Legal SEE
 * supplies the concrete exchange cost; search can still override this when no
 * competitive safer line exists or the move is forcing mate through the normal
 * root rescue rules.
 */
export function speculativeSacrificeRisk(position, move, seeMemo = new Map()) {
  if (!move || !(move.flags & FLAGS.CAPTURE) || move.promotion) return 0;
  const us = position.turn;
  const balance = materialBalance(position, us);
  if (balance > -80) return 0;

  const see = staticExchangeEval(position, move, seeMemo);
  if (see > -120) return 0;

  const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
  const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
  if (attacker <= victim && see > -220) return 0;

  const exchangeLoss = Math.max(0, -see - 120);
  const alreadyBehind = Math.max(0, -balance - 80);
  return Math.min(1200, Math.round(680 + exchangeLoss * 0.55 + Math.min(180, alreadyBehind * 0.18)));
}

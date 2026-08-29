import { PIECE_VALUES, colorOf, typeOf, opposite } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';
import { staticExchangeEval } from './tactics.js';

const promotionCache = new Map();

function materialBalance(position, color) {
  let score = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    score += colorOf(piece) === color ? value : -value;
  }
  return score;
}

function hasImmediatePromotion(position) {
  const key = position.hash.toString();
  if (promotionCache.has(key)) return promotionCache.get(key);
  const result = position.legalMoves().some(move => Boolean(move.promotion));
  promotionCache.set(key, result);
  if (promotionCache.size > 512) promotionCache.delete(promotionCache.keys().next().value);
  return result;
}

/**
 * Vanta is allowed to sacrifice, but when already materially worse it should
 * not spend additional exchange material merely for vague activity. Legal SEE
 * supplies the concrete exchange cost; search can still override this when no
 * competitive safer line exists or the move is forcing.
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

/**
 * A narrow root safety gate for the practical failure seen repeatedly in the
 * Chess.com sample: a piece is already attacked, Vanta plays somewhere else,
 * and the opponent simply takes it. It also carries material-deficit sacrifice
 * and immediate-promotion warnings so personality cannot talk Vanta out of an
 * obviously urgent conversion.
 */
export function hangingPieceEmergencyRisk(position, move, seeMemo = new Map()) {
  if (!move) return 100000;
  const us = position.turn;
  const enemy = opposite(us);
  const after = position.makeMove(move);
  const sacrificeRisk = speculativeSacrificeRisk(position, move, seeMemo);
  if (after.isInCheck()) return sacrificeRisk;

  let risk = sacrificeRisk;
  if (!move.promotion && hasImmediatePromotion(position)) risk = Math.max(risk, 900);

  const captures = after.legalMoves({ capturesOnly: true });
  let hangingRisk = 0;

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
    hangingRisk += base + Math.min(300, Math.max(0, bestGain - 160));
  }

  return Math.max(risk, Math.min(2200, Math.round(hangingRisk)));
}

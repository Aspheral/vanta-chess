import { FLAGS, moveToUci } from '../chess/position.js';
import { colorOf, typeOf, opposite } from '../chess/constants.js';
import { staticExchangeEval } from './tactics.js';

const PROTECTED_TYPES = new Set(['n', 'b', 'r', 'q']);
export const AVOIDABLE_LOSS_FLOOR = 110;

/**
 * Measure the net material Vanta leaves on the table when it plays a move but
 * ignores one of its pieces that was already under attack.
 *
 * The old root seatbelt intentionally tolerated small negative SEE values so
 * speculative sacrifices remained possible. The August 29 rapid loss exposed
 * a hole in that policy: after ...b5, 6.c3 allowed ...bxa4 and a later Qxa4,
 * a clean knight-for-pawn loss of roughly 2.2 pawns. That sits below the old
 * 2.4-pawn abandonment threshold, so the move could pass as practically safe.
 * A second loss showed the same family of error with Qxg7: Vanta pocketed a
 * pawn while leaving Nb5 to ...axb5. After crediting both pawn gains, the net
 * immediate loss is still about 1.2 pawns, so the root floor is deliberately
 * low enough to catch that avoidable trade too.
 *
 * This helper is narrower than a generic sacrifice veto. It only considers a
 * piece that was attacked before our move and stayed on the same square. A
 * checking move is exempt so a real forcing zwischenzug remains search-led.
 * Captures receive credit for their legal SEE gain before the ignored loss is
 * judged.
 */
export function ignoredAttackedPieceLoss(position, move, seeMemo = new Map()) {
  if (!move) return 0;
  const us = position.turn;
  const enemy = opposite(us);
  const after = position.makeMove(move);

  // position.makeMove() flips the side to move, so this means our move checks
  // the opponent. Let objective search resolve genuine forcing continuations.
  if (after.isInCheck()) return 0;

  const replies = after.legalMoves({ capturesOnly: true });
  let worstIgnoredGain = 0;

  for (let square = 0; square < 64; square++) {
    const piece = position.board[square];
    if (!piece || colorOf(piece) !== us || !PROTECTED_TYPES.has(typeOf(piece))) continue;
    if (move.from === square || after.board[square] !== piece) continue;
    if (!position.isSquareAttacked(square, enemy)) continue;

    for (const reply of replies) {
      if (reply.to !== square || !(reply.flags & FLAGS.CAPTURE)) continue;
      worstIgnoredGain = Math.max(
        worstIgnoredGain,
        staticExchangeEval(after, reply, seeMemo),
      );
    }
  }

  if (worstIgnoredGain <= 0) return 0;

  let counterGain = 0;
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) {
    counterGain = Math.max(0, staticExchangeEval(position, move, seeMemo));
  }

  return Math.max(0, Math.round(worstIgnoredGain - counterGain));
}

/**
 * Exclude only clearly avoidable "ignore the attacked piece" moves at root.
 * If every available move trips the rule, return no automatic exclusions and
 * let normal search solve the forced position. This keeps the guard from
 * inventing legality when material loss cannot actually be avoided.
 */
export function practicalSafetyExclusions(position, options = {}) {
  if (position.isInCheck()) return [];

  const floor = Math.max(80, Number(options.lossFloor) || AVOIDABLE_LOSS_FLOOR);
  const preExcluded = new Set(options.excludeMoves || []);
  const legal = position.legalMoves().filter(move => !preExcluded.has(moveToUci(move)));
  if (legal.length <= 1) return [];

  const seeMemo = new Map();
  const unsafe = [];
  let safeCount = 0;

  for (const move of legal) {
    const loss = ignoredAttackedPieceLoss(position, move, seeMemo);
    if (loss >= floor) unsafe.push({ uci: moveToUci(move), loss });
    else safeCount++;
  }

  if (!safeCount) return [];
  return unsafe;
}

/**
 * Search through the same SearchEngine, but remove avoidable root blunders
 * before iterative deepening. This is deliberately a root policy, not a leaf
 * evaluation term: deeper tactical sacrifices remain completely available.
 */
export function searchWithPracticalSafety(engine, position, options = {}) {
  const automatic = practicalSafetyExclusions(position, options);
  if (!automatic.length) {
    const result = engine.search(position, options);
    return {
      ...result,
      practicalSafety: { triggered: false, exclusions: [] },
    };
  }

  const excludeMoves = [
    ...new Set([
      ...(options.excludeMoves || []),
      ...automatic.map(item => item.uci),
    ]),
  ];
  const result = engine.search(position, { ...options, excludeMoves });
  return {
    ...result,
    practicalSafety: {
      triggered: true,
      exclusions: automatic,
    },
  };
}

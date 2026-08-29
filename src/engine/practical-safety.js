import { FLAGS, moveToUci } from '../chess/position.js';
import { colorOf, typeOf, opposite } from '../chess/constants.js';
import { staticExchangeEval } from './tactics.js';

const PROTECTED_TYPES = new Set(['n', 'b', 'r', 'q']);
const MOVED_LOSS_FLOOR = Object.freeze({ n: 260, b: 260, r: 420, q: 650 });
export const AVOIDABLE_LOSS_FLOOR = 110;

function hasImmediateMate(position) {
  for (const move of position.legalMoves()) {
    const next = position.makeMove(move);
    if (next.isInCheck() && next.legalMoves().length === 0) return true;
  }
  return false;
}

/**
 * Measure the net material Vanta leaves on the table when it plays a move but
 * ignores one of its pieces that was already under attack.
 *
 * This deliberately remains narrow. It catches avoidable abandonment without
 * turning every speculative sacrifice into a hard ban.
 */
export function ignoredAttackedPieceLoss(position, move, seeMemo = new Map()) {
  if (!move) return 0;
  const us = position.turn;
  const enemy = opposite(us);
  const after = position.makeMove(move);

  // A checking zwischenzug may intentionally postpone saving another piece.
  // Newly hanging the piece that actually moved is handled separately below.
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
 * Catch a different family of blunder: moving a valuable piece onto a square
 * where the opponent can simply take it. The first August seatbelt only
 * watched pieces that were attacked before our move, so a checking queen move
 * such as ...Qxb2+ could be considered forcing even when Kxb2 was legal.
 *
 * Checks are NOT exempt here. If the opponent can answer the check by taking
 * the moved piece, that reply is exactly what must be seen. We only waive the
 * loss when accepting the sacrifice gives Vanta an immediate forced mate.
 */
export function movedPieceCaptureLoss(position, move, seeMemo = new Map()) {
  if (!move || !PROTECTED_TYPES.has(typeOf(move.piece))) return 0;
  const after = position.makeMove(move);

  // Never suppress a move that is already checkmate.
  if (after.isInCheck() && after.legalMoves().length === 0) return 0;

  let rootGain = 0;
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) {
    rootGain = Math.max(0, staticExchangeEval(position, move, seeMemo));
  }

  let worstNetLoss = 0;
  const replies = after.legalMoves({ capturesOnly: true });
  for (const reply of replies) {
    if (reply.to !== move.to || !(reply.flags & FLAGS.CAPTURE)) continue;
    const afterReply = after.makeMove(reply);

    // Preserve simple, sound mating sacrifices. Longer combinations remain
    // search-led, but a naked queen/rook donation no longer gets a free pass
    // merely because the move gave check.
    if (hasImmediateMate(afterReply)) continue;

    const opponentGain = staticExchangeEval(after, reply, seeMemo);
    worstNetLoss = Math.max(worstNetLoss, opponentGain - rootGain);
  }

  return Math.max(0, Math.round(worstNetLoss));
}

/**
 * Exclude clearly avoidable root blunders before iterative deepening. If every
 * move is unsafe, exclusions are disabled so forced-loss positions remain
 * search-authoritative.
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
    const ignoredLoss = ignoredAttackedPieceLoss(position, move, seeMemo);
    const movedLoss = movedPieceCaptureLoss(position, move, seeMemo);
    const movedFloor = MOVED_LOSS_FLOOR[typeOf(move.piece)] ?? floor;
    const ignoredUnsafe = ignoredLoss >= floor;
    const movedUnsafe = movedLoss >= movedFloor;

    if (ignoredUnsafe || movedUnsafe) {
      unsafe.push({
        uci: moveToUci(move),
        loss: Math.max(ignoredLoss, movedLoss),
        reason: movedUnsafe ? 'moved-piece-capture' : 'ignored-attacked-piece',
      });
    } else {
      safeCount++;
    }
  }

  if (!safeCount) return [];
  return unsafe;
}

/** Search with the practical root seatbelt applied. */
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

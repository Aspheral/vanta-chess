import { FLAGS, moveToUci } from '../chess/position.js';
import { colorOf, typeOf, opposite } from '../chess/constants.js';
import { staticExchangeEval } from './tactics.js';
import { forcedCheckingMateProbe } from './mate-safety.js';

const PROTECTED_TYPES = new Set(['n', 'b', 'r', 'q']);
const MOVED_LOSS_FLOOR = Object.freeze({ n: 260, b: 260, r: 360, q: 300 });
export const AVOIDABLE_LOSS_FLOOR = 110;
const SAFETY_RESCUE_WINDOW = 140;
const MATE_PROBE_RISK_FLOOR = 240;

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
 * where the opponent can simply take it.
 */
export function movedPieceCaptureLoss(position, move, seeMemo = new Map()) {
  if (!move || !PROTECTED_TYPES.has(typeOf(move.piece))) return 0;
  const after = position.makeMove(move);

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

    // Preserve simple, sound mating sacrifices.
    if (hasImmediateMate(afterReply)) continue;

    const opponentGain = staticExchangeEval(after, reply, seeMemo);
    worstNetLoss = Math.max(worstNetLoss, opponentGain - rootGain);
  }

  return Math.max(0, Math.round(worstNetLoss));
}

/**
 * Classify root moves that deserve practical verification.
 *
 * IMPORTANT: these are candidates for a post-search seatbelt, not moves that
 * are automatically forbidden. The 1650 stress audit found that hard root
 * exclusions could remove the objectively best tactical defense and literally
 * force Vanta into a mating line. Search must remain authoritative.
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

function rebuildPv(position, pvUci = []) {
  const pv = [];
  let current = position;
  for (const uci of pvUci) {
    const move = current.moveFromUci(uci);
    if (!move) break;
    pv.push(move);
    current = current.makeMove(move);
  }
  return pv;
}

function shouldProbeForMate(move, result) {
  if (!move) return false;
  return Boolean(
    (move.flags & FLAGS.CAPTURE)
    || move.promotion
    || Math.abs(Number(result?.selectedRisk) || 0) >= MATE_PROBE_RISK_FLOOR
  );
}

function mateProbe(position, move, result) {
  if (!shouldProbeForMate(move, result)) return { forced: false, nodes: 0 };
  return forcedCheckingMateProbe(position, move);
}

/**
 * Search every legal root move first, then use the practical detector only as
 * a bounded post-search rescue. This is intentionally different from the old
 * implementation, which pre-excluded every heuristic hazard before alpha-beta.
 *
 * Material hazards may only be replaced by an already-nearby objective line.
 * A proven checking mate is different: once the selected move is demonstrated
 * to lose by force, the best exact candidate that does not share that forced
 * mate is preferable regardless of a shallow centipawn disagreement.
 */
export function searchWithPracticalSafety(engine, position, options = {}) {
  const automatic = practicalSafetyExclusions(position, options);
  const result = engine.search(position, options);

  if (!result.move) {
    return {
      ...result,
      practicalSafety: { triggered: false, rescued: false, exclusions: automatic },
    };
  }

  const hazards = new Map(automatic.map(item => [item.uci, item]));
  const selectedUci = moveToUci(result.move);
  const selectedHazard = hazards.get(selectedUci) || null;
  const selectedMate = mateProbe(position, result.move, result);

  if (!selectedHazard && !selectedMate.forced) {
    return {
      ...result,
      practicalSafety: {
        triggered: false,
        rescued: false,
        exclusions: automatic,
        mateProbe: selectedMate,
      },
    };
  }

  const objective = result.objectiveScore ?? result.score ?? 0;
  let mateProbeNodes = selectedMate.nodes;
  const candidates = (result.candidates || [])
    .filter(candidate => candidate.uci !== selectedUci)
    .filter(candidate => candidate.exact !== false)
    .filter(candidate => !selectedHazard || !hazards.has(candidate.uci))
    .filter(candidate => selectedMate.forced || candidate.score >= objective - SAFETY_RESCUE_WINDOW)
    .sort((a, b) => b.score - a.score);

  let rescue = null;
  let rescueMove = null;
  for (const candidate of candidates) {
    const move = position.moveFromUci(candidate.uci);
    if (!move) continue;

    if (selectedMate.forced) {
      const probe = forcedCheckingMateProbe(position, move);
      mateProbeNodes += probe.nodes;
      if (probe.forced) continue;
    }

    rescue = candidate;
    rescueMove = move;
    break;
  }

  if (!rescue || !rescueMove) {
    return {
      ...result,
      practicalSafety: {
        triggered: true,
        rescued: false,
        selectedHazard: selectedHazard || (selectedMate.forced
          ? { uci: selectedUci, loss: 99000, reason: 'forced-checking-mate' }
          : null),
        exclusions: automatic,
        mateProbe: { forced: selectedMate.forced, nodes: mateProbeNodes },
      },
    };
  }

  const pv = rebuildPv(position, rescue.pv || [rescue.uci]);
  return {
    ...result,
    move: rescueMove,
    score: rescue.score + (rescue.personality || 0),
    objectiveScore: rescue.score,
    pv: pv.length ? pv : [rescueMove],
    practicalSafety: {
      triggered: true,
      rescued: true,
      selectedHazard: selectedHazard || (selectedMate.forced
        ? { uci: selectedUci, loss: 99000, reason: 'forced-checking-mate' }
        : null),
      rescue: { uci: rescue.uci, score: rescue.score },
      exclusions: automatic,
      mateProbe: { forced: selectedMate.forced, nodes: mateProbeNodes },
    },
  };
}

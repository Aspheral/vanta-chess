import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { FLAGS, moveToUci } from '../chess/position.js';

export const WINNING_DRAW_THRESHOLD = 80;
export const PROGRESS_REPEAT_THRESHOLD = 120;

export function materialLead(position, color = position.turn) {
  let score = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    score += colorOf(piece) === color ? value : -value;
  }
  return score;
}

export function shouldAvoidRepetitionDraw(game, objectiveScore = 0) {
  return materialLead(game.position, game.position.turn) > 0 || objectiveScore >= WINNING_DRAW_THRESHOLD;
}

function isForcingRepeat(game, move) {
  if (!move) return false;
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
  return game.position.makeMove(move).isInCheck();
}

function shouldPreferProgress(game, objectiveScore = 0) {
  return materialLead(game.position, game.position.turn) >= 150 || objectiveScore >= PROGRESS_REPEAT_THRESHOLD;
}

export function repetitionExclusions(game, objectiveScore = 0) {
  if (!shouldAvoidRepetitionDraw(game, objectiveScore)) return [];
  const legal = game.position.legalMoves();
  const blocked = new Map();

  for (const move of legal) {
    if (game.wouldCauseThreefold(move)) blocked.set(moveToUci(move), move);
  }

  // When clearly better, reject an avoidable quiet second occurrence too. This
  // catches bishop/rook/king shuffles before they harden into a threefold draw.
  if (shouldPreferProgress(game, objectiveScore)) {
    for (const move of legal) {
      if (!game.wouldRepeatPosition(move) || isForcingRepeat(game, move)) continue;
      blocked.set(moveToUci(move), move);
    }
  }

  // If every legal move repeats, the cycle is forced. Do not hand the search an
  // empty root and pretend Vanta can manufacture a new position.
  if (!blocked.size || blocked.size === legal.length) return [];
  return [...blocked.keys()];
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move || !shouldAvoidRepetitionDraw(game, objectiveScore)) return false;
  const legal = game.position.legalMoves();

  if (game.wouldCauseThreefold(move)) {
    return legal.some(candidate => !game.wouldCauseThreefold(candidate));
  }

  if (!shouldPreferProgress(game, objectiveScore) || !game.wouldRepeatPosition(move) || isForcingRepeat(game, move)) return false;
  return legal.some(candidate => !game.wouldRepeatPosition(candidate));
}

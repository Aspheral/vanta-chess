import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';

export const WINNING_DRAW_THRESHOLD = 80;
export const PROGRESS_REPEAT_THRESHOLD = 65;
export const PROGRESS_MATERIAL_LEAD = 180;

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

export function shouldPreferProgress(game, objectiveScore = 0) {
  return materialLead(game.position, game.position.turn) >= PROGRESS_MATERIAL_LEAD
    || objectiveScore >= PROGRESS_REPEAT_THRESHOLD;
}

function avoidableMoves(game, predicate) {
  const legal = game.position.legalMoves();
  const repeating = legal.filter(predicate);
  if (!repeating.length || repeating.length === legal.length) return [];
  return repeating;
}

export function repetitionExclusions(game, objectiveScore = 0) {
  const excluded = new Map();

  if (shouldAvoidRepetitionDraw(game, objectiveScore)) {
    for (const move of avoidableMoves(game, move => game.wouldCauseThreefold(move))) {
      excluded.set(moveToUci(move), move);
    }
  }

  // Twofold is not a draw. This is a progress preference only, and it activates
  // when Vanta is clearly better. If every legal move cycles, nothing is
  // excluded and normal search remains authoritative.
  if (shouldPreferProgress(game, objectiveScore)) {
    for (const move of avoidableMoves(game, move => game.wouldCauseTwofold(move))) {
      excluded.set(moveToUci(move), move);
    }
  }

  return [...excluded.keys()];
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move) return false;
  const legal = game.position.legalMoves();

  if (shouldAvoidRepetitionDraw(game, objectiveScore) && game.wouldCauseThreefold(move)) {
    return legal.some(candidate => !game.wouldCauseThreefold(candidate));
  }

  if (shouldPreferProgress(game, objectiveScore) && game.wouldCauseTwofold(move)) {
    return legal.some(candidate => !game.wouldCauseTwofold(candidate));
  }
  return false;
}

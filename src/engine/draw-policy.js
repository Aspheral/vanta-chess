import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';

export const WINNING_DRAW_THRESHOLD = 80;
export const PROGRESS_REPEAT_THRESHOLD = -20;

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

export function wouldRepeatExistingPosition(game, move) {
  if (!move) return false;
  const legal = game.position.legalMoves().find(candidate =>
    candidate.from === move.from && candidate.to === move.to && (candidate.promotion || null) === (move.promotion || null));
  if (!legal) return false;
  return game.repetitionCount(game.position.makeMove(legal)) >= 1;
}

export function shouldPreferProgress(game, objectiveScore = 0) {
  if (game.position.fullmove < 10) return false;
  const material = materialLead(game.position, game.position.turn);
  return material >= 0 || objectiveScore >= PROGRESS_REPEAT_THRESHOLD;
}

export function repetitionExclusions(game, objectiveScore = 0) {
  const legal = game.position.legalMoves();
  if (!legal.length) return [];

  const avoidDraw = shouldAvoidRepetitionDraw(game, objectiveScore);
  const preferProgress = shouldPreferProgress(game, objectiveScore);
  if (!avoidDraw && !preferProgress) return [];

  const repeating = legal.filter(move => {
    if (avoidDraw && game.wouldCauseThreefold(move)) return true;
    return preferProgress && wouldRepeatExistingPosition(game, move);
  });

  // Repetition can be the only defensive resource. Never manufacture an empty
  // root merely to look active; the policy is preference, not a legality rule.
  if (!repeating.length || repeating.length === legal.length) return [];
  return repeating.map(moveToUci);
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move) return false;
  const avoidDraw = shouldAvoidRepetitionDraw(game, objectiveScore) && game.wouldCauseThreefold(move);
  const avoidShuffle = shouldPreferProgress(game, objectiveScore) && wouldRepeatExistingPosition(game, move);
  if (!avoidDraw && !avoidShuffle) return false;
  return game.position.legalMoves().some(candidate => !wouldRepeatExistingPosition(game, candidate));
}

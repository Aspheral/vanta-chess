import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';

export const WINNING_DRAW_THRESHOLD = 80;

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

export function repetitionExclusions(game, objectiveScore = 0) {
  if (!shouldAvoidRepetitionDraw(game, objectiveScore)) return [];
  const legal = game.position.legalMoves();
  const repeating = legal.filter(move => game.wouldCauseThreefold(move));
  // If every legal move repeats, the draw is forced. Do not hand the search an
  // empty root and pretend Vanta can escape something it cannot escape.
  if (!repeating.length || repeating.length === legal.length) return [];
  return repeating.map(moveToUci);
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move || !shouldAvoidRepetitionDraw(game, objectiveScore) || !game.wouldCauseThreefold(move)) return false;
  return game.position.legalMoves().some(candidate => !game.wouldCauseThreefold(candidate));
}

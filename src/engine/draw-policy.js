import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { rootTacticalRisk } from './tactics.js';

export const WINNING_DRAW_THRESHOLD = 80;
export const REPETITION_ESCAPE_RISK_LIMIT = 650;

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

function safeNonRepeatingMoves(game) {
  const seeMemo = new Map();
  return game.position.legalMoves().filter(move => {
    if (game.wouldCauseThreefold(move)) return false;
    return rootTacticalRisk(game.position, move, seeMemo) < REPETITION_ESCAPE_RISK_LIMIT;
  });
}

/**
 * Vanta should try to convert winning positions, but never by deleting a safe
 * repetition and forcing itself into an obvious tactical collapse. We only
 * exclude a threefold move when at least one non-repeating alternative passes
 * the root tactical seatbelt.
 */
export function repetitionExclusions(game, objectiveScore = 0) {
  if (!shouldAvoidRepetitionDraw(game, objectiveScore)) return [];
  const legal = game.position.legalMoves();
  const repeating = legal.filter(move => game.wouldCauseThreefold(move));
  if (!repeating.length || repeating.length === legal.length) return [];
  if (!safeNonRepeatingMoves(game).length) return [];
  return repeating.map(moveToUci);
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move || !shouldAvoidRepetitionDraw(game, objectiveScore) || !game.wouldCauseThreefold(move)) return false;
  return safeNonRepeatingMoves(game).length > 0;
}

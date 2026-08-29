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

/**
 * A move can hand over a repetition draw without itself being occurrence #3.
 * If the resulting position gives the opponent any legal reply whose result
 * has already appeared twice in the real game history, the opponent can claim
 * threefold immediately on the next ply. When Vanta is winning, that move is
 * a draw concession and should be treated exactly like an immediate repeat.
 */
export function wouldAllowOpponentThreefold(game, move) {
  if (!move) return false;
  const legal = game.position.legalMoves().find(candidate =>
    candidate.from === move.from
    && candidate.to === move.to
    && (candidate.promotion || null) === (move.promotion || null));
  if (!legal) return false;

  const after = game.position.makeMove(legal);
  for (const reply of after.legalMoves()) {
    const resulting = after.makeMove(reply);
    if (game.repetitionCount(resulting) >= 2) return true;
  }
  return false;
}

export function isRepetitionConcession(game, move) {
  return game.wouldCauseThreefold(move) || wouldAllowOpponentThreefold(game, move);
}

function safeNonRepeatingMoves(game) {
  const seeMemo = new Map();
  return game.position.legalMoves().filter(move => {
    if (isRepetitionConcession(game, move)) return false;
    return rootTacticalRisk(game.position, move, seeMemo) < REPETITION_ESCAPE_RISK_LIMIT;
  });
}

/**
 * Vanta should try to convert winning positions, but never by deleting a safe
 * repetition and forcing itself into an obvious tactical collapse. We exclude
 * both moves that complete threefold now and moves that let the opponent force
 * it one ply later, but only when at least one non-repeating alternative passes
 * the root tactical seatbelt.
 */
export function repetitionExclusions(game, objectiveScore = 0) {
  if (!shouldAvoidRepetitionDraw(game, objectiveScore)) return [];
  const legal = game.position.legalMoves();
  const repeating = legal.filter(move => isRepetitionConcession(game, move));
  if (!repeating.length || repeating.length === legal.length) return [];
  if (!safeNonRepeatingMoves(game).length) return [];
  return repeating.map(moveToUci);
}

export function shouldRejectRepetitionMove(game, move, objectiveScore = 0) {
  if (!move || !shouldAvoidRepetitionDraw(game, objectiveScore) || !isRepetitionConcession(game, move)) return false;
  return safeNonRepeatingMoves(game).length > 0;
}

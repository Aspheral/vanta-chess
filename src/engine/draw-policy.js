import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { rootTacticalRisk } from './tactics.js';

// Threefold is a survival resource, not a neutral strategic choice. Vanta only
// starts valuing a repetition when the position is genuinely bad enough that
// converting a loss into a draw is the objective.
export const REPETITION_DRAW_SEEK_THRESHOLD = -250;
export const CATASTROPHIC_LOSS_THRESHOLD = -700;
export const SERIOUS_MATERIAL_DEFICIT = 300;
// Kept for compatibility with older imports. The semantics are now the score
// below which Vanta may accept a draw, rather than a "winning" threshold.
export const WINNING_DRAW_THRESHOLD = REPETITION_DRAW_SEEK_THRESHOLD;
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

/**
 * Decide whether a draw is a desirable result from the side-to-move's point of
 * view. Mild disadvantage is not enough: Vanta should keep playing for winning
 * chances around equality and in somewhat worse positions.
 *
 * A catastrophic objective score always qualifies. Otherwise the evaluation
 * and material picture must agree that Vanta is in real trouble.
 */
export function isSeriouslyLosing(position, objectiveScore = 0) {
  const score = Number(objectiveScore);
  const objective = Number.isFinite(score) ? score : 0;
  const material = materialLead(position, position.turn);

  if (objective <= CATASTROPHIC_LOSS_THRESHOLD) return true;
  if (objective <= REPETITION_DRAW_SEEK_THRESHOLD && material <= 0) return true;
  if (material <= -SERIOUS_MATERIAL_DEFICIT && objective <= 0) return true;
  return false;
}

export function shouldAvoidRepetitionDraw(game, objectiveScore = 0) {
  return !isSeriouslyLosing(game.position, objectiveScore);
}

/**
 * A move can hand over a repetition draw without itself being occurrence #3.
 * If the resulting position gives the opponent any legal reply whose result
 * has already appeared twice in the real game history, the opponent can claim
 * threefold immediately on the next ply. Unless Vanta is seriously losing,
 * that move is a draw concession and should be treated like an immediate repeat.
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
 * Vanta plays for a win whenever it still has realistic chances. Repetition is
 * excluded around equality, while slightly worse, and while ahead. The only
 * exception is a genuinely losing position where saving half a point is the
 * correct objective. Even then, the draw is never rejected merely for style.
 *
 * When avoiding a draw we still require at least one tactically survivable
 * non-repeating move, so the anti-draw policy cannot force a self-destruct.
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

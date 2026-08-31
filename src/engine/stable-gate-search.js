import { moveToUci } from '../chess/position.js';
import { MATE_SCORE } from './evaluation.js';
import { GateSearchEngine } from './gate-search.js';
import { rootTacticalRisk } from './tactics.js';

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

/**
 * A tiny root-only stabilizer for the 1650 gate.
 *
 * It never searches an extra node. When the deepest completed iteration flips
 * to a different best move, we look at the prior iteration's winner only if it
 * still survives as an exact near-equal line in the final root result. A move
 * that led for multiple prior depths gets a slightly wider hysteresis window.
 * Tactical risk remains a veto, so "stability" can never mean clinging to a
 * newly exposed queen/rook hang.
 */
export class StableGateSearchEngine extends GateSearchEngine {
  search(position, options = {}) {
    const result = super.search(position, options);
    const iterations = result.iterations || [];
    if (!result.unstable || !result.move || iterations.length < 2) return result;

    const currentUci = moveToUci(result.move);
    const last = iterations[iterations.length - 1];
    const previous = iterations[iterations.length - 2];
    if (!previous?.bestMove || previous.bestMove === currentUci) return result;
    if (Math.abs(result.objectiveScore ?? result.score ?? 0) >= MATE_SCORE - 1000) return result;

    const finalCandidates = (result.candidates || []).filter(candidate => candidate.exact !== false && !candidate.shallowRescue);
    const current = finalCandidates.find(candidate => candidate.uci === currentUci);
    const alternate = finalCandidates.find(candidate => candidate.uci === previous.bestMove);
    if (!current || !alternate) return result;

    const priorSupport = iterations
      .slice(Math.max(0, iterations.length - 4), iterations.length - 1)
      .filter(item => item.bestMove === previous.bestMove)
      .length;
    const hysteresisCp = priorSupport >= 2 ? 34 : 12;
    if (alternate.score < current.score - hysteresisCp) return result;

    const alternateMove = position.moveFromUci(alternate.uci);
    if (!alternateMove) return result;
    const currentRisk = result.selectedRisk ?? rootTacticalRisk(position, result.move, this.seeMemo);
    const alternateRisk = rootTacticalRisk(position, alternateMove, this.seeMemo);
    if (alternateRisk >= 700 && alternateRisk > currentRisk) return result;
    if (alternateRisk >= 300 && alternateRisk > currentRisk + 80) return result;

    const pv = rebuildPv(position, alternate.pv || [alternate.uci]);
    return {
      ...result,
      move: alternateMove,
      score: alternate.score,
      objectiveScore: alternate.score,
      pv: pv.length ? pv : [alternateMove],
      selectedRisk: alternateRisk,
      stabilityRescue: {
        from: currentUci,
        to: alternate.uci,
        currentScore: current.score,
        alternateScore: alternate.score,
        priorSupport,
        hysteresisCp,
      },
    };
  }
}

import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { FLAGS, moveToUci } from '../chess/position.js';
import {
  strategicPositionValue, rootStrategicAdjustment, rootSafetyRisk,
  isForcingQuietThreat,
} from './quality.js';

export class SearchEngine extends CoreSearchEngine {
  staticEval(position, perspective = position.turn) {
    return super.staticEval(position, perspective) + strategicPositionValue(position, perspective);
  }

  searchRoot(position, depth, options = {}) {
    const result = super.searchRoot(position, depth, options);
    if (!result.lines?.length) return result;

    for (const line of result.lines) {
      const quality = rootStrategicAdjustment(position, line.move);
      line.quality = quality;
      line.personality = (line.personality || 0) + quality;
    }

    // Keep the proven objective search scores untouched. Strategic discipline is
    // a root selection preference, not a second evaluator that can distort the
    // alpha-beta result or erase an already-proven tactical regression.
    return result;
  }

  personalitySelect(position, lines, bestFallback) {
    const selected = super.personalitySelect(position, lines, bestFallback);
    if (!selected?.move || !lines?.length) return selected;

    const exact = lines.filter(line => line.exact !== false);
    const pool = exact.length ? exact : lines;
    const bestScore = Math.max(...pool.map(line => line.score));

    // First apply the strategic root preferences inside a bounded objective
    // window. This is where move economy, queen discipline, castling urgency,
    // and endgame progress influence play without overriding real tactics.
    const strategicWindow = Math.max(this.config.selectionWindow ?? 32, 48);
    const strategicCandidates = pool
      .filter(line => line.score >= bestScore - strategicWindow)
      .map(line => ({
        ...line,
        safetyRisk: rootSafetyRisk(position, line.move),
        strategicComposite: line.score + (line.personality || 0),
      }))
      .sort((a, b) => b.strategicComposite - a.strategicComposite);

    let pick = strategicCandidates[0] || null;
    if (pick && pick.safetyRisk < 560) {
      return {
        move: pick.move,
        score: pick.strategicComposite,
        objectiveScore: pick.score,
        pv: pick.pv,
        risk: pick.safetyRisk,
      };
    }

    const selectedRisk = rootSafetyRisk(position, selected.move);
    if ((!pick || selectedRisk < pick.safetyRisk) && selectedRisk < 560) {
      return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
    }

    // A cleanly hanging minor/major is not merely a style penalty. If a
    // competitive safe line exists, rescue the piece. Sound sacrifices still
    // survive when search proves enough compensation or no safe competitive
    // alternative exists.
    const riskToBeat = Math.max(selectedRisk, pick?.safetyRisk || 0);
    const margin = riskToBeat >= 820 ? 170 : 125;
    const alternatives = pool
      .filter(line => line.score >= bestScore - margin)
      .map(line => ({ ...line, safetyRisk: rootSafetyRisk(position, line.move) }))
      .filter(line => line.safetyRisk < 500)
      .sort((a, b) => (b.score + (b.personality || 0) * 0.35) - (a.score + (a.personality || 0) * 0.35));

    if (!alternatives.length) {
      if (pick) return {
        move: pick.move,
        score: pick.strategicComposite,
        objectiveScore: pick.score,
        pv: pick.pv,
        risk: pick.safetyRisk,
      };
      return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
    }

    const rescue = alternatives[0];
    return {
      move: rescue.move,
      score: rescue.score + (rescue.personality || 0),
      objectiveScore: rescue.score,
      pv: rescue.pv,
      risk: rescue.safetyRisk,
    };
  }

  orderMoves(position, moves, ply, ttMove) {
    const ordered = super.orderMoves(position, moves, ply, ttMove);
    if (ply > 1 || ordered.length < 2) return ordered;
    const rank = new Map(ordered.map((move, index) => [moveToUci(move), index]));
    return [...ordered].sort((a, b) => {
      const at = !(a.flags & FLAGS.CAPTURE) && !a.promotion && isForcingQuietThreat(position, a) ? 1 : 0;
      const bt = !(b.flags & FLAGS.CAPTURE) && !b.promotion && isForcingQuietThreat(position, b) ? 1 : 0;
      if (at !== bt) return bt - at;
      return (rank.get(moveToUci(a)) ?? 999) - (rank.get(moveToUci(b)) ?? 999);
    });
  }
}

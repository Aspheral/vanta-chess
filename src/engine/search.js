import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { FLAGS, moveToUci } from '../chess/position.js';
import {
  rootStrategicAdjustment, rootSafetyRisk, isForcingQuietThreat,
} from './quality.js';

export class SearchEngine extends CoreSearchEngine {
  searchRoot(position, depth, options = {}) {
    const result = super.searchRoot(position, depth, options);
    if (!result.lines?.length) return result;

    // Annotate the root for diagnostics, but do not rewrite objective scores or
    // the proven personality term. Strategic discipline is applied only after
    // the core engine has made its normal tactical/objective choice.
    for (const line of result.lines) line.quality = rootStrategicAdjustment(position, line.move);
    return result;
  }

  personalitySelect(position, lines, bestFallback) {
    const selected = super.personalitySelect(position, lines, bestFallback);
    if (!selected?.move || !lines?.length) return selected;

    const exact = lines.filter(line => line.exact !== false);
    const pool = exact.length ? exact : lines;
    const bestScore = Math.max(...pool.map(line => line.score));
    const selectedRisk = rootSafetyRisk(position, selected.move);

    // Material/tactical safety comes first. A cleanly hanging minor or major is
    // not a style preference. If a competitive safe line exists, use it. Sound
    // sacrifices survive when search proves enough compensation or no safe
    // alternative exists inside a generous but still finite objective margin.
    if (selectedRisk >= 560) {
      const margin = selectedRisk >= 820 ? 210 : 155;
      const alternatives = pool
        .filter(line => line.score >= bestScore - margin)
        .map(line => ({ ...line, safetyRisk: rootSafetyRisk(position, line.move) }))
        .filter(line => line.safetyRisk < 500)
        .sort((a, b) => (b.score + (b.personality || 0) * 0.35) - (a.score + (a.personality || 0) * 0.35));

      if (alternatives.length) {
        const rescue = alternatives[0];
        return {
          move: rescue.move,
          score: rescue.score + (rescue.personality || 0),
          objectiveScore: rescue.score,
          pv: rescue.pv,
          risk: rescue.safetyRisk,
        };
      }
      return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
    }

    // Only after the normal move is tactically sound do the new opening/endgame
    // preferences get a vote. They may break near-ties, never overturn a real
    // search advantage. This keeps Vanta's established tactical personality
    // authoritative while discouraging knight tourism, queen wandering, and
    // passive endgame shuffling.
    const strategicWindow = Math.min(42, Math.max(24, this.config.selectionWindow ?? 32));
    const candidates = pool
      .filter(line => line.score >= bestScore - strategicWindow)
      .map(line => ({
        ...line,
        safetyRisk: rootSafetyRisk(position, line.move),
        quality: line.quality ?? rootStrategicAdjustment(position, line.move),
      }))
      .filter(line => line.safetyRisk < 500)
      .map(line => ({ ...line, strategicComposite: line.score + (line.personality || 0) + line.quality }))
      .sort((a, b) => b.strategicComposite - a.strategicComposite);

    const strategic = candidates[0];
    if (strategic && strategic.strategicComposite > (selected.score ?? selected.objectiveScore ?? -Infinity) + 4) {
      return {
        move: strategic.move,
        score: strategic.strategicComposite,
        objectiveScore: strategic.score,
        pv: strategic.pv,
        risk: strategic.safetyRisk,
      };
    }

    return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
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

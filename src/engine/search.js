import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { rootStrategicAdjustment, rootSafetyRisk } from './quality.js';

export class SearchEngine extends CoreSearchEngine {
  searchRoot(position, depth, options = {}) {
    const result = super.searchRoot(position, depth, options);
    if (!result.lines?.length) return result;

    // Annotate the root for diagnostics, but do not rewrite objective scores,
    // move ordering, qsearch, or the proven personality term. The existing
    // tactical engine gets exactly the same search tree it had before this pass.
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

    // A cleanly hanging/trapped minor or major is a safety failure, not a style
    // preference. Permit a wide rescue window because a shallow evaluation can
    // easily be wrong by roughly the value of the piece it is about to lose.
    // A genuinely sound sacrifice still survives if no competitive safe line
    // exists or if search values the sacrifice more than that material margin.
    if (selectedRisk >= 560) {
      const margin = selectedRisk >= 820 ? 340 : 290;
      const alternatives = pool
        .filter(line => line.score >= bestScore - margin)
        .map(line => ({ ...line, safetyRisk: rootSafetyRisk(position, line.move) }))
        .filter(line => line.safetyRisk < 280)
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

    // Medium tactical risk was already considered by the core seatbelt. Never
    // let an opening/endgame style preference reopen such a move afterwards.
    if (selectedRisk >= 280) {
      return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
    }

    // Strategy only breaks objectively close, genuinely safe ties. This is the
    // lane for development economy, queen discipline, castling, and endgame
    // progress. It cannot overrule a tactical warning.
    const strategicWindow = Math.min(38, Math.max(22, this.config.selectionWindow ?? 32));
    const candidates = pool
      .filter(line => line.score >= bestScore - strategicWindow)
      .map(line => ({
        ...line,
        safetyRisk: rootSafetyRisk(position, line.move),
        quality: line.quality ?? rootStrategicAdjustment(position, line.move),
      }))
      .filter(line => line.safetyRisk < 280)
      .map(line => ({ ...line, strategicComposite: line.score + (line.personality || 0) + line.quality }))
      .sort((a, b) => b.strategicComposite - a.strategicComposite);

    const strategic = candidates[0];
    if (strategic && strategic.strategicComposite > (selected.score ?? selected.objectiveScore ?? -Infinity) + 6) {
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
}

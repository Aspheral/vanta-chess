import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { rootStrategicAdjustment, rootSafetyRisk, avoidableMaterialRisk } from './quality.js';

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
    const selectedAvoidableRisk = avoidableMaterialRisk(position, selected.move);

    // A newly hanging or trapped minor/major is a safety failure, not a style
    // preference. Ambient tactical danger is deliberately excluded from this
    // rescue comparison because a messy position can make every legal move look
    // risky to the generic root seatbelt. The replacement only needs to avoid
    // the new material/trap failure; the core engine remains responsible for
    // comparing its ordinary tactical risk and objective score.
    if (selectedAvoidableRisk >= 560) {
      const margin = selectedAvoidableRisk >= 820 ? 430 : 380;
      const alternatives = pool
        .filter(line => line.score >= bestScore - margin)
        .map(line => ({
          ...line,
          safetyRisk: rootSafetyRisk(position, line.move),
          avoidableRisk: avoidableMaterialRisk(position, line.move),
        }))
        .filter(line => line.avoidableRisk < 280)
        .sort((a, b) => (b.score + (b.personality || 0) * 0.35) - (a.score + (a.personality || 0) * 0.35));

      if (alternatives.length) {
        const rescue = alternatives[0];
        return {
          move: rescue.move,
          score: rescue.score + (rescue.personality || 0),
          objectiveScore: rescue.score,
          pv: rescue.pv,
          risk: Math.max(rescue.safetyRisk, rescue.avoidableRisk),
        };
      }
      return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk, selectedAvoidableRisk) };
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

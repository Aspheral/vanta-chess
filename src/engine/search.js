import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, typeOf } from '../chess/constants.js';
import { staticExchangeEval } from './tactics.js';
import {
  strategicPositionValue, rootStrategicAdjustment, rootSafetyRisk,
  isForcingQuietThreat,
} from './quality.js';

const INF = 1_000_000;

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
      // A bounded fraction also enters the root objective so move economy,
      // castling and endgame progress can defeat a superficially active move
      // that is just outside the normal personality-selection window.
      line.score += Math.round(quality * 0.45);
    }

    result.lines.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return b.score - a.score;
    });
    const exact = result.lines.filter(line => line.exact !== false);
    const best = exact[0] || result.lines[0];
    if (best) {
      result.bestMove = best.move;
      result.score = best.score;
      result.pv = best.pv;
    }
    return result;
  }

  personalitySelect(position, lines, bestFallback) {
    const selected = super.personalitySelect(position, lines, bestFallback);
    if (!selected?.move || !lines?.length) return selected;

    const selectedRisk = rootSafetyRisk(position, selected.move);
    if (selectedRisk < 560) return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };

    const exact = lines.filter(line => line.exact !== false);
    const pool = exact.length ? exact : lines;
    const bestScore = Math.max(...pool.map(line => line.score));
    const margin = selectedRisk >= 820 ? 150 : 105;
    const alternatives = pool
      .filter(line => line.score >= bestScore - margin)
      .map(line => ({ ...line, safetyRisk: rootSafetyRisk(position, line.move) }))
      .filter(line => line.safetyRisk < 500)
      .sort((a, b) => (b.score + (b.personality || 0) * 0.35) - (a.score + (a.personality || 0) * 0.35));

    if (!alternatives.length) return { ...selected, risk: Math.max(selected.risk || 0, selectedRisk) };
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
    if (ply > 2 || ordered.length < 2) return ordered;
    const rank = new Map(ordered.map((move, index) => [moveToUci(move), index]));
    return [...ordered].sort((a, b) => {
      const at = !(a.flags & FLAGS.CAPTURE) && !a.promotion && isForcingQuietThreat(position, a) ? 1 : 0;
      const bt = !(b.flags & FLAGS.CAPTURE) && !b.promotion && isForcingQuietThreat(position, b) ? 1 : 0;
      if (at !== bt) return bt - at;
      return (rank.get(moveToUci(a)) ?? 999) - (rank.get(moveToUci(b)) ?? 999);
    });
  }

  quiescence(position, alpha, beta, ply, qply = 0) {
    this.qnodes++;
    if (position.halfmove >= 100 || position.isInsufficientMaterial()) return 0;

    const inCheck = position.isInCheck();
    let moves = inCheck ? position.legalMoves() : position.legalMoves({ capturesOnly: true });
    if (inCheck && moves.length === 0) return -100000 + ply;

    const stand = this.staticEval(position);
    if (!inCheck) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }

    if (qply > 8 || ply > 18 || this.timeUp()) return inCheck ? alpha : Math.max(alpha, stand);

    // At the horizon, treat a quiet fork, discovered attack, serious attack on
    // an undefended piece, or critical passed-pawn push as tactical. This is
    // intentionally root-qsearch only to avoid turning quiescence into a full
    // second search tree.
    if (!inCheck && qply === 0) {
      const existing = new Set(moves.map(moveToUci));
      let added = 0;
      for (const move of position.legalMoves()) {
        const uci = moveToUci(move);
        if (existing.has(uci) || move.flags & FLAGS.CAPTURE || move.promotion) continue;
        const next = position.makeMove(move);
        if (next.isInCheck() || isForcingQuietThreat(position, move)) {
          moves.push(move);
          existing.add(uci);
          if (++added >= 8) break;
        }
      }
    }

    moves = this.orderMoves(position, moves, ply, null);
    for (const move of moves) {
      if (this.timeUp()) break;
      const next = position.makeMove(move);
      const givesCheck = next.isInCheck();
      if (!inCheck && (move.flags & FLAGS.CAPTURE) && !move.promotion && !givesCheck) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const see = staticExchangeEval(position, move, this.seeMemo);
        if (see < -120) continue;
        if (stand + Math.max(victim, see) + 95 < alpha) continue;
      }
      const score = -this.quiescence(next, -beta, -alpha, ply + 1, qply + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }
}

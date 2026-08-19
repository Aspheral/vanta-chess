import { SearchEngine as CoreSearchEngine } from './search-v2.js';
import { MATE_SCORE, evaluate } from './evaluation-v2.js';
import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf, rowCol } from '../chess/constants.js';
import { staticExchangeEval, moveGivesCheck, tacticalVolatility, hasNearPromotion } from './tactics.js';

// Production wrapper around the instrumented V2 core. The core intentionally
// favors clarity while this layer keeps qsearch/ponder work inside browser-sized
// budgets. Methods remain generic and are also used by the CI match harness.
export class SearchEngine extends CoreSearchEngine {
  search(position, options = {}) {
    const criticality = options.criticality ?? tacticalVolatility(position);
    const previousGuard = this.config.enableBlunderGuard;
    // The tactical seatbelt is useful in unstable positions. Running it after a
    // completely quiet root only burns time and reduces completed depth.
    if (criticality < 45) this.config.enableBlunderGuard = false;
    try {
      return super.search(position, { ...options, criticality });
    } finally {
      this.config.enableBlunderGuard = previousGuard;
    }
  }

  quiescence(position, alpha, beta, ply, qDepth = 0) {
    this.qnodes++;
    if (position.halfmove >= 100 || position.isInsufficientMaterial()) return 0;
    const inCheck = position.isInCheck();

    const stand = this.staticEval(position);
    if (!inCheck) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }
    if (qDepth >= 7 || this.timeUp()) return inCheck ? alpha : Math.max(alpha, stand);

    let moves;
    if (inCheck) {
      moves = position.legalMoves();
      if (!moves.length) return -MATE_SCORE + ply;
    } else {
      // Captures are the ordinary qsearch frontier. Do not generate every quiet
      // legal move at every leaf merely to discover that almost all are quiet.
      moves = position.legalMoves({ capturesOnly: true });
      let all = null;

      // Quiet/capture promotions and one-step pre-promotions are never quiet.
      if (hasNearPromotion(position, position.turn)) {
        all = position.legalMoves();
        for (const move of all) {
          const [row] = rowCol(move.to);
          const prePromotion = typeOf(move.piece) === 'p'
            && ((colorOf(move.piece) === 'w' && row === 1) || (colorOf(move.piece) === 'b' && row === 6));
          if ((move.promotion || prePromotion) && !moves.some(m => moveToUci(m) === moveToUci(move))) moves.push(move);
        }
      }

      // At the first horizon of a genuinely volatile root, add a small set of
      // checks. Deeper checking continuations are handled by normal check
      // extensions once they enter the principal search.
      if (qDepth === 0 && this.criticality >= 65) {
        all ||= position.legalMoves();
        const checks = all.filter(move => !(move.flags & FLAGS.CAPTURE) && !move.promotion && moveGivesCheck(position, move)).slice(0, 6);
        for (const move of checks) if (!moves.some(m => moveToUci(m) === moveToUci(move))) moves.push(move);
      }
    }

    moves = this.orderMoves(position, moves, ply, null);
    if (!inCheck && moves.length > 14) moves = moves.slice(0, 14);

    for (const move of moves) {
      if (this.timeUp()) break;
      if (!inCheck && (move.flags & FLAGS.CAPTURE) && !move.promotion && qDepth > 0) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const see = staticExchangeEval(position, move);
        // Negative SEE only prunes when a generous delta bound also says the
        // move cannot matter. Checks/promotions are never discarded here.
        if (see < -140 && stand + victim + 160 < alpha) { this.qPrunes++; continue; }
      }
      const score = -this.quiescence(position.makeMove(move), -beta, -alpha, ply + 1, qDepth + 1);
      if (score >= beta) return beta;
      if (score > alpha) alpha = score;
    }
    return alpha;
  }

  orderMoves(position, moves, ply, ttMove) {
    const killers = this.killers[ply] || [];
    const scored = moves.map(move => {
      const u = moveToUci(move);
      let score = 0;
      if (ttMove === u) score += 1_000_000;
      if (move.promotion) score += 125_000 + (PIECE_VALUES[move.promotion] || 0);
      if (move.flags & FLAGS.CAPTURE) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
        const see = staticExchangeEval(position, move);
        score += 85_000 + victim * 12 - attacker + Math.max(-1400, Math.min(1400, see * 4));
      } else if (ply <= 4 && moveGivesCheck(position, move)) {
        score += 60_000;
      }
      if (killers[0] === u) score += 18_000;
      else if (killers[1] === u) score += 14_000;
      score += Math.min(30000, this.history.get(u) || 0);
      return { move, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.move);
  }

  predictBranches(position, count = 4, options = {}) {
    const totalMs = Math.max(120, options.timeMs ?? 280);
    const predictionDepth = Math.max(2, Math.min(5, (options.depth ?? this.config.maxDepth) - 1));
    const opponentMs = Math.max(55, Math.floor(totalMs * 0.46));
    const responseMs = Math.max(35, Math.floor((totalMs - opponentMs) / Math.max(1, count)));

    const opponentEngine = new SearchEngine({
      ...this.config,
      maxDepth: predictionDepth,
      moveTimeMs: opponentMs,
      nodeLimit: 70000,
      selectionWindow: 0,
      evalNoise: 0,
      enableBlunderGuard: false,
    });
    const opponent = opponentEngine.search(position, {
      maxDepth: predictionDepth,
      moveTimeMs: opponentMs,
      maxMoveTimeMs: opponentMs,
    });

    const ucis = [];
    if (opponent.move) ucis.push(moveToUci(opponent.move));
    for (const candidate of opponent.candidates || []) if (!ucis.includes(candidate.uci)) ucis.push(candidate.uci);
    if (ucis.length < count) {
      const fallback = [...position.legalMoves()]
        .map(move => ({ move, score: -evaluate(position.makeMove(move), position.turn) }))
        .sort((a, b) => b.score - a.score);
      for (const row of fallback) {
        const uci = moveToUci(row.move);
        if (!ucis.includes(uci)) ucis.push(uci);
        if (ucis.length >= count) break;
      }
    }

    const branches = [];
    for (const uci of ucis.slice(0, count)) {
      const move = position.moveFromUci(uci);
      if (!move) continue;
      const after = position.makeMove(move);
      const responseEngine = new SearchEngine({
        ...this.config,
        maxDepth: predictionDepth,
        moveTimeMs: responseMs,
        nodeLimit: 50000,
        enableBlunderGuard: false,
      });
      const response = responseEngine.search(after, {
        maxDepth: predictionDepth,
        moveTimeMs: responseMs,
        maxMoveTimeMs: responseMs,
      });
      if (!response.move) continue;
      branches.push({
        opponentMove: uci,
        engineMove: moveToUci(response.move),
        evaluation: -(response.objectiveScore ?? response.score ?? 0),
        depth: response.depth,
        responseTimeMs: response.timeMs,
        criticality: response.criticality,
        continuation: [uci, ...response.pv.map(moveToUci)].slice(0, 7),
      });
    }
    return branches;
  }
}

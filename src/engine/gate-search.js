import { FLAGS, Position, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, opposite, typeOf } from '../chess/constants.js';
import { MATE_SCORE } from './evaluation.js';
import { StrongSearchEngine } from './strong-search.js';
import { cheapVolatility, hasNearPromotion, rootTacticalRisk } from './tactics.js';

const INF = 1_000_000;
const MATE_TT_BOUND = MATE_SCORE - 1000;

function rootCap(depth) {
  if (depth <= 2) return Infinity;
  if (depth === 3) return 10;
  if (depth === 4) return 7;
  if (depth === 5) return 5;
  if (depth === 6) return 4;
  return 3;
}

function isForcingRootMove(position, move) {
  if ((move.flags & FLAGS.CAPTURE) || move.promotion) return true;
  return position.makeMove(move).isInCheck();
}

function nonPawnMaterial(position, color) {
  let total = 0;
  for (const piece of position.board) {
    if (!piece || colorOf(piece) !== color) continue;
    const t = typeOf(piece);
    if (t === 'p' || t === 'k') continue;
    total += PIECE_VALUES[t] || 0;
  }
  return total;
}

function nullPosition(position) {
  return new Position({
    board: position.board,
    turn: opposite(position.turn),
    castling: position.castling,
    epSquare: null,
    halfmove: position.halfmove + 1,
    fullmove: position.fullmove + (position.turn === 'b' ? 1 : 0),
  });
}

function scoreToTT(score, ply) {
  if (score > MATE_TT_BOUND) return score + ply;
  if (score < -MATE_TT_BOUND) return score - ply;
  return score;
}

function scoreFromTT(score, ply) {
  if (score > MATE_TT_BOUND) return score - ply;
  if (score < -MATE_TT_BOUND) return score + ply;
  return score;
}

function allowsImmediateMate(position, move) {
  if (!move) return false;
  const after = position.makeMove(move);
  for (const reply of after.legalMoves()) {
    const next = after.makeMove(reply);
    if (next.isInCheck() && next.legalMoves().length === 0) return true;
  }
  return false;
}

/**
 * Search variant dedicated to the 1650 literal-win gate.
 *
 * Every legal root move gets a depth-two audition. Deeper iterations use a
 * progressively tighter beam plus forcing moves. The complete depth-two set is
 * retained for post-search tactical/safety rescue so pruning a candidate from
 * the deep beam cannot erase a legal defensive resource altogether.
 */
export class GateSearchEngine extends StrongSearchEngine {
  search(position, options = {}) {
    if (this.lastRootHash !== position.hash) {
      this.rootOrder = [];
      this.broadRootLines = [];
    }
    this.lastRootHash = position.hash;

    const result = super.search(position, options);

    // The generic practical-safety wrapper only sees result.candidates. Expose
    // the strongest exact depth-two lines as additional rescue candidates so a
    // move that fell just outside the deeper beam can still save a hanging
    // major piece. These are never allowed to overrule objective search merely
    // for style; they are available only to bounded post-search guardrails.
    const merged = [];
    const seen = new Set();
    const append = candidate => {
      if (!candidate?.uci || seen.has(candidate.uci)) return;
      seen.add(candidate.uci);
      merged.push(candidate);
    };
    for (const candidate of result.candidates || []) append(candidate);
    for (const line of this.broadRootLines || []) {
      if (line.exact === false) continue;
      append({
        uci: moveToUci(line.move),
        score: line.score,
        pv: line.pv.map(moveToUci),
        personality: 0,
        exact: true,
        shallowRescue: true,
      });
      if (merged.length >= 14) break;
    }
    return { ...result, candidates: merged };
  }

  searchRoot(position, depth, options = {}) {
    const excluded = new Set(options.excludeMoves || []);
    let moves = this.orderMoves(position, position.legalMoves(), 0, null)
      .filter(move => !excluded.has(moveToUci(move)));

    if (this.rootOrder.length) {
      const rank = new Map(this.rootOrder.map((uci, index) => [uci, index]));
      moves = [...moves].sort((a, b) => {
        const ar = rank.has(moveToUci(a)) ? rank.get(moveToUci(a)) : 999;
        const br = rank.has(moveToUci(b)) ? rank.get(moveToUci(b)) : 999;
        return ar - br;
      });
    }

    if (!moves.length) {
      const score = position.isInCheck() ? -MATE_SCORE : 0;
      return { bestMove: null, score, pv: [], lines: [], complete: true };
    }

    const cap = rootCap(depth);
    if (Number.isFinite(cap) && moves.length > cap && this.rootOrder.length) {
      const kept = moves.slice(0, cap);
      const keptUci = new Set(kept.map(moveToUci));
      let forcingExtras = 0;
      for (const move of moves.slice(cap)) {
        if (forcingExtras >= 5) break;
        if (!isForcingRootMove(position, move)) continue;
        const uci = moveToUci(move);
        if (keptUci.has(uci)) continue;
        kept.push(move);
        keptUci.add(uci);
        forcingExtras++;
      }
      moves = kept;
    }

    const lines = [];
    const path = [position.hash];
    const verifyWindow = Math.min(8, Math.max(0, this.config.selectionWindow ?? 0));
    let bestMove = null;
    let bestScore = -INF;
    let bestPv = [];
    let complete = true;

    for (const move of moves) {
      if (this.timeUp()) { complete = false; break; }
      const next = position.makeMove(move);
      let score;
      let pv = [];
      let exact = true;

      if (bestMove == null) {
        score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
      } else {
        const threshold = bestScore - verifyWindow;
        score = -this.negamax(next, depth - 1, -threshold - 1, -threshold, 1, pv, path);
        if (this.timeUp()) { complete = false; break; }
        if (score >= threshold) {
          pv = [];
          score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
        } else {
          exact = false;
        }
      }

      if (this.timeUp()) { complete = false; break; }
      const line = { move, score, pv: [move, ...pv], personality: 0, exact };
      lines.push(line);
      if (exact && score > bestScore) {
        bestScore = score;
        bestMove = move;
        bestPv = line.pv;
      }
    }

    lines.sort((a, b) => {
      if (a.exact !== b.exact) return a.exact ? -1 : 1;
      return b.score - a.score;
    });

    if (depth <= 2 && complete && lines.length === moves.length) {
      this.broadRootLines = lines.map(line => ({ ...line, pv: [...line.pv] }));
    }

    if (bestMove == null && lines.length) {
      bestMove = lines[0].move;
      bestScore = lines[0].score;
      bestPv = lines[0].pv;
    }
    return {
      bestMove,
      score: bestScore,
      pv: bestPv,
      lines,
      complete: complete && lines.length === moves.length,
    };
  }

  negamax(position, depth, alpha, beta, ply, pvOut, pathHashes, allowNull = true) {
    this.nodes++;
    if ((this.nodes & 511) === 0 && this.timeUp()) return this.staticEval(position);

    let priorOccurrences = 0;
    for (const hash of pathHashes) if (hash === position.hash) priorOccurrences++;
    if (priorOccurrences >= 2) return this.repetitionUtility(position);
    if (position.halfmove >= 100) return 0;

    const inCheck = position.isInCheck();
    if (inCheck && depth < 8) depth++;

    const halfmoveKey = position.halfmove >= 88 ? position.halfmove : 0;
    const key = `g:${position.hash.toString()}:${halfmoveKey}`;
    const tt = this.tt.get(key);
    if (tt && tt.depth >= depth) {
      this.ttHits++;
      const ttScore = scoreFromTT(tt.score, ply);
      if (tt.flag === 'exact') return ttScore;
      if (tt.flag === 'lower') alpha = Math.max(alpha, ttScore);
      else if (tt.flag === 'upper') beta = Math.min(beta, ttScore);
      if (alpha >= beta) return ttScore;
    }

    if (position.isInsufficientMaterial()) return 0;
    if (depth <= 0) return this.quiescence(position, alpha, beta, ply, 0);

    const staticScore = this.staticEval(position);

    if (
      allowNull
      && depth >= 3
      && !inCheck
      && position.halfmove < 88
      && beta < MATE_TT_BOUND
      && beta > -MATE_TT_BOUND
      && nonPawnMaterial(position, position.turn) >= 500
      && staticScore >= beta - 20
    ) {
      const reduction = depth >= 6 ? 3 : 2;
      const nullScore = -this.negamax(
        nullPosition(position),
        Math.max(0, depth - 1 - reduction),
        -beta,
        -beta + 1,
        ply + 1,
        [],
        pathHashes,
        false,
      );
      if (!this.timeUp() && nullScore >= beta) return beta;
    }

    if (depth === 1 && !inCheck && staticScore + 210 <= alpha) {
      const q = this.quiescence(position, alpha, beta, ply, 0);
      if (q <= alpha) return q;
    }

    const moves = this.orderMoves(position, position.legalMoves(), ply, tt?.move || null);
    if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;

    const originalAlpha = alpha;
    const originalBeta = beta;
    let bestScore = -INF;
    let bestMove = null;
    let bestPv = [];
    const volatile = depth >= 3 && (cheapVolatility(position) >= 52 || hasNearPromotion(position));

    for (let i = 0; i < moves.length; i++) {
      if (this.timeUp()) break;
      const move = moves[i];
      const next = position.makeMove(move);
      const quiet = !(move.flags & FLAGS.CAPTURE) && !move.promotion;
      const givesCheck = quiet && (depth === 1 || depth >= 3) && next.isInCheck();

      if (!inCheck && quiet && !givesCheck && !volatile) {
        if (depth === 1 && i >= 3 && staticScore + 125 <= alpha) continue;
        if (depth === 2 && i >= 12 && staticScore + 90 <= alpha) continue;
      }

      let reduction = 0;
      if (depth >= 3 && i >= 5 && !inCheck && quiet && !givesCheck && !volatile) {
        reduction = depth >= 5 && i >= 9 ? 2 : 1;
      }

      const fullDepth = Math.max(0, depth - 1 + (move.promotion ? 1 : 0));
      const reducedDepth = Math.max(0, fullDepth - reduction);
      let childPv = [];
      let score;

      pathHashes.push(position.hash);
      if (i === 0) {
        score = -this.negamax(next, reducedDepth, -beta, -alpha, ply + 1, childPv, pathHashes, true);
        if (reduction && score > alpha && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -beta, -alpha, ply + 1, childPv, pathHashes, true);
        }
      } else {
        score = -this.negamax(next, reducedDepth, -alpha - 1, -alpha, ply + 1, childPv, pathHashes, true);
        if (reduction && score > alpha && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -alpha - 1, -alpha, ply + 1, childPv, pathHashes, true);
        }
        if (score > alpha && score < beta && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -beta, -alpha, ply + 1, childPv, pathHashes, true);
        }
      }
      pathHashes.pop();

      if (this.timeUp()) break;
      if (score > bestScore) {
        bestScore = score;
        bestMove = move;
        bestPv = [move, ...childPv];
      }
      if (score > alpha) alpha = score;

      if (alpha >= beta) {
        this.cutoffs++;
        if (quiet) {
          const u = moveToUci(move);
          const k = this.killers[ply] || [null, null];
          if (k[0] !== u) this.killers[ply] = [u, k[0]];
          this.history.set(u, Math.min(50000, (this.history.get(u) || 0) + depth * depth));
        }
        break;
      }
    }

    if (bestMove == null) return this.staticEval(position);
    pvOut.push(...bestPv);
    if (this.timeUp()) return bestScore;

    const flag = bestScore <= originalAlpha ? 'upper' : bestScore >= originalBeta ? 'lower' : 'exact';
    this.tt.set(key, {
      depth,
      score: scoreToTT(bestScore, ply),
      flag,
      move: moveToUci(bestMove),
    });

    if (this.tt.size > 220000) {
      let removed = 0;
      for (const k of this.tt.keys()) {
        this.tt.delete(k);
        if (++removed >= 44000) break;
      }
    }

    return bestScore;
  }

  personalitySelect(position, lines, bestFallback) {
    const initial = super.personalitySelect(position, lines, bestFallback);
    if (!initial?.move || !allowsImmediateMate(position, initial.move)) return initial;

    const merged = [];
    const seen = new Set();
    for (const line of [...(lines || []), ...(this.broadRootLines || [])]) {
      const uci = moveToUci(line.move);
      if (seen.has(uci)) continue;
      seen.add(uci);
      if (allowsImmediateMate(position, line.move)) continue;
      merged.push(line);
    }
    if (!merged.length) return initial;

    merged.sort((a, b) => {
      if ((a.exact !== false) !== (b.exact !== false)) return a.exact === false ? 1 : -1;
      return b.score - a.score;
    });
    const pick = merged[0];
    return {
      move: pick.move,
      score: pick.score,
      objectiveScore: pick.score,
      pv: pick.pv,
      risk: rootTacticalRisk(position, pick.move, this.seeMemo),
      mateRescue: {
        from: moveToUci(initial.move),
        to: moveToUci(pick.move),
      },
    };
  }
}

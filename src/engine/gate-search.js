import { FLAGS, Position, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf, opposite } from '../chess/constants.js';
import { epKey, normalizeHash, turnKey } from '../chess/zobrist.js';
import { MATE_SCORE } from './evaluation.js';
import { StrongSearchEngine } from './strong-search.js';
import { cheapVolatility, hasNearPromotion } from './tactics.js';

const INF = 1_000_000;
const MATE_TT_BOUND = MATE_SCORE - 1000;

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

function nonPawnMaterial(position, color) {
  let total = 0;
  for (const piece of position.board) {
    if (!piece || colorOf(piece) !== color) continue;
    const type = typeOf(piece);
    if (type === 'p' || type === 'k') continue;
    total += PIECE_VALUES[type] || 0;
  }
  return total;
}

function makeNullMove(position) {
  // Null move is search-only. The side to move changes, en-passant expires,
  // castling rights and pieces remain untouched, and the zobrist hash mirrors
  // exactly those state changes.
  const hash = normalizeHash(position.hash ^ epKey(position.epSquare) ^ turnKey());
  return new Position({
    board: position.board,
    turn: opposite(position.turn),
    castling: position.castling,
    epSquare: null,
    halfmove: position.halfmove + 1,
    fullmove: position.fullmove + (position.turn === 'b' ? 1 : 0),
    hash,
  });
}

/**
 * Search variant dedicated to the 1650 literal-win gate.
 *
 * The full-root safety repair removed a large source of false pruning, but it
 * also exposed the real bottleneck: Vanta averages only about depth three at
 * 650 ms. This class keeps StrongSearchEngine's evaluator, qsearch, ordering,
 * personality and timing, and adds conservative null-move pruning plus a less
 * fragmented transposition key. It never grants Vanta extra clock time.
 */
export class GateSearchEngine extends StrongSearchEngine {
  resetStats() {
    super.resetStats();
    this.nullPrunes = 0;
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

    // fastEvaluate() has no fullmove-dependent terms. Keeping fullmove in the
    // TT key needlessly split otherwise identical positions and reduced reuse.
    const key = `g:${position.hash.toString()}:${Math.min(position.halfmove, 100)}`;
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

    // Generate legality before null pruning so a stalemate can never be turned
    // into a beta cutoff. Ordering is deferred until after the null test.
    const legalMoves = position.legalMoves();
    if (legalMoves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;

    // Conservative null-move pruning. Only try it when the static position is
    // already comfortably above beta and the side has enough non-pawn material
    // that classical zugzwang is unlikely. Tactical/promotion nodes stay fully
    // searched. Consecutive null moves are forbidden.
    if (
      allowNull
      && !inCheck
      && depth >= 4
      && position.halfmove < 90
      && Math.abs(beta) < MATE_TT_BOUND
      && nonPawnMaterial(position, position.turn) >= 500
      && !hasNearPromotion(position)
    ) {
      const stand = this.staticEval(position);
      if (stand >= beta + 35 && cheapVolatility(position) < 64) {
        const reduction = depth >= 7 ? 3 : 2;
        const nullDepth = Math.max(0, depth - 1 - reduction);
        const nullPosition = makeNullMove(position);
        const nullPv = [];
        pathHashes.push(position.hash);
        const score = -this.negamax(
          nullPosition,
          nullDepth,
          -beta,
          -beta + 1,
          ply + 1,
          nullPv,
          pathHashes,
          false,
        );
        pathHashes.pop();
        if (!this.timeUp() && score >= beta) {
          this.nullPrunes++;
          this.cutoffs++;
          return score;
        }
      }
    }

    const moves = this.orderMoves(position, legalMoves, ply, tt?.move || null);
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
      const givesCheck = depth >= 3 && next.isInCheck();
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
          const uci = moveToUci(move);
          const killers = this.killers[ply] || [null, null];
          if (killers[0] !== uci) this.killers[ply] = [uci, killers[0]];
          this.history.set(uci, Math.min(50000, (this.history.get(uci) || 0) + depth * depth));
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

    if (this.tt.size > 180000) {
      let removed = 0;
      for (const oldKey of this.tt.keys()) {
        this.tt.delete(oldKey);
        if (++removed >= 36000) break;
      }
    }

    return bestScore;
  }
}

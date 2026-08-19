import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf, rowCol } from '../chess/constants.js';
import { evaluate, personalityMoveBonus, MATE_SCORE } from './evaluation-v2.js';
import { strengthConfig, VANTA_PERSONALITY } from './personality.js';
import {
  staticExchangeEval, moveGivesCheck, tacticalVolatility, hasNearPromotion,
  isTacticallyQuietMove,
} from './tactics.js';

const INF = 1_000_000;
const MATE_TT_BOUND = MATE_SCORE - 1000;

export class SearchEngine {
  constructor(config = {}) {
    this.config = {
      ...strengthConfig(1500),
      enableBlunderGuard: true,
      disableLMR: false,
      ...config,
    };
    this.tt = new Map();
    this.history = new Map();
    this.killers = Array.from({ length: 64 }, () => [null, null]);
    this.rootOrder = [];
    this.evalCache = new Map();
    this.resetStats();
  }

  resetStats() {
    this.nodes = 0;
    this.qnodes = 0;
    this.ttHits = 0;
    this.ttCutoffs = 0;
    this.cutoffs = 0;
    this.lmrReductions = 0;
    this.qPrunes = 0;
    this.start = 0;
    this.deadline = 0;
    this.stopped = false;
    this.depthTrace = [];
    this.criticality = 0;
    this.allocatedTimeMs = 0;
    this.guardReport = null;
    this.evalCache.clear();
  }

  stop() { this.stopped = true; }

  timeUp() {
    return this.stopped
      || (this.nodes + this.qnodes) >= this.config.nodeLimit
      || (this.deadline && performanceNow() >= this.deadline);
  }

  staticEval(position, perspective = position.turn) {
    const key = `${position.hash.toString()}:${perspective}:${Math.min(position.fullmove, 15)}`;
    const cached = this.evalCache.get(key);
    if (cached !== undefined) return cached;
    const score = evaluate(position, perspective);
    this.evalCache.set(key, score);
    if (this.evalCache.size > 40000) {
      let removed = 0;
      for (const k of this.evalCache.keys()) {
        this.evalCache.delete(k);
        if (++removed >= 8000) break;
      }
    }
    return score;
  }

  search(position, options = {}) {
    this.resetStats();
    this.start = performanceNow();
    this.criticality = options.criticality ?? tacticalVolatility(position);
    const plan = allocateTime(position, this.config, options, this.criticality);
    this.allocatedTimeMs = plan.totalMs;
    this.deadline = this.start + plan.searchMs;

    const baseDepth = options.maxDepth ?? this.config.maxDepth;
    const maxDepth = Math.min(9, baseDepth + (this.criticality >= 82 ? 2 : this.criticality >= 58 ? 1 : 0));
    if (options.rootHint) this.rootOrder = [options.rootHint, ...this.rootOrder.filter(x => x !== options.rootHint)];

    let best = null;
    let partial = null;
    let completedDepth = 0;
    let rootLines = [];
    let previous = null;

    for (let depth = 1; depth <= maxDepth; depth++) {
      const result = this.searchRoot(position, depth, options);
      if (result.bestMove) partial = result;
      if (!result.complete) break;
      if (result.bestMove) {
        best = result;
        completedDepth = depth;
        rootLines = result.lines;
        this.rootOrder = result.lines.map(line => moveToUci(line.move));
        const exact = result.lines.filter(line => line.exact !== false).sort((a, b) => b.score - a.score);
        const bestUci = moveToUci(result.bestMove);
        const gap = exact.length > 1 ? exact[0].score - exact[1].score : INF;
        const trace = {
          depth,
          move: bestUci,
          score: result.score,
          gap,
          pv: result.pv.map(moveToUci),
          changed: Boolean(previous && previous.move !== bestUci),
          evalSwing: previous ? Math.abs(previous.score - result.score) : 0,
        };
        this.depthTrace.push(trace);
        previous = trace;
      }
      if (Math.abs(result.score) >= MATE_SCORE - 1000) break;
      if (this.timeUp()) break;

      const elapsed = performanceNow() - this.start;
      const trace = this.depthTrace.at(-1);
      const stable = this.depthTrace.length >= 2
        && !trace.changed
        && trace.evalSwing < 70
        && trace.gap >= 38;
      const minimumUsefulDepth = this.criticality >= 60 ? 4 : 3;
      if (completedDepth >= minimumUsefulDepth && elapsed >= plan.softMs && stable) break;
    }

    const elapsedMain = Math.max(1, performanceNow() - this.start);
    if (!best && partial?.bestMove) best = partial;
    if (!best) {
      const excluded = new Set(options.excludeMoves || []);
      const allLegal = position.legalMoves();
      const legal = allLegal.filter(move => !excluded.has(moveToUci(move)));
      const fallback = legal.length ? legal : allLegal;
      if (fallback.length) {
        const move = fallback[0];
        best = { bestMove: move, score: -this.staticEval(position.makeMove(move)), pv: [move], lines: [] };
      } else {
        const terminalScore = position.isInCheck() ? -MATE_SCORE : 0;
        best = { bestMove: null, score: terminalScore, pv: [], lines: [] };
      }
    }

    const selectionLines = completedDepth > 0 ? rootLines : [];
    let chosen = this.personalitySelect(position, selectionLines, best);
    const candidateLines = completedDepth > 0 ? rootLines : [];

    if (this.config.enableBlunderGuard !== false && plan.guardMs >= 20 && candidateLines.length > 1 && Math.abs(best.score) < MATE_SCORE - 1000) {
      const guarded = this.blunderGuard(position, chosen, candidateLines, plan.guardMs);
      if (guarded) chosen = guarded;
    }

    const elapsed = Math.max(1, performanceNow() - this.start);
    return {
      move: chosen.move || best.bestMove,
      score: chosen.score ?? best.score,
      objectiveScore: chosen.objectiveScore ?? best.score,
      pv: chosen.pv || best.pv,
      depth: completedDepth,
      selectiveDepth: completedDepth + (this.criticality >= 58 ? 1 : 0),
      nodes: this.nodes,
      qnodes: this.qnodes,
      ttHits: this.ttHits,
      ttCutoffs: this.ttCutoffs,
      cutoffs: this.cutoffs,
      lmrReductions: this.lmrReductions,
      qPrunes: this.qPrunes,
      timeMs: Math.round(elapsed),
      mainSearchMs: Math.round(elapsedMain),
      allocatedTimeMs: plan.totalMs,
      criticality: this.criticality,
      nps: Math.round((this.nodes + this.qnodes) * 1000 / elapsed),
      depthTrace: this.depthTrace,
      guard: this.guardReport,
      candidates: candidateLines.slice(0, 8).map(x => ({
        uci: moveToUci(x.move),
        score: x.score,
        pv: x.pv.map(moveToUci),
        personality: x.personality || 0,
        exact: x.exact !== false,
      })),
    };
  }

  searchRoot(position, depth, options = {}) {
    const excluded = new Set(options.excludeMoves || []);
    let moves = this.orderMoves(position, position.legalMoves(), 0, null)
      .filter(move => !excluded.has(moveToUci(move)));

    const hintOrder = [];
    if (options.rootHint) hintOrder.push(options.rootHint);
    for (const uci of this.rootOrder) if (!hintOrder.includes(uci)) hintOrder.push(uci);
    if (hintOrder.length) {
      const rank = new Map(hintOrder.map((uci, index) => [uci, index]));
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

    const lines = [];
    const path = [position.hash];
    const personalityWindow = Math.max(0, this.config.selectionWindow ?? 0);
    let bestMove = null, bestScore = -INF, bestPv = [];
    let complete = true;

    for (const move of moves) {
      if (this.timeUp()) { complete = false; break; }
      const next = position.makeMove(move);
      let score, pv = [], exact = true;

      if (bestMove == null) {
        score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
      } else {
        const threshold = bestScore - personalityWindow;
        score = -this.negamax(next, depth - 1, -threshold - 1, -threshold, 1, pv, path);
        if (this.timeUp()) { complete = false; break; }
        if (score >= threshold) {
          pv = [];
          score = -this.negamax(next, depth - 1, -INF, INF, 1, pv, path);
        } else exact = false;
      }
      if (this.timeUp()) { complete = false; break; }

      const line = { move, score, pv: [move, ...pv], personality: personalityMoveBonus(position, move), exact };
      lines.push(line);
      if (exact && score > bestScore) {
        bestScore = score;
        bestMove = move;
        bestPv = line.pv;
      }
    }

    lines.sort((a, b) => a.exact !== b.exact ? (a.exact ? -1 : 1) : b.score - a.score);
    if (bestMove == null && lines.length) {
      bestMove = lines[0].move;
      bestScore = lines[0].score;
      bestPv = lines[0].pv;
    }
    return { bestMove, score: bestScore, pv: bestPv, lines, complete: complete && lines.length === moves.length };
  }

  negamax(position, depth, alpha, beta, ply, pvOut, pathHashes) {
    this.nodes++;
    if ((this.nodes & 255) === 0 && this.timeUp()) return this.staticEval(position);

    let priorOccurrences = 0;
    for (const hash of pathHashes) if (hash === position.hash) priorOccurrences++;
    if (priorOccurrences >= 2) return this.repetitionUtility(position);
    if (position.halfmove >= 100) return 0;

    const inCheck = position.isInCheck();
    if (inCheck && depth < 8) depth++;

    const key = `${position.hash.toString()}:${Math.min(position.halfmove, 100)}:${Math.min(position.fullmove, 15)}`;
    const tt = this.tt.get(key);
    if (tt && tt.depth >= depth) {
      this.ttHits++;
      const ttScore = scoreFromTT(tt.score, ply);
      if (tt.flag === 'exact') return ttScore;
      if (tt.flag === 'lower') alpha = Math.max(alpha, ttScore);
      else if (tt.flag === 'upper') beta = Math.min(beta, ttScore);
      if (alpha >= beta) { this.ttCutoffs++; return ttScore; }
    }

    if (position.isInsufficientMaterial()) return 0;
    if (depth <= 0) return this.quiescence(position, alpha, beta, ply, 0);

    const moves = this.orderMoves(position, position.legalMoves(), ply, tt?.move || null);
    if (moves.length === 0) return inCheck ? -MATE_SCORE + ply : 0;

    const originalAlpha = alpha, originalBeta = beta;
    let bestScore = -INF, bestMove = null, bestPv = [];
    const promotionCritical = hasNearPromotion(position);

    for (let i = 0; i < moves.length; i++) {
      if (this.timeUp()) break;
      const move = moves[i];
      const next = position.makeMove(move);
      const quiet = isTacticallyQuietMove(position, move, next);
      const [toRow] = rowCol(move.to);
      const createsNearPromotion = typeOf(move.piece) === 'p'
        && ((colorOf(move.piece) === 'w' && toRow === 1) || (colorOf(move.piece) === 'b' && toRow === 6));
      const extension = (move.promotion || createsNearPromotion || hasNearPromotion(next, next.turn)) && ply < 12 && depth < 8 ? 1 : 0;

      let reduction = 0;
      if (!this.config.disableLMR && depth >= 4 && i >= 5 && !inCheck && !promotionCritical && quiet && !extension) reduction = 1;
      if (reduction) this.lmrReductions++;

      const fullDepth = depth - 1 + extension;
      const reducedDepth = Math.max(0, fullDepth - reduction);
      let childPv = [], score;

      pathHashes.push(position.hash);
      if (i === 0) {
        score = -this.negamax(next, reducedDepth, -beta, -alpha, ply + 1, childPv, pathHashes);
        if (reduction && score > alpha && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -beta, -alpha, ply + 1, childPv, pathHashes);
        }
      } else {
        score = -this.negamax(next, reducedDepth, -alpha - 1, -alpha, ply + 1, childPv, pathHashes);
        if (reduction && score > alpha && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -alpha - 1, -alpha, ply + 1, childPv, pathHashes);
        }
        if (score > alpha && score < beta && !this.timeUp()) {
          childPv = [];
          score = -this.negamax(next, fullDepth, -beta, -alpha, ply + 1, childPv, pathHashes);
        }
      }
      pathHashes.pop();
      if (this.timeUp()) break;

      if (score > bestScore) { bestScore = score; bestMove = move; bestPv = [move, ...childPv]; }
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
    this.tt.set(key, { depth, score: scoreToTT(bestScore, ply), flag, move: moveToUci(bestMove) });
    if (this.tt.size > 180000) {
      let removed = 0;
      for (const k of this.tt.keys()) { this.tt.delete(k); if (++removed >= 36000) break; }
    }
    return bestScore;
  }

  quiescence(position, alpha, beta, ply, qDepth = 0) {
    this.qnodes++;
    if (position.halfmove >= 100 || position.isInsufficientMaterial()) return 0;
    const inCheck = position.isInCheck();
    const legal = position.legalMoves();
    if (legal.length === 0) return inCheck ? -MATE_SCORE + ply : 0;

    const stand = this.staticEval(position);
    if (!inCheck) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }
    if (qDepth >= 8 || this.timeUp()) return inCheck ? alpha : Math.max(alpha, stand);

    const enemyNearPromotion = hasNearPromotion(position, position.turn === 'w' ? 'b' : 'w');
    let moves = inCheck ? legal : legal.filter(move => {
      if (move.flags & FLAGS.CAPTURE || move.promotion) return true;
      const piece = typeOf(move.piece);
      const [row] = rowCol(move.to);
      if (piece === 'p' && ((colorOf(move.piece) === 'w' && row === 1) || (colorOf(move.piece) === 'b' && row === 6))) return true;
      if (qDepth < 2 && moveGivesCheck(position, move)) return true;
      if (enemyNearPromotion && qDepth < 2) {
        const child = position.makeMove(move);
        return !child.legalMoves().some(reply => reply.promotion);
      }
      return false;
    });

    moves = this.orderMoves(position, moves, ply, null);
    if (!inCheck && moves.length > 18) moves = moves.slice(0, 18);

    for (const move of moves) {
      if (this.timeUp()) break;
      const givesCheck = !inCheck && qDepth < 3 ? moveGivesCheck(position, move) : false;
      if (!inCheck && (move.flags & FLAGS.CAPTURE) && !move.promotion && !givesCheck && qDepth > 0) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const see = staticExchangeEval(position, move);
        if (see < -120 && stand + victim + 140 < alpha) { this.qPrunes++; continue; }
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
      const check = ply <= 10 ? moveGivesCheck(position, move) : false;
      if (move.promotion) score += 120_000 + (PIECE_VALUES[move.promotion] || 0) + (check ? 25_000 : 0);
      if (move.flags & FLAGS.CAPTURE) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
        const see = staticExchangeEval(position, move);
        score += 82_000 + victim * 12 - attacker + Math.max(-1200, Math.min(1200, see * 4));
      }
      if (check) score += 58_000;
      if (killers[0] === u) score += 18_000;
      else if (killers[1] === u) score += 14_000;
      score += Math.min(30000, this.history.get(u) || 0);
      return { move, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.move);
  }

  personalitySelect(position, lines, bestFallback) {
    if (!lines?.length) return { move: bestFallback.bestMove, score: bestFallback.score, objectiveScore: bestFallback.score, pv: bestFallback.pv };
    const exactLines = lines.filter(line => line.exact !== false);
    const pool = exactLines.length ? exactLines : lines;
    const bestScore = Math.max(...pool.map(line => line.score));
    if (Math.abs(bestScore) >= MATE_SCORE - 1000) {
      const forced = pool.find(line => line.score === bestScore) || pool[0];
      return { move: forced.move, score: bestScore, objectiveScore: bestScore, pv: forced.pv };
    }

    const window = this.config.selectionWindow ?? 32;
    const eligible = pool.filter(line => line.score >= bestScore - window);
    const scored = eligible.map(line => {
      const deterministicNoise = this.config.evalNoise ? pseudoNoise(position.hash, line.move, this.config.evalNoise) : 0;
      return { ...line, composite: line.score + (line.personality || 0) + deterministicNoise };
    }).sort((a, b) => b.composite - a.composite);
    const pick = scored[0] || pool[0];
    return { move: pick.move, score: pick.composite, objectiveScore: pick.score, pv: pick.pv };
  }

  blunderGuard(position, chosen, lines, guardMs) {
    const exact = lines.filter(line => line.exact !== false).sort((a, b) => b.score - a.score);
    const unique = [];
    const add = move => {
      if (!move) return;
      const u = moveToUci(move);
      if (!unique.some(x => x.uci === u)) unique.push({ move, uci: u });
    };
    add(chosen.move);
    for (const line of exact.slice(0, 4)) add(line.move);
    const candidates = unique.slice(0, 3);
    if (candidates.length < 2) return null;

    const perMove = Math.max(22, Math.floor(guardMs / candidates.length));
    const probes = [];
    for (const candidate of candidates) {
      const child = position.makeMove(candidate.move);
      const guard = new SearchEngine({
        ...this.config,
        maxDepth: 3,
        moveTimeMs: perMove,
        nodeLimit: 42000,
        selectionWindow: 0,
        evalNoise: 0,
        enableBlunderGuard: false,
        disableLMR: true,
      });
      const result = guard.search(child, { maxDepth: 3, moveTimeMs: perMove, criticality: 100 });
      probes.push({
        uci: candidate.uci,
        scoreForUs: -(result.objectiveScore ?? result.score ?? 0),
        opponentMove: result.move ? moveToUci(result.move) : null,
        pv: result.pv.map(moveToUci),
        depth: result.depth,
      });
    }

    probes.sort((a, b) => b.scoreForUs - a.scoreForUs);
    const selectedUci = chosen.move ? moveToUci(chosen.move) : null;
    const selectedProbe = probes.find(p => p.uci === selectedUci);
    const bestProbe = probes[0];
    this.guardReport = { selected: selectedUci, probes };
    if (!selectedProbe || !bestProbe || bestProbe.uci === selectedUci) return null;

    const severe = bestProbe.scoreForUs - selectedProbe.scoreForUs >= 165
      || (selectedProbe.scoreForUs <= -MATE_SCORE + 1000 && bestProbe.scoreForUs > -MATE_SCORE + 1000);
    if (!severe) return null;
    const line = exact.find(x => moveToUci(x.move) === bestProbe.uci);
    if (!line) return null;
    this.guardReport.rejected = selectedUci;
    this.guardReport.replacement = bestProbe.uci;
    return { move: line.move, score: line.score, objectiveScore: line.score, pv: line.pv };
  }

  repetitionUtility(position) {
    const staticScore = this.staticEval(position);
    const material = materialBalance(position, position.turn);
    const aversion = 180 + Math.round((VANTA_PERSONALITY.drawAversion / 100) * 520);
    if (material > 0 || staticScore >= 80) return -aversion;
    if (material < 0 || staticScore <= -80) return Math.round(aversion * 0.35);
    return 0;
  }

  predictBranches(position, count = 4, options = {}) {
    const predictionDepth = Math.max(3, Math.min(5, (options.depth ?? this.config.maxDepth) - 1));
    const opponentSearch = new SearchEngine({
      ...this.config,
      maxDepth: predictionDepth,
      moveTimeMs: Math.max(80, Math.floor((options.timeMs ?? 280) / 2)),
      nodeLimit: 90000,
      selectionWindow: 0,
      evalNoise: 0,
      enableBlunderGuard: false,
    });
    const root = opponentSearch.searchRoot(position, predictionDepth, {});
    const candidates = root.lines.filter(line => line.exact !== false).slice(0, count);
    const branches = [];

    for (const candidate of candidates) {
      const after = position.makeMove(candidate.move);
      const responseEngine = new SearchEngine({
        ...this.config,
        maxDepth: predictionDepth,
        moveTimeMs: Math.max(55, Math.floor((options.timeMs ?? 280) / count)),
        nodeLimit: 70000,
        enableBlunderGuard: false,
      });
      const response = responseEngine.search(after, {
        maxDepth: predictionDepth,
        moveTimeMs: Math.max(55, Math.floor((options.timeMs ?? 280) / count)),
      });
      if (response.move) {
        branches.push({
          opponentMove: moveToUci(candidate.move),
          engineMove: moveToUci(response.move),
          evaluation: -candidate.score,
          depth: response.depth,
          responseTimeMs: response.timeMs,
          criticality: response.criticality,
          continuation: [moveToUci(candidate.move), ...response.pv.map(moveToUci)].slice(0, 7),
        });
      }
    }
    return branches;
  }
}

function allocateTime(position, config, options, criticality) {
  const base = Math.max(40, options.moveTimeMs ?? config.moveTimeMs ?? 650);
  let multiplier = 0.72 + criticality / 92;
  if (position.fullmove <= 8 && criticality < 35) multiplier *= 0.82;
  if (criticality >= 75) multiplier += 0.18;
  let totalMs = Math.max(70, Math.min(options.maxMoveTimeMs ?? 1800, Math.round(base * multiplier)));

  const remaining = Number(options.remainingMs);
  if (Number.isFinite(remaining) && remaining > 0) {
    const reserve = Math.max(12000, remaining * 0.055);
    const safe = Math.max(60, (remaining - reserve) / 10);
    totalMs = Math.min(totalMs, safe);
  }

  const guardMs = config.enableBlunderGuard === false ? 0 : Math.min(120, Math.max(24, Math.round(totalMs * (criticality >= 55 ? 0.13 : 0.075))));
  const searchMs = Math.max(45, totalMs - guardMs);
  const softMs = Math.round(searchMs * (criticality >= 65 ? 0.82 : 0.66));
  return { totalMs: Math.round(totalMs), searchMs, softMs, guardMs };
}

function performanceNow() { return globalThis.performance?.now?.() ?? Date.now(); }

function pseudoNoise(hash, move, amplitude) {
  let x = Number((hash ^ BigInt(move.from * 131 + move.to * 17 + (move.promotion?.charCodeAt(0) || 0))) & 0xffffffffn) >>> 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  return Math.round((((x >>> 0) / 0xffffffff) * 2 - 1) * amplitude);
}

function materialBalance(position, color) {
  let score = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const value = PIECE_VALUES[typeOf(piece)] || 0;
    score += colorOf(piece) === color ? value : -value;
  }
  return score;
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

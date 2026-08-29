import { FLAGS, moveToUci } from '../chess/position.js';
import { PIECE_VALUES, colorOf, typeOf } from '../chess/constants.js';
import { evaluate, personalityMoveBonus, MATE_SCORE } from './evaluation.js';
import { strengthConfig, VANTA_PERSONALITY } from './personality.js';
import {
  staticExchangeEval, rootTacticalRisk, cheapVolatility, positionCriticality,
  hasNearPromotion, allocateRapidTime,
} from './tactics.js';
import {
  endgameStrategicScore, openingMoveDiscipline, isEndgameCriticalMove,
  isEndgamePassedPawnPush, rootImmediateMaterialLoss, quietTacticalThreatScore,
} from './strategic-discipline.js';

const INF = 1_000_000;
const MATE_TT_BOUND = MATE_SCORE - 1000;
const MATE_RISK = 99000;

export class SearchEngine {
  constructor(config = {}) {
    this.config = { ...strengthConfig(1500), ...config };
    this.tt = new Map();
    this.history = new Map();
    this.killers = Array.from({ length: 64 }, () => [null, null]);
    this.rootOrder = [];
    this.evalCache = new Map();
    this.seeMemo = new Map();
    this.resetStats();
  }

  resetStats() {
    this.nodes = 0;
    this.qnodes = 0;
    this.ttHits = 0;
    this.cutoffs = 0;
    this.start = 0;
    this.deadline = 0;
    this.softDeadline = 0;
    this.stopped = false;
    this.evalCache.clear();
    this.seeMemo.clear();
  }

  stop() { this.stopped = true; }

  timeUp() {
    return this.stopped
      || (this.nodes + this.qnodes) >= this.config.nodeLimit
      || (this.deadline && performanceNow() >= this.deadline);
  }

  staticEval(position, perspective = position.turn) {
    const key = `${position.hash.toString()}:${perspective}:${Math.min(position.fullmove, 16)}`;
    const cached = this.evalCache.get(key);
    if (cached !== undefined) return cached;
    // Opening development/queen/castling discipline is deliberately root-only.
    // Static search already evaluates development and king safety. Only the
    // genuinely new endgame specialist knowledge belongs at every leaf.
    const score = evaluate(position, perspective) + endgameStrategicScore(position, perspective);
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

    let timing;
    if (options.remainingTimeMs != null) {
      timing = allocateRapidTime(position, options.remainingTimeMs, options.incrementMs || 0);
    } else {
      const moveTimeMs = options.moveTimeMs ?? this.config.moveTimeMs;
      timing = {
        criticality: positionCriticality(position),
        softTimeMs: options.softTimeMs ?? Math.max(40, Math.floor(moveTimeMs * 0.72)),
        hardTimeMs: options.hardTimeMs ?? moveTimeMs,
        reserveMs: 0,
      };
    }

    this.softDeadline = this.start + timing.softTimeMs;
    this.deadline = this.start + timing.hardTimeMs;
    const maxDepth = options.maxDepth ?? this.config.maxDepth;

    let best = null;
    let partial = null;
    let completedDepth = 0;
    let rootLines = [];
    const iterations = [];
    let previousIteration = null;
    let unstable = true;

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
        const secondScore = exact.length > 1 ? exact[1].score : result.score - 999;
        const gap = result.score - secondScore;
        const item = { depth, bestMove: bestUci, score: result.score, gap };
        iterations.push(item);
        unstable = !previousIteration
          || previousIteration.bestMove !== bestUci
          || Math.abs(previousIteration.score - result.score) >= 65
          || gap < 28;
        previousIteration = item;
      }

      if (Math.abs(result.score) >= MATE_SCORE - 1000) break;
      if (this.timeUp()) break;
      if (performanceNow() >= this.softDeadline && !unstable) break;
    }

    const elapsed = Math.max(1, performanceNow() - this.start);

    if (!best && partial?.bestMove) best = partial;
    if (!best) {
      const excluded = new Set(options.excludeMoves || []);
      const allLegal = position.legalMoves();
      const legal = allLegal.filter(move => !excluded.has(moveToUci(move)));
      const fallback = legal.length ? legal : allLegal;
      if (fallback.length) {
        const move = fallback[0];
        best = {
          bestMove: move,
          score: -this.staticEval(position.makeMove(move)),
          pv: [move],
          lines: [],
        };
      } else {
        const terminalScore = position.isInCheck() ? -MATE_SCORE : 0;
        best = { bestMove: null, score: terminalScore, pv: [], lines: [] };
      }
    }

    const selectionLines = completedDepth > 0 ? rootLines : [];
    const chosen = this.personalitySelect(position, selectionLines, best);
    const candidateLines = completedDepth > 0 ? rootLines : [];

    return {
      move: chosen.move || best.bestMove,
      score: chosen.score ?? best.score,
      objectiveScore: chosen.objectiveScore ?? best.score,
      pv: chosen.pv || best.pv,
      depth: completedDepth,
      nodes: this.nodes,
      qnodes: this.qnodes,
      ttHits: this.ttHits,
      cutoffs: this.cutoffs,
      timeMs: Math.round(elapsed),
      nps: Math.round((this.nodes + this.qnodes) * 1000 / elapsed),
      criticality: timing.criticality,
      softTimeMs: timing.softTimeMs,
      hardTimeMs: timing.hardTimeMs,
      unstable,
      iterations,
      selectedRisk: chosen.risk ?? 0,
      candidates: candidateLines.slice(0, 6).map(x => ({
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

    const lines = [];
    const path = [position.hash];
    const personalityWindow = Math.max(0, this.config.selectionWindow ?? 0);
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
        const threshold = bestScore - personalityWindow;
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

      const line = {
        move,
        score,
        pv: [move, ...pv],
        personality: personalityMoveBonus(position, move) + openingMoveDiscipline(position, move),
        exact,
      };
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

  negamax(position, depth, alpha, beta, ply, pvOut, pathHashes) {
    this.nodes++;
    if ((this.nodes & 511) === 0 && this.timeUp()) return this.staticEval(position);

    let priorOccurrences = 0;
    for (const hash of pathHashes) if (hash === position.hash) priorOccurrences++;
    const inCheck = position.isInCheck();
    if (priorOccurrences >= 2) return this.repetitionUtility(position);
    // A second occurrence is not a terminal node. Only at the horizon do we
    // prefer progress over another cycle, preserving full tactical search.
    if (priorOccurrences >= 1 && depth <= 0 && !inCheck) return this.cycleUtility(position);
    if (position.halfmove >= 100) return 0;

    if (inCheck && depth < 8) depth++;

    const key = `${position.hash.toString()}:${Math.min(position.halfmove, 100)}:${Math.min(position.fullmove, 16)}`;
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
      const givesCheck = depth >= 3 && next.isInCheck();
      const endgameCritical = isEndgameCriticalMove(position, move);
      const passerPush = isEndgamePassedPawnPush(position, move);
      let reduction = 0;
      if (depth >= 3 && i >= 5 && !inCheck && quiet && !givesCheck && !volatile && !endgameCritical) {
        reduction = depth >= 5 && i >= 9 ? 2 : 1;
      }

      const endgameExtension = passerPush && depth <= 5 ? 1 : 0;
      const fullDepth = Math.max(0, depth - 1 + (move.promotion ? 1 : 0) + endgameExtension);
      const reducedDepth = Math.max(0, fullDepth - reduction);
      let childPv = [];
      let score;

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

    if (this.tt.size > 180000) {
      let removed = 0;
      for (const k of this.tt.keys()) {
        this.tt.delete(k);
        if (++removed >= 36000) break;
      }
    }

    return bestScore;
  }

  quiescence(position, alpha, beta, ply, qply = 0) {
    this.qnodes++;
    if (position.halfmove >= 100 || position.isInsufficientMaterial()) return 0;

    const inCheck = position.isInCheck();
    let moves = inCheck ? position.legalMoves() : position.legalMoves({ capturesOnly: true });
    if (inCheck && moves.length === 0) return -MATE_SCORE + ply;

    const stand = this.staticEval(position);
    if (!inCheck) {
      if (stand >= beta) return beta;
      if (stand > alpha) alpha = stand;
    }

    if (qply > 8 || ply > 18 || this.timeUp()) return inCheck ? alpha : Math.max(alpha, stand);

    if (!inCheck && qply === 0) {
      const existing = new Set(moves.map(moveToUci));
      const tacticalQuiets = [];
      const volatility = cheapVolatility(position);
      for (const move of position.legalMoves()) {
        if (existing.has(moveToUci(move))) continue;
        if (move.flags & FLAGS.CAPTURE || move.promotion) continue;
        const next = position.makeMove(move);
        const checkPriority = volatility >= 48 && next.isInCheck() ? 520 : 0;
        const threatPriority = quietTacticalThreatScore(position, move);
        // Only concrete passed-pawn pushes enter qsearch. General king activity
        // is positional and stays in evaluation/LMR protection.
        const endgamePriority = isEndgamePassedPawnPush(position, move) ? 330 : 0;
        const priority = Math.max(checkPriority, threatPriority, endgamePriority);
        if (priority >= 300) tacticalQuiets.push({ move, priority });
      }
      tacticalQuiets.sort((a, b) => b.priority - a.priority);
      for (const item of tacticalQuiets.slice(0, 4)) moves.push(item.move);
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

  orderMoves(position, moves, ply, ttMove) {
    const killers = this.killers[ply] || [];
    const scored = moves.map(move => {
      const u = moveToUci(move);
      let score = 0;
      if (ttMove === u) score += 1_000_000;
      if (move.promotion) score += 130_000 + (PIECE_VALUES[move.promotion] || 0) * 40;
      if (move.flags & FLAGS.CAPTURE) {
        const victim = PIECE_VALUES[typeOf(move.captured)] || 0;
        const attacker = PIECE_VALUES[typeOf(move.piece)] || 0;
        score += 80_000 + victim * 12 - attacker;
        if (ply === 0) {
          const see = staticExchangeEval(position, move, this.seeMemo);
          score += Math.max(-12000, Math.min(30000, see * 30));
        }
      }
      if (ply <= 1 && !(move.flags & FLAGS.CAPTURE) && !move.promotion) {
        const next = position.makeMove(move);
        if (next.isInCheck()) score += 62_000;
        if (ply === 0) score += Math.min(52000, quietTacticalThreatScore(position, move) * 100);
        if (isEndgameCriticalMove(position, move)) score += 28_000;
      }
      if (killers[0] === u) score += 18_000;
      else if (killers[1] === u) score += 14_000;
      score += Math.min(30000, this.history.get(u) || 0);
      return { move, score };
    });
    scored.sort((a, b) => b.score - a.score);
    return scored.map(x => x.move);
  }

  personalitySelect(position, lines, bestFallback) {
    if (!lines?.length) {
      return {
        move: bestFallback.bestMove,
        score: bestFallback.score,
        objectiveScore: bestFallback.score,
        pv: bestFallback.pv,
        risk: bestFallback.bestMove ? rootTacticalRisk(position, bestFallback.bestMove, this.seeMemo) : 0,
      };
    }

    const exactLines = lines.filter(line => line.exact !== false);
    const pool = exactLines.length ? exactLines : lines;
    const bestScore = Math.max(...pool.map(line => line.score));

    if (Math.abs(bestScore) >= MATE_SCORE - 1000) {
      const forced = pool.find(line => line.score === bestScore) || pool[0];
      return { move: forced.move, score: bestScore, objectiveScore: bestScore, pv: forced.pv, risk: 0 };
    }

    const window = this.config.selectionWindow ?? 32;
    const eligible = pool.filter(line => line.score >= bestScore - window);
    const danger = cheapVolatility(position);
    const scored = eligible.map(line => {
      const deterministicNoise = this.config.evalNoise
        ? pseudoNoise(position.hash, line.move, this.config.evalNoise)
        : 0;
      const personality = danger >= 62 ? 0 : (line.personality || 0);
      const risk = rootTacticalRisk(position, line.move, this.seeMemo);
      const materialLoss = rootImmediateMaterialLoss(position, line.move, this.seeMemo);
      const riskPenalty = risk >= MATE_RISK
        ? 1_000_000
        : risk >= 700
          ? 180 + (risk - 700) * 0.20
          : risk >= 300
            ? 35 + (risk - 300) * 0.08
            : 0;
      // Legal SEE reports net exchange loss. Losing a minor to a pawn is about
      // 220cp, so 180cp is already a serious root safety event.
      const materialPenalty = materialLoss >= 500
        ? 150 + (materialLoss - 500) * 0.22
        : materialLoss >= 180
          ? 50 + (materialLoss - 180) * 0.18
          : 0;
      const composite = line.score + personality + deterministicNoise - riskPenalty - materialPenalty;
      return { ...line, personality, risk, materialLoss, composite };
    }).sort((a, b) => b.composite - a.composite);

    let pick = scored[0] || pool[0];

    if (pick?.materialLoss >= 180) {
      const safe = scored
        .filter(line => line.materialLoss < 120 && line.score >= bestScore - 110)
        .sort((a, b) => b.composite - a.composite)[0];
      if (safe) pick = safe;
    }

    if (pick?.risk >= 500) {
      const rescuePool = pool.filter(line => line.score >= bestScore - 120).map(line => ({
        ...line,
        risk: rootTacticalRisk(position, line.move, this.seeMemo),
        materialLoss: rootImmediateMaterialLoss(position, line.move, this.seeMemo),
      }));
      const safer = rescuePool
        .filter(line => line.risk + 220 < pick.risk && line.materialLoss < 180)
        .sort((a, b) => (b.score - b.risk * 0.18) - (a.score - a.risk * 0.18))[0];
      if (safer) pick = { ...safer, composite: safer.score };
    }

    return {
      move: pick.move,
      score: pick.composite ?? pick.score,
      objectiveScore: pick.score,
      pv: pick.pv,
      risk: pick.risk || 0,
    };
  }

  cycleUtility(position) {
    const staticScore = this.staticEval(position);
    const material = materialBalance(position, position.turn);
    const penalty = 42 + Math.round((VANTA_PERSONALITY.drawAversion / 100) * 100);
    if (material > 0 || staticScore >= 70) return staticScore - penalty;
    if (material < 0 || staticScore <= -70) return staticScore + Math.round(penalty * 0.45);
    return staticScore - 12;
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
    const predictionDepth = Math.max(2, Math.min(4, (options.depth ?? this.config.maxDepth) - 1));
    const opponentSearch = new SearchEngine({
      ...this.config,
      maxDepth: predictionDepth,
      moveTimeMs: Math.max(60, Math.floor((options.timeMs ?? 220) / 2)),
      nodeLimit: 60000,
      selectionWindow: 0,
      evalNoise: 0,
    });
    const root = opponentSearch.searchRoot(position, predictionDepth, {});
    const candidates = root.lines.filter(line => line.exact !== false).slice(0, count);
    const branches = [];

    for (const candidate of candidates) {
      const after = position.makeMove(candidate.move);
      const responseEngine = new SearchEngine({
        ...this.config,
        maxDepth: predictionDepth,
        moveTimeMs: Math.max(45, Math.floor((options.timeMs ?? 220) / count)),
        nodeLimit: 50000,
      });
      const response = responseEngine.search(after, {
        maxDepth: predictionDepth,
        moveTimeMs: Math.max(45, Math.floor((options.timeMs ?? 220) / count)),
      });
      if (response.move) {
        branches.push({
          opponentMove: moveToUci(candidate.move),
          engineMove: moveToUci(response.move),
          evaluation: -candidate.score,
          depth: predictionDepth,
          continuation: [moveToUci(candidate.move), ...response.pv.map(moveToUci)].slice(0, 6),
        });
      }
    }
    return branches;
  }
}

function performanceNow() { return globalThis.performance?.now?.() ?? Date.now(); }

function pseudoNoise(hash, move, amplitude) {
  let x = Number((hash ^ BigInt(move.from * 131 + move.to * 17 + (move.promotion?.charCodeAt(0) || 0))) & 0xffffffffn) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
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

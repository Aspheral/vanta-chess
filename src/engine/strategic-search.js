import { SearchEngine as CoreSearchEngine } from './search-core.js';
import { MATE_SCORE } from './evaluation.js';
import { cheapVolatility, rootTacticalRisk } from './tactics.js';
import {
  strategicEvaluation, strategicMoveBonus, quietTacticalCandidates, cycleUtility,
} from './strategic-discipline.js';

const MATE_RISK = 99000;

export class SearchEngine extends CoreSearchEngine {
  staticEval(position, perspective = position.turn) {
    const base = super.staticEval(position, perspective);
    const key = `${position.hash.toString()}:${perspective}`;
    this._strategicEvalCache ||= new Map();
    let strategic = this._strategicEvalCache.get(key);
    if (strategic === undefined) {
      strategic = strategicEvaluation(position, perspective);
      this._strategicEvalCache.set(key, strategic);
      if (this._strategicEvalCache.size > 30000) {
        let removed = 0;
        for (const k of this._strategicEvalCache.keys()) {
          this._strategicEvalCache.delete(k);
          if (++removed >= 6000) break;
        }
      }
    }
    return base + strategic;
  }

  negamax(position, depth, alpha, beta, ply, pvOut, pathHashes) {
    let prior = 0;
    for (const hash of pathHashes) if (hash === position.hash) prior++;
    if (prior >= 1) return cycleUtility(position, this.staticEval(position));
    return super.negamax(position, depth, alpha, beta, ply, pvOut, pathHashes);
  }

  quiescence(position, alpha, beta, ply, qply = 0) {
    const base = super.quiescence(position, alpha, beta, ply, qply);
    if (qply !== 0 || position.isInCheck() || this.timeUp() || base >= beta) return base;

    let localAlpha = Math.max(alpha, base);
    for (const { move } of quietTacticalCandidates(position, 3)) {
      if (this.timeUp()) break;
      const score = -super.quiescence(position.makeMove(move), -beta, -localAlpha, ply + 1, qply + 1);
      if (score >= beta) return beta;
      if (score > localAlpha) localAlpha = score;
    }
    return localAlpha;
  }

  personalitySelect(position, lines, bestFallback) {
    if (!lines?.length) return super.personalitySelect(position, lines, bestFallback);

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
      const basePersonality = danger >= 62 ? 0 : (line.personality || 0);
      const discipline = strategicMoveBonus(position, line.move);
      const risk = rootTacticalRisk(position, line.move, this.seeMemo);
      const noise = this.config.evalNoise
        ? deterministicNoise(position.hash, line.move, this.config.evalNoise)
        : 0;
      const riskPenalty = risk >= MATE_RISK
        ? 1_000_000
        : risk >= 800
          ? 360 + (risk - 800) * 0.30
          : risk >= 450
            ? 145 + (risk - 450) * 0.22
            : risk >= 240
              ? 65 + (risk - 240) * 0.16
              : 0;
      return {
        ...line,
        personality: basePersonality + discipline,
        discipline,
        risk,
        composite: line.score + basePersonality + discipline + noise - riskPenalty,
      };
    }).sort((a,b)=>b.composite-a.composite);

    let pick = scored[0] || pool[0];

    if (pick.risk >= 240) {
      const allowedCost = pick.risk >= 800 ? 220 : pick.risk >= 450 ? 145 : 90;
      const candidatePool = pool.map(line => ({
        ...line,
        risk: rootTacticalRisk(position, line.move, this.seeMemo),
        discipline: strategicMoveBonus(position, line.move),
      }));
      const safer = candidatePool
        .filter(line => line.risk <= 120 && line.score >= pick.score - allowedCost)
        .sort((a,b)=>(b.score + b.discipline) - (a.score + a.discipline))[0];
      if (safer) {
        pick = {
          ...safer,
          personality: (safer.personality || 0) + safer.discipline,
          composite: safer.score + (safer.personality || 0) + safer.discipline,
        };
      }
    }

    return {
      move: pick.move,
      score: pick.composite ?? pick.score,
      objectiveScore: pick.score,
      pv: pick.pv,
      risk: pick.risk || 0,
    };
  }
}

function deterministicNoise(hash, move, amplitude) {
  let x = Number((hash ^ BigInt(move.from * 131 + move.to * 17 + (move.promotion?.charCodeAt(0) || 0))) & 0xffffffffn) >>> 0;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return Math.round((((x >>> 0) / 0xffffffff) * 2 - 1) * amplitude);
}

export { strategicEvaluation, strategicMoveBonus, quietTacticalCandidates, cycleUtility } from './strategic-discipline.js';

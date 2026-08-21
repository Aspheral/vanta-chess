import { positionCriticality, allocateRapidTime } from './tactics.js';

export const ADAPTIVE_STRENGTH = Object.freeze({
  minElo: 1500,
  typicalUpperElo: 1750,
  maxElo: 2050,
  minDepth: 6,
  maxDepth: 9,
  minNodeLimit: 260000,
  maxNodeLimit: 1100000,
  maxRapidThinkMs: 7500,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

/**
 * Converts a 0-100 tactical/positional criticality score into Vanta's
 * per-move calculation target. This is deliberately nonlinear: most normal
 * positions remain in Vanta's 1500-1750 character band, while genuinely
 * difficult positions can unlock substantially stronger calculation.
 *
 * targetElo is a search-policy label, not a claim that an individual move has
 * a measurable human Elo rating.
 */
export function targetEloForCriticality(criticality) {
  const c = clamp(Number(criticality) || 0, 0, 100) / 100;
  const curve = Math.pow(c, 1.35);
  return Math.round(ADAPTIVE_STRENGTH.minElo
    + (ADAPTIVE_STRENGTH.maxElo - ADAPTIVE_STRENGTH.minElo) * curve);
}

function depthForElo(targetElo) {
  if (targetElo >= 1975) return 9;
  if (targetElo >= 1850) return 8;
  if (targetElo >= 1700) return 7;
  return 6;
}

function nodeLimitForElo(targetElo) {
  const span = ADAPTIVE_STRENGTH.maxElo - ADAPTIVE_STRENGTH.minElo;
  const t = clamp((targetElo - ADAPTIVE_STRENGTH.minElo) / span, 0, 1);
  return Math.round(ADAPTIVE_STRENGTH.minNodeLimit
    + (ADAPTIVE_STRENGTH.maxNodeLimit - ADAPTIVE_STRENGTH.minNodeLimit) * Math.pow(t, 1.15));
}

function selectionWindowForElo(targetElo) {
  const span = ADAPTIVE_STRENGTH.maxElo - ADAPTIVE_STRENGTH.minElo;
  const t = clamp((targetElo - ADAPTIVE_STRENGTH.minElo) / span, 0, 1);
  return Math.round(32 - 24 * t);
}

function evalNoiseForElo(targetElo) {
  const span = ADAPTIVE_STRENGTH.maxElo - ADAPTIVE_STRENGTH.minElo;
  const t = clamp((targetElo - ADAPTIVE_STRENGTH.minElo) / span, 0, 1);
  return Math.max(0, Math.round(4 * (1 - t)));
}

/**
 * Build the search budget for one concrete position.
 *
 * With a real clock, the existing rapid allocator remains authoritative about
 * preserving a reserve; this layer only expands the budget when the position
 * is difficult. Without a clock (analysis/tests), the requested moveTimeMs is
 * treated as the quiet-position baseline.
 */
export function adaptiveStrengthProfile(position, options = {}) {
  const criticality = positionCriticality(position);
  const targetElo = targetEloForCriticality(criticality);
  const span = ADAPTIVE_STRENGTH.maxElo - ADAPTIVE_STRENGTH.minElo;
  const strength = clamp((targetElo - ADAPTIVE_STRENGTH.minElo) / span, 0, 1);
  const maxDepth = depthForElo(targetElo);
  const nodeLimit = nodeLimitForElo(targetElo);
  const selectionWindow = selectionWindowForElo(targetElo);
  const evalNoise = evalNoiseForElo(targetElo);

  let softTimeMs;
  let hardTimeMs;
  let reserveMs = 0;

  if (options.remainingTimeMs != null) {
    const remainingTimeMs = Math.max(1000, Number(options.remainingTimeMs) || 600000);
    const rapid = allocateRapidTime(position, remainingTimeMs, Number(options.incrementMs) || 0);
    reserveMs = rapid.reserveMs;
    const safeMaximum = Math.max(150, remainingTimeMs - reserveMs);
    const softFactor = 0.88 + strength * 0.62;
    const hardFactor = 0.92 + strength * 0.73;
    softTimeMs = Math.round(Math.min(safeMaximum, rapid.softTimeMs * softFactor));
    hardTimeMs = Math.round(Math.min(
      safeMaximum,
      ADAPTIVE_STRENGTH.maxRapidThinkMs,
      Math.max(softTimeMs + 80, rapid.hardTimeMs * hardFactor),
    ));
  } else {
    const base = Math.max(80, Number(options.moveTimeMs) || 650);
    softTimeMs = Math.round(base * (0.68 + strength * 1.55));
    hardTimeMs = Math.round(Math.min(
      ADAPTIVE_STRENGTH.maxRapidThinkMs,
      Math.max(softTimeMs + 60, base * (1 + strength * 4.2)),
    ));
  }

  return {
    mode: 'adaptive',
    criticality,
    targetElo,
    typicalBand: [ADAPTIVE_STRENGTH.minElo, ADAPTIVE_STRENGTH.typicalUpperElo],
    maxElo: ADAPTIVE_STRENGTH.maxElo,
    maxDepth,
    nodeLimit,
    selectionWindow,
    evalNoise,
    softTimeMs,
    hardTimeMs,
    reserveMs,
  };
}

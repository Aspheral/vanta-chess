export const VANTA_PERSONALITY = Object.freeze({
  aggression: 95,
  kingSafety: 100,
  tacticalPreference: 95,
  sacrificialWillingness: 90,
  initiativePreference: 95,
  materialGreed: 25,
  positionalPatience: 55,
  complexityPreference: 85,
  drawAversion: 75,
  enemyKingAttack: 100,
});

export const STRENGTH_PRESETS = Object.freeze({
  1200: { maxDepth: 4, moveTimeMs: 80, nodeLimit: 35000, selectionWindow: 105, evalNoise: 28 },
  1500: { maxDepth: 6, moveTimeMs: 650, nodeLimit: 260000, selectionWindow: 32, evalNoise: 4 },
  1800: { maxDepth: 7, moveTimeMs: 500, nodeLimit: 400000, selectionWindow: 18, evalNoise: 2 },
});

export function strengthConfig(target = 1500) {
  return { targetElo: target, ...(STRENGTH_PRESETS[target] || STRENGTH_PRESETS[1500]) };
}

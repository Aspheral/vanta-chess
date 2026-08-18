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
  1200: { maxDepth: 3, moveTimeMs: 70, nodeLimit: 25000, selectionWindow: 90, evalNoise: 24 },
  1500: { maxDepth: 5, moveTimeMs: 350, nodeLimit: 180000, selectionWindow: 55, evalNoise: 12 },
  1800: { maxDepth: 6, moveTimeMs: 350, nodeLimit: 300000, selectionWindow: 35, evalNoise: 6 },
});

export function strengthConfig(target = 1500) {
  return { targetElo: target, ...(STRENGTH_PRESETS[target] || STRENGTH_PRESETS[1500]) };
}

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
  1200: { maxDepth: 4, moveTimeMs: 80, nodeLimit: 35000, selectionWindow: 105, evalNoise: 28, adaptiveStrength: false },
  // Vanta keeps its attacking personality, but personality is now allowed to
  // break ties rather than donate a third of a pawn for style. The August game
  // audit showed that a 32 cp window plus noise was too permissive in quiet
  // openings, where colorful rook/flank-pawn moves repeatedly displaced sound
  // development. A deeper deterministic baseline keeps aggression search-led.
  1500: { maxDepth: 7, moveTimeMs: 850, nodeLimit: 420000, selectionWindow: 20, evalNoise: 0, adaptiveStrength: true },
  1800: { maxDepth: 8, moveTimeMs: 1500, nodeLimit: 650000, selectionWindow: 12, evalNoise: 0, adaptiveStrength: false },
  2050: { maxDepth: 9, moveTimeMs: 7500, nodeLimit: 1100000, selectionWindow: 6, evalNoise: 0, adaptiveStrength: false },
});

export function strengthConfig(target = 1500) {
  return { targetElo: target, ...(STRENGTH_PRESETS[target] || STRENGTH_PRESETS[1500]) };
}

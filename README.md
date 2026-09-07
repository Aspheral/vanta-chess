# Vanta Chess

Vanta is an aggressive browser chess engine and analysis UI built around tactical search, practical safety, adaptive rapid strength, prediction branches, and a deliberately attacking personality.

## Current feature branch

The active per-game Elo work lives on `feature/per-game-minimum-elo`, based on `stress-1650-audit`.

### Per-game approximate minimum Elo

The Game panel can choose an approximate minimum search-strength floor from 1500+ through 2050+ in 50-point steps. The chosen value is a floor, not a cap: tactically critical positions may still scale higher within Vanta's calibrated adaptive range.

The default remains 1500+, preserving the normal adaptive profile.

### Faster prediction arrows

The first prediction-map ponder pass is intentionally short so arrows appear quickly after Vanta moves. A deeper refinement pass follows without removing the already-visible branch map.

## Run locally

```bash
npm start
```

Then open `http://localhost:4173`.

## Tests

```bash
npm test
```

## Benchmark

```bash
npm run benchmark
```

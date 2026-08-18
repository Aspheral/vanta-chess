# Vanta Chess

Vanta Chess is a dependency-free browser chess program built around a custom tactical engine personality: **protect your king, find theirs, and calculate whether the material fire is worth it.**

It is not a Stockfish skin and it does not fake engine output. Legal chess, search, evaluation, pondering, prediction branches, history, SAN/FEN, and the board UI are implemented in this repository.

## What is implemented

- Complete legal move generation with castling, en passant, promotion, check filtering, checkmate, stalemate, fifty-move draws, insufficient material, and repetition handling.
- SAN move history and FEN import/export.
- Editor-style undo/redo timeline. Redo remains available until a different move creates a new branch.
- Position editor with free piece placement, side to move, castling rights, en-passant square, validation, and FEN loading.
- Play as White or Black, automatic board orientation, and independent manual flip.
- Analysis mode that does not auto-play moves.
- Custom search engine with iterative deepening, negamax alpha-beta, transposition table, incremental Zobrist hashing, move ordering, quiescence, killer moves, history heuristic, check extensions, late-move reductions, repetition detection, and principal variations.
- Web Worker search so the board remains responsive while Vanta calculates.
- Position-specific multi-branch pondering during the player's turn, with continuous background refinement while the previous completed cache remains usable.
- Ponder-cache lookup for near-instant replies when the player chooses a predicted branch.
- Paired colored arrows. A predicted opponent move and Vanta's planned response share one branch color.
- Search IDs plus hard worker restart on cancellation, preventing stale search results from corrupting undo, FEN loads, editor changes, or newer searches.
- Optional developer metrics for qnodes, TT hits, cutoffs, candidate personality scores, and ponder hit/miss counts.
- Automated perft, rules, timeline, SAN, hash, tactical-search, personality, and pondering regression tests.
- Reproducible benchmark command that writes a machine-readable snapshot to `benchmarks/latest.json`.

## Engine character

The default personality is intentionally extreme without treating aggression as permission to blunder:

| Trait | Setting |
| --- | ---: |
| Aggression | 95/100 |
| King safety | 100/100 |
| Tactical preference | 95/100 |
| Sacrificial willingness | 90/100 |
| Initiative preference | 95/100 |
| Material greed | 25/100 |
| Positional patience | 55/100 |
| Complexity preference | 85/100 |
| Draw aversion | 75/100 |
| Enemy-king attack | 100/100 |

The evaluator combines material with king shielding, king escape squares, attack rays, nearby attackers and defenders, pawn structure, passed pawns, mobility, piece activity, space, initiative, and enemy-king pressure. Personality is applied primarily at the root inside an acceptable objective-evaluation window. Forced tactical truth is not overridden by style.

Sacrificial moves receive attention when they create checks, open king lines, increase attack potential, weaken king safety, or provide compensation. A move that simply hangs material without enough compensation is penalized by the objective search and sacrifice-risk term.

## Target strength

The default preset is **targeted toward approximately 1500 Elo**, not claimed to be a measured 1500 rating.

A browser engine's rating cannot be inferred honestly from search depth alone. The current limiter combines a move-time budget, node budget, maximum depth, a near-best selection window, and small deterministic evaluation uncertainty. Tactical necessities such as escaping mate or delivering forced mate take precedence.

Current default target preset:

```text
max depth:       5
move time:       ~350 ms
node budget:     180,000
selection window: 55 cp
root eval noise: 12 cp deterministic
```

### Empirical Elo calibration framework

To convert the target into a measured estimate:

1. Run large match batches against fixed-strength reference engines at several known ratings under one time control and hardware profile.
2. Record wins, draws, losses, color balance, illegal/crash rate, and average move latency.
3. Fit a rating estimate from the score against each reference pool, with a confidence interval rather than a single magic number.
4. Adjust `moveTimeMs`, `nodeLimit`, `maxDepth`, `selectionWindow`, and `evalNoise` without changing legality or intentionally injecting nonsense moves.
5. Re-run the same suite after search/evaluation changes. Keep the personality regressions separate from the Elo calibration pool.

This repository provides the engine controls and benchmark foundation for that process. A true rating still requires external match data.

## Architecture

```text
Browser UI
  ├─ BoardView / arrow renderer
  ├─ ChessGame timeline + SAN/FEN
  └─ EngineController state/cancellation
          │
          ▼
      Web Worker
          │
          ▼
      SearchEngine
       ├─ alpha-beta / iterative deepening / qsearch
       ├─ TT + incremental Zobrist hashing
       ├─ move ordering / killers / history / LMR
       ├─ evaluation + Vanta personality
       └─ multi-branch ponder search
```

The project intentionally has no runtime or npm dependencies. This keeps the engine inspectable and avoids outsourcing the core to a third-party chess engine.

## Run

Node is only used to serve the ES modules and run tests. There is nothing to install.

```bash
npm start
```

Then open:

```text
http://localhost:4173
```

A local HTTP server is preferred because module Web Workers are subject to browser origin rules.

## Test

```bash
npm test
```

The suite includes the standard starting-position perft counts through depth 4 and Kiwipete perft coverage, plus special-move, result, timeline, SAN, Zobrist, tactical-search, king-safety, personality, and ponder-branch tests.

## Benchmark

```bash
npm run benchmark
```

The benchmark records:

- completed depth
- alpha-beta nodes
- quiescence nodes
- nodes/second
- move time
- transposition-table hits and hit rate
- tactical regression success rate
- ponder branch generation time
- synthetic ponder-cache hit/miss probes

The latest local run is written to `benchmarks/latest.json`. Numbers are hardware/runtime dependent and should not be read as Elo.

## Source layout

```text
src/chess/       rules, positions, SAN, game timeline, Zobrist
src/engine/      evaluation, personality, search, worker, controller, benchmark
src/ui/          board rendering and prediction arrows
tests/           rules, perft, search, personality regressions
benchmarks/      generated benchmark snapshot
```

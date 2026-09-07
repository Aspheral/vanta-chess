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

## Per-game minimum Elo

The `feature/per-game-minimum-elo` build adds a Game-panel selector from **1500+ through 2050+** in 50-point steps. The selected value is an approximate search-strength floor for the current game, not a cap: critical positions can still scale higher inside Vanta's calibrated adaptive range.

The default remains 1500+, preserving Vanta's existing adaptive behavior.

### Faster prediction arrows

The first prediction-map ponder pass is deliberately short so the colored reply arrows appear quickly after Vanta moves. The controller now caps that initial branch-map pass at about **180 ms**, then immediately starts the existing deeper refinement pass while keeping the first completed map visible.

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


## OpenAI coach

The current move's coaching appears above the board in play and the arena. Responses stream as words arrive, using GPT-4.1 mini by default, without waiting for another chess search. The prompt asks for warm, expressive, concise coaching based on verified board facts. No provisional search variations are sent: the coach is instructed to explain the move already played and never promise a future reply.

Changing position cancels outdated requests. Completed thoughts stay with their timeline entries for undo/redo, and only the current move is displayed. Quiet opponent moves do not call OpenAI. The On/Off and Retry controls let you manage coaching without interrupting play. An API failure displays an honest status rather than silently replacing the coach with templates.

### Local play

Requires Node.js 22 or later. Put OPENAI_API_KEY in the ignored .env.local file, then run `npm start` and open http://127.0.0.1:4173. The local server serves only approved game assets; it does not serve env files or server source. The API key remains on the server. API credits are required separately from creating a key. The actual smoke request during implementation returned `credit_balance_exhausted`, so live response quality and latency have not yet been verified.

OPENAI_COACH_MODEL optionally overrides gpt-4.1-mini. Responses are capped at 220 output tokens with a 15-second upstream timeout; exact latency depends on the API and connection. Requests use `store: false`.

### GitHack and hosted play

GitHack can serve the board but cannot run this server or safely hold an OpenAI API key. Deploy the Node server to an HTTPS host using the same source, with OPENAI_API_KEY configured as a server secret. For non-loopback hosting set HOST=0.0.0.0 and a separate random COACH_ACCESS_TOKEN; the server refuses to expose itself publicly without one. COACH_ALLOWED_ORIGIN should be the exact GitHack origin (for example https://rawcdn.githack.com). Enter the hosted /api/coach URL and the separate coach access token in Connection settings above the board. Never enter the OpenAI key into the browser. Connection settings last only for the current page session. Alternatively, set the public URL in coach-config.json; never put tokens or keys in that file.

The server limits concurrent calls and requests per client and day in memory. Those counters reset on restart and are per instance, not a durable distributed spend cap; a multi-instance production deployment should add a shared quota layer. Do not replace `npm start` with a generic directory server in a workspace containing secrets.

### Validation

Run `node --test tests/commentary.test.js` for board facts, stream parsing, OpenAI request construction, quota errors, cancellation, timeline handling, and server access controls. The full `npm test` suite also contains existing chess-engine regressions.

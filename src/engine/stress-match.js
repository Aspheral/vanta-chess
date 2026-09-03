import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { ChessGame } from '../chess/game.js';
import { WHITE, BLACK, typeOf } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { CriticalSearchEngine } from './critical-search.js';
import { adaptiveStrengthProfile } from './adaptive-strength.js';
import { repetitionExclusions } from './draw-policy.js';
import { searchWithPracticalSafety } from './practical-safety.js';

const GAMES = Number(process.env.STRESS_GAMES || 50);
const SHARD = Number(process.env.STRESS_SHARD || 0);
const SHARDS = Number(process.env.STRESS_SHARDS || 1);
const STOCKFISH_ELO = Number(process.env.STRESS_ELO || 1650);
const MOVE_TIME_MS = Number(process.env.STRESS_MOVE_MS || 650);
const VANTA_NODE_LIMIT = Number(process.env.STRESS_VANTA_NODES || 420000);
const STOCKFISH_NODE_LIMIT = Number(process.env.STRESS_STOCKFISH_NODES || 800000);
const MAX_PLIES = Number(process.env.STRESS_MAX_PLIES || 120);
const SEED = Number(process.env.STRESS_SEED || 20260829) >>> 0;
const REPORT_PATH = process.env.STRESS_REPORT || `benchmarks/stress-1650-shard-${SHARD}.json`;

const OPENING_POOL = [
  ['Italian', ['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6','d2d3','f8c5','c2c3','d7d6']],
  ['Ruy Lopez', ['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6','b5a4','g8f6','e1g1','f8e7']],
  ['Scotch', ['e2e4','e7e5','g1f3','b8c6','d2d4','e5d4','f3d4','g8f6','d4c6','b7c6']],
  ['Four Knights', ['e2e4','e7e5','g1f3','b8c6','b1c3','g8f6','f1b5','f8b4']],
  ['Vienna', ['e2e4','e7e5','b1c3','g8f6','f2f4','d7d5','f4e5','f6e4']],
  ['Kings Gambit', ['e2e4','e7e5','f2f4','e5f4','g1f3','g7g5','h2h4','g5g4']],
  ['Sicilian Najdorf', ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','a7a6']],
  ['Sicilian Classical', ['e2e4','c7c5','g1f3','b8c6','d2d4','c5d4','f3d4','g8f6','b1c3','d7d6']],
  ['Sicilian Dragon', ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','g7g6']],
  ['French', ['e2e4','e7e6','d2d4','d7d5','b1c3','g8f6','e4e5','f6d7']],
  ['Caro Kann', ['e2e4','c7c6','d2d4','d7d5','b1c3','d5e4','c3e4','c8f5']],
  ['Pirc', ['e2e4','d7d6','d2d4','g8f6','b1c3','g7g6','f2f4','f8g7']],
  ['Modern', ['e2e4','g7g6','d2d4','f8g7','b1c3','d7d6','g1f3','b8d7']],
  ['Alekhine', ['e2e4','g8f6','e4e5','f6d5','d2d4','d7d6','g1f3','d6e5']],
  ['Scandinavian', ['e2e4','d7d5','e4d5','d8d5','b1c3','d5d8','d2d4','g8f6']],
  ['Queens Gambit Declined', ['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6','c1g5','f8e7']],
  ['Slav', ['d2d4','d7d5','c2c4','c7c6','g1f3','g8f6','b1c3','d5c4']],
  ['Queens Gambit Accepted', ['d2d4','d7d5','c2c4','d5c4','e2e4','e7e5','g1f3','e5d4']],
  ['Kings Indian', ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6','g1f3','e8g8']],
  ['Nimzo Indian', ['d2d4','g8f6','c2c4','e7e6','b1c3','f8b4','e2e3','e8g8']],
  ['Queens Indian', ['d2d4','g8f6','c2c4','e7e6','g1f3','b7b6','g2g3','c8b7']],
  ['Bogo Indian', ['d2d4','g8f6','c2c4','e7e6','g1f3','f8b4','c1d2','b4e7']],
  ['Grunfeld', ['d2d4','g8f6','c2c4','g7g6','b1c3','d7d5','c4d5','f6d5']],
  ['Dutch', ['d2d4','f7f5','c2c4','g8f6','b1c3','g7g6','g2g3','f8g7']],
  ['English Symmetrical', ['c2c4','c7c5','b1c3','b8c6','g2g3','g7g6','f1g2','f8g7']],
  ['English Reversed Sicilian', ['c2c4','e7e5','b1c3','g8f6','g2g3','d7d5','c4d5','f6d5']],
  ['Reti', ['g1f3','d7d5','c2c4','e7e6','g2g3','g8f6','f1g2','f8e7']],
  ['Catalan', ['d2d4','g8f6','c2c4','e7e6','g2g3','d7d5','f1g2','f8e7']],
  ['Trompowsky', ['d2d4','g8f6','c1g5','e7e6','e2e4','h7h6','g5f6','d8f6']],
  ['London', ['d2d4','d7d5','g1f3','g8f6','c1f4','e7e6','e2e3','f8d6']],
  ['Colle', ['d2d4','g8f6','g1f3','e7e6','e2e3','d7d5','f1d3','f8e7']],
  ['Bird', ['f2f4','d7d5','g1f3','g8f6','e2e3','g7g6','b2b3','f8g7']],
  ['Larsen', ['b2b3','e7e5','c1b2','b8c6','e2e3','g8f6','f1b5','f8d6']],
  ['Owen', ['e2e4','b7b6','d2d4','c8b7','f1d3','e7e6','g1f3','g8f6']],
  ['Modern Benoni', ['d2d4','g8f6','c2c4','c7c5','d4d5','e7e6','b1c3','e6d5']],
  ['Benko', ['d2d4','g8f6','c2c4','c7c5','d4d5','b7b5','c4b5','a7a6']],
  ['Budapest', ['d2d4','g8f6','c2c4','e7e5','d4e5','f6g4','g1f3','b8c6']],
  ['Albin Countergambit', ['d2d4','d7d5','c2c4','e7e5','d4e5','d5d4','g1f3','b8c6']],
  ['Stonewall', ['d2d4','f7f5','e2e3','g8f6','f1d3','e7e6','f2f4','d7d5']],
  ['Kings Indian Attack', ['g1f3','d7d5','g2g3','g8f6','f1g2','e7e6','e1g1','f8e7']],
];

class UciEngine {
  constructor(binary) {
    this.binary = binary;
    this.proc = spawn(binary, [], { stdio: ['pipe','pipe','inherit'] });
    this.lines = [];
    this.waiters = [];
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', line => {
      this.lines.push(line);
      for (const waiter of [...this.waiters]) {
        if (!waiter.predicate(line)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    });
  }
  send(command) { this.proc.stdin.write(`${command}\n`); }
  waitFor(predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for ${this.binary}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async init() {
    this.send('uci');
    await this.waitFor(line => line === 'uciok');
    const id = this.lines.find(line => line.startsWith('id name '))?.slice(8) || 'Stockfish';
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 32');
    this.send('setoption name UCI_LimitStrength value true');
    this.send(`setoption name UCI_Elo value ${STOCKFISH_ELO}`);
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
    return id;
  }
  async newGame() {
    this.send('ucinewgame');
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
  }
  async bestMove(history) {
    this.send(history.length ? `position startpos moves ${history.join(' ')}` : 'position startpos');
    if (STOCKFISH_NODE_LIMIT > 0) this.send(`go nodes ${STOCKFISH_NODE_LIMIT}`);
    else this.send(`go movetime ${MOVE_TIME_MS}`);
    const timeout = STOCKFISH_NODE_LIMIT > 0 ? 30000 : MOVE_TIME_MS + 8000;
    const line = await this.waitFor(text => text.startsWith('bestmove '), timeout);
    const move = line.split(/\s+/)[1];
    return move && move !== '(none)' ? move : null;
  }
  quit() {
    try { this.send('quit'); } catch {}
    this.rl.close();
    this.proc.kill();
  }
}

async function findStockfish() {
  for (const candidate of [process.env.STOCKFISH_BIN, '/usr/games/stockfish', '/usr/bin/stockfish'].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  return 'stockfish';
}

function rng(seed) {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
    return (x >>> 0) / 0x100000000;
  };
}

function openingSet() {
  const random = rng(SEED);
  const pool = OPENING_POOL.map(([name, moves]) => ({ name, moves: [...moves] }));
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const needed = Math.ceil(GAMES / 2);
  return pool.slice(0, needed).map((opening, index) => {
    const maxEven = Math.min(10, opening.moves.length - (opening.moves.length % 2));
    const choices = [];
    for (let n = 6; n <= maxEven; n += 2) choices.push(n);
    const keep = choices.length ? choices[Math.floor(random() * choices.length)] : maxEven;
    return { id: index, name: opening.name, moves: opening.moves.slice(0, keep) };
  });
}

function setupGame(opening) {
  const game = new ChessGame();
  for (const uci of opening.moves) game.playUci(uci);
  return game;
}

function gamePoint(result, color) {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return color === WHITE ? 1 : 0;
  if (result === '0-1') return color === BLACK ? 1 : 0;
  return 0.5;
}

function productionVantaMove(game, engine) {
  const position = game.position;
  const profile = adaptiveStrengthProfile(position, { moveTimeMs: MOVE_TIME_MS });
  const nodeLimit = VANTA_NODE_LIMIT > 0 ? VANTA_NODE_LIMIT : profile.nodeLimit;
  const config = {
    targetElo: profile.targetElo,
    maxDepth: profile.maxDepth,
    nodeLimit,
    selectionWindow: profile.selectionWindow,
    evalNoise: profile.evalNoise,
  };
  const fixedWork = VANTA_NODE_LIMIT > 0;
  const options = {
    maxDepth: profile.maxDepth,
    moveTimeMs: fixedWork ? 60000 : MOVE_TIME_MS,
    softTimeMs: fixedWork ? 60000 : Math.min(MOVE_TIME_MS, profile.softTimeMs),
    hardTimeMs: fixedWork ? 60000 : MOVE_TIME_MS,
  };
  engine.config = { ...engine.config, ...config };
  const run = excludeMoves => searchWithPracticalSafety(
    engine,
    position,
    { ...options, excludeMoves },
  );
  let result = run([]);
  const objective = result.objectiveScore ?? result.score ?? 0;
  const repeats = repetitionExclusions(game, objective);
  if (result.move && repeats.includes(moveToUci(result.move))) result = run(repeats);
  return { ...result, adaptiveProfile: profile };
}

async function playGame(stockfish, opening, vantaColor, gameIndex) {
  const game = setupGame(opening);
  const engine = new CriticalSearchEngine();
  await stockfish.newGame();
  const startPly = game.cursor;
  const vantaMoves = [];
  let terminal = null;

  while (game.cursor - startPly < MAX_PLIES) {
    const status = game.status();
    if (status.over) { terminal = status; break; }
    if (game.position.turn === vantaColor) {
      const result = productionVantaMove(game, engine);
      if (!result.move) { terminal = game.status(); break; }
      const move = result.move;
      const mainNodes = (result.nodes || 0) + (result.qnodes || 0);
      const mateProbeNodes = result.practicalSafety?.mateProbe?.nodes || 0;
      vantaMoves.push({
        ply: game.cursor + 1,
        uci: moveToUci(move),
        piece: typeOf(move.piece),
        capture: Boolean(move.captured),
        promotion: move.promotion || null,
        depth: result.depth,
        nodes: mainNodes,
        mateProbeNodes,
        totalEffectiveNodes: mainNodes + mateProbeNodes,
        timeMs: result.timeMs || 0,
        objectiveScore: result.objectiveScore ?? result.score ?? 0,
        selectedRisk: result.selectedRisk || 0,
        safetyTriggered: Boolean(result.practicalSafety?.triggered),
        safetyExclusions: result.practicalSafety?.exclusions || [],
        criticality: result.adaptiveProfile?.criticality ?? 0,
        targetElo: result.adaptiveProfile?.targetElo ?? null,
        unstable: Boolean(result.unstable),
      });
      game.play(move);
    } else {
      const uci = await stockfish.bestMove(game.history.map(x => x.uci));
      if (!uci) { terminal = game.status(); break; }
      game.playUci(uci);
    }
  }

  if (!terminal) terminal = { over: true, result: '1/2-1/2', reason: 'ply cap' };
  return {
    gameIndex,
    openingId: opening.id,
    opening: opening.name,
    openingMoves: opening.moves,
    vantaColor,
    opponentElo: STOCKFISH_ELO,
    result: terminal.result,
    reason: terminal.reason,
    point: gamePoint(terminal.result, vantaColor),
    plies: game.cursor - startPly,
    totalPlies: game.cursor,
    moves: game.history.map(x => x.uci),
    vantaMoves,
  };
}

async function main() {
  const openings = openingSet();
  const assignments = [];
  for (let i = 0; i < GAMES; i++) {
    const opening = openings[Math.floor(i / 2)];
    assignments.push({ gameIndex: i, opening, vantaColor: i % 2 === 0 ? WHITE : BLACK });
  }
  const mine = assignments.filter(x => x.gameIndex % SHARDS === SHARD);
  const stockfish = new UciEngine(await findStockfish());
  const games = [];
  try {
    const id = await stockfish.init();
    console.log(`Stockfish: ${id}, UCI_Elo ${STOCKFISH_ELO}`);
    if (VANTA_NODE_LIMIT > 0 || STOCKFISH_NODE_LIMIT > 0) {
      console.log(`Shard ${SHARD + 1}/${SHARDS}: ${mine.length} of ${GAMES} games, node gate Vanta ${VANTA_NODE_LIMIT} / Stockfish ${STOCKFISH_NODE_LIMIT}`);
    } else {
      console.log(`Shard ${SHARD + 1}/${SHARDS}: ${mine.length} of ${GAMES} games, ${MOVE_TIME_MS} ms/move`);
    }
    for (const assignment of mine) {
      console.log(`Game ${assignment.gameIndex + 1}/${GAMES}: ${assignment.opening.name}, Vanta ${assignment.vantaColor === WHITE ? 'White' : 'Black'}`);
      const game = await playGame(stockfish, assignment.opening, assignment.vantaColor, assignment.gameIndex);
      games.push(game);
      console.log(`  ${game.result} ${game.reason}; Vanta ${game.point}`);
    }
  } finally {
    stockfish.quit();
  }

  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      games: GAMES,
      shard: SHARD,
      shards: SHARDS,
      stockfishElo: STOCKFISH_ELO,
      moveTimeMs: MOVE_TIME_MS,
      vantaNodeLimit: VANTA_NODE_LIMIT,
      stockfishNodeLimit: STOCKFISH_NODE_LIMIT,
      fixedWorkGate: VANTA_NODE_LIMIT > 0 || STOCKFISH_NODE_LIMIT > 0,
      maxPlies: MAX_PLIES,
      seed: SEED,
      engine: 'CriticalSearchEngine',
      persistentEnginePerGame: true,
    },
    openings,
    games,
  };
  await mkdir(REPORT_PATH.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
  console.log(`Report: ${REPORT_PATH}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

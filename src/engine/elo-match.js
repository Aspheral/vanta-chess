import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, writeFile } from 'node:fs/promises';
import { access } from 'node:fs/promises';
import { ChessGame } from '../chess/game.js';
import { WHITE, BLACK } from '../chess/constants.js';
import { moveToUci } from '../chess/position.js';
import { SearchEngine } from './search-v2.js';
import { repetitionExclusions } from './draw-policy.js';

const MOVE_TIME_MS = Number(process.env.MOVE_TIME_MS || 650);
const MAX_PLIES = Number(process.env.MAX_PLIES || 160);
const TARGETS = (process.env.ELO_TARGETS || '1320,1450,1600,1750').split(',').map(Number).filter(Number.isFinite);
const REPORT_PATH = process.env.ELO_REPORT || 'benchmarks/elo-ci.json';

const OPENINGS = [
  { name: 'Italian', moves: ['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6'] },
  { name: 'Sicilian', moves: ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6'] },
  { name: 'Queens Gambit', moves: ['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6'] },
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
      const pending = [...this.waiters];
      for (const waiter of pending) {
        if (waiter.predicate(line)) {
          clearTimeout(waiter.timer);
          this.waiters.splice(this.waiters.indexOf(waiter), 1);
          waiter.resolve(line);
        }
      }
    });
  }

  send(command) { this.proc.stdin.write(`${command}\n`); }

  waitFor(predicate, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Timed out waiting for UCI response from ${this.binary}`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async init() {
    this.send('uci');
    await this.waitFor(line => line === 'uciok');
    const id = this.lines.find(line => line.startsWith('id name '))?.slice(8) || 'Stockfish';
    const eloLine = this.lines.find(line => line.startsWith('option name UCI_Elo '));
    const min = Number(eloLine?.match(/\bmin\s+(\d+)/)?.[1] || 1320);
    const max = Number(eloLine?.match(/\bmax\s+(\d+)/)?.[1] || 3190);
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 32');
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
    return { id, minElo: min, maxElo: max };
  }

  async setElo(elo) {
    this.send('setoption name UCI_LimitStrength value true');
    this.send(`setoption name UCI_Elo value ${elo}`);
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
  }

  async newGame() {
    this.send('ucinewgame');
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
  }

  async bestMove(history, moveTimeMs) {
    this.send(history.length ? `position startpos moves ${history.join(' ')}` : 'position startpos');
    this.send(`go movetime ${moveTimeMs}`);
    const line = await this.waitFor(text => text.startsWith('bestmove '), moveTimeMs + 8000);
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
  const candidates = [process.env.STOCKFISH_BIN, '/usr/games/stockfish', '/usr/bin/stockfish'].filter(Boolean);
  for (const candidate of candidates) {
    try { await access(candidate); return candidate; } catch {}
  }
  return 'stockfish';
}

function setupGame(opening) {
  const game = new ChessGame();
  for (const uci of opening.moves) game.playUci(uci);
  return game;
}

function vantaMove(game) {
  const run = excludeMoves => new SearchEngine().search(game.position, {
    moveTimeMs: MOVE_TIME_MS,
    maxDepth: 6,
    excludeMoves,
  });
  let result = run([]);
  const excluded = repetitionExclusions(game, result.objectiveScore ?? result.score ?? 0);
  if (excluded.includes(result.move ? moveToUci(result.move) : '')) result = run(excluded);
  return result;
}

function gamePoint(result, vantaColor) {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return vantaColor === WHITE ? 1 : 0;
  if (result === '0-1') return vantaColor === BLACK ? 1 : 0;
  return 0.5;
}

async function playGame(stockfish, opponentElo, opening, vantaColor) {
  const game = setupGame(opening);
  await stockfish.newGame();
  const startPly = game.cursor;
  let vantaNodes = 0;
  let vantaMoveMs = 0;
  let terminal = null;

  while (game.cursor - startPly < MAX_PLIES) {
    const status = game.status();
    if (status.over) { terminal = status; break; }

    if (game.position.turn === vantaColor) {
      const result = vantaMove(game);
      if (!result.move) {
        terminal = game.status();
        break;
      }
      vantaNodes += (result.nodes || 0) + (result.qnodes || 0);
      vantaMoveMs += result.timeMs || 0;
      game.play(result.move);
    } else {
      const uci = await stockfish.bestMove(game.history.map(x => x.uci), MOVE_TIME_MS);
      if (!uci) {
        terminal = game.status();
        break;
      }
      game.playUci(uci);
    }
  }

  if (!terminal) terminal = { over: true, result: '1/2-1/2', reason: 'ply cap' };
  const point = gamePoint(terminal.result, vantaColor);
  return {
    opponentElo,
    opening: opening.name,
    vantaColor,
    result: terminal.result,
    reason: terminal.reason,
    point,
    plies: game.cursor - startPly,
    totalPlies: game.cursor,
    vantaNodes,
    vantaThinkingMs: vantaMoveMs,
    moves: game.history.map(x => x.uci),
  };
}

function expectedScore(rating, opponent) {
  return 1 / (1 + 10 ** ((opponent - rating) / 400));
}

function logLikelihood(rating, games) {
  let ll = 0;
  for (const game of games) {
    const p = Math.min(1 - 1e-9, Math.max(1e-9, expectedScore(rating, game.opponentElo)));
    ll += game.point * Math.log(p) + (1 - game.point) * Math.log(1 - p);
  }
  return ll;
}

function estimateRating(games) {
  let bestRating = 1500;
  let bestLL = -Infinity;
  const values = [];
  for (let rating = 600; rating <= 2600; rating++) {
    const ll = logLikelihood(rating, games);
    values.push([rating, ll]);
    if (ll > bestLL) { bestLL = ll; bestRating = rating; }
  }
  const cutoff = bestLL - 1.920729;
  const inside = values.filter(([,ll]) => ll >= cutoff).map(([rating]) => rating);
  return {
    estimate: bestRating,
    profile95: [inside[0] ?? 600, inside.at(-1) ?? 2600],
    logLikelihood: Number(bestLL.toFixed(4)),
  };
}

function summarize(games) {
  const grouped = new Map();
  for (const game of games) {
    const row = grouped.get(game.opponentElo) || { opponentElo: game.opponentElo, games: 0, wins: 0, draws: 0, losses: 0, points: 0 };
    row.games++;
    row.points += game.point;
    if (game.point === 1) row.wins++;
    else if (game.point === 0.5) row.draws++;
    else row.losses++;
    grouped.set(game.opponentElo, row);
  }
  return [...grouped.values()].sort((a,b) => a.opponentElo - b.opponentElo).map(row => ({
    ...row,
    score: Number((row.points / row.games).toFixed(3)),
  }));
}

async function main() {
  const binary = await findStockfish();
  const stockfish = new UciEngine(binary);
  try {
    const stockfishInfo = await stockfish.init();
    const targets = [...new Set(TARGETS.filter(x => x >= stockfishInfo.minElo && x <= stockfishInfo.maxElo))];
    if (!targets.length) targets.push(stockfishInfo.minElo);
    console.log(`Reference engine: ${stockfishInfo.id}`);
    console.log(`UCI_Elo range: ${stockfishInfo.minElo}-${stockfishInfo.maxElo}`);
    console.log(`Targets: ${targets.join(', ')}, ${MOVE_TIME_MS} ms/move, ${OPENINGS.length * 2} games/target`);

    const games = [];
    for (const opponentElo of targets) {
      await stockfish.setElo(opponentElo);
      for (const opening of OPENINGS) {
        for (const vantaColor of [WHITE, BLACK]) {
          const number = games.length + 1;
          console.log(`Game ${number}: Vanta ${vantaColor === WHITE ? 'White' : 'Black'} vs SF ${opponentElo}, ${opening.name}`);
          const game = await playGame(stockfish, opponentElo, opening, vantaColor);
          games.push(game);
          console.log(`  ${game.result} (${game.reason}), Vanta score ${game.point}, ${game.plies} plies`);
        }
      }
    }

    const rating = estimateRating(games);
    const summary = summarize(games);
    const report = {
      generatedAt: new Date().toISOString(),
      methodology: {
        reference: stockfishInfo,
        equalMoveTimeMs: MOVE_TIME_MS,
        vantaPreset: { targetElo: 1500, maxDepth: 6, nodeLimit: 260000 },
        targets,
        openings: OPENINGS,
        gamesPerTarget: OPENINGS.length * 2,
        maxPlies: MAX_PLIES,
        note: 'Stockfish UCI_Elo is calibrated at a longer official time control; this is a fast-control empirical bracket, not an exact universal Elo.',
      },
      summary,
      rating,
      totals: {
        games: games.length,
        wins: games.filter(g => g.point === 1).length,
        draws: games.filter(g => g.point === 0.5).length,
        losses: games.filter(g => g.point === 0).length,
        points: games.reduce((n,g) => n + g.point, 0),
      },
      games,
    };

    await mkdir(REPORT_PATH.split('/').slice(0,-1).join('/') || '.', { recursive: true });
    await writeFile(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log('\n=== Vanta Elo calibration ===');
    for (const row of summary) console.log(`vs ${row.opponentElo}: ${row.wins}-${row.draws}-${row.losses}, score ${(row.score * 100).toFixed(1)}%`);
    console.log(`MLE estimate: ${rating.estimate} Elo`);
    console.log(`Approx profile-likelihood 95% interval: ${rating.profile95[0]}-${rating.profile95[1]} Elo`);
    console.log(`Report: ${REPORT_PATH}`);
  } finally {
    stockfish.quit();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

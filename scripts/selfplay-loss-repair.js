import { mkdir, writeFile } from 'node:fs/promises';
import { ChessGame } from '../src/chess/game.js';
import { SearchEngine as LegacySearch } from '../src/engine/search.js';
import { SearchEngine as RepairedSearch } from '../src/engine/search-production.js';

const MOVE_MS = Number(process.env.SELFPLAY_MOVE_MS || 180);
const MAX_PLIES = Number(process.env.SELFPLAY_MAX_PLIES || 90);
const START_CLOCK_MS = Number(process.env.SELFPLAY_CLOCK_MS || 600000);
const REPAIRED_MAX_MS = Number(process.env.SELFPLAY_REPAIRED_MAX_MS || 500);
const REPORT = process.env.SELFPLAY_REPORT || 'benchmarks/selfplay-loss-repair.json';

const OPENINGS = [
  ['Italian', ['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6']],
  ['Sicilian', ['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6']],
  ['Queens Gambit', ['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6']],
  ['French', ['e2e4','e7e6','d2d4','d7d5','b1c3','g8f6']],
  ['Caro-Kann', ['e2e4','c7c6','d2d4','d7d5','b1c3','d5e4','c3e4']],
  ['English', ['c2c4','e7e5','b1c3','g8f6','g2g3','d7d5','c4d5','f6d5']],
  ['Ruy Lopez', ['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6','b5a4','g8f6']],
  ['Scotch', ['e2e4','e7e5','g1f3','b8c6','d2d4','e5d4','f3d4']],
  ['Kings Indian', ['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6']],
  ['Slav', ['d2d4','d7d5','c2c4','c7c6','g1f3','g8f6','b1c3']],
  ['Nimzo-Indian', ['d2d4','g8f6','c2c4','e7e6','b1c3','f8b4']],
  ['Reti', ['g1f3','d7d5','c2c4','e7e6','g2g3','g8f6','f1g2']],
];

function setup(moves) {
  const game = new ChessGame();
  for (const uci of moves) {
    const move = game.position.moveFromUci(uci);
    if (!move) throw new Error(`Illegal opening seed ${uci} after ${game.history.map(x => x.uci).join(' ')}`);
    game.play(move);
  }
  return game;
}

function repairedPoint(result, repairedColor) {
  if (result === '1/2-1/2') return 0.5;
  if (result === '1-0') return repairedColor === 'w' ? 1 : 0;
  if (result === '0-1') return repairedColor === 'b' ? 1 : 0;
  return 0.5;
}

function createEngine(kind) {
  const Search = kind === 'repaired' ? RepairedSearch : LegacySearch;
  return new Search({
    maxDepth: 6,
    moveTimeMs: MOVE_MS,
    nodeLimit: 150000,
    selectionWindow: 32,
    evalNoise: 4,
  });
}

async function play(openingName, seed, repairedColor) {
  const game = setup(seed);
  const startedAt = game.cursor;
  const clocks = { repaired: START_CLOCK_MS, legacy: START_CLOCK_MS };
  let repairedMs = 0, legacyMs = 0;
  let repairedDepth = 0, repairedMoves = 0, legacyDepth = 0, legacyMoves = 0;
  let repairedNodes = 0, legacyNodes = 0;

  while (game.cursor - startedAt < MAX_PLIES) {
    const status = game.status();
    if (status.over) return finish(status.result, status.reason);

    const kind = game.position.turn === repairedColor ? 'repaired' : 'legacy';
    const engine = createEngine(kind);
    const options = kind === 'repaired'
      ? {
          moveTimeMs: MOVE_MS,
          maxDepth: 6,
          maxMoveTimeMs: Math.min(REPAIRED_MAX_MS, Math.max(40, clocks.repaired - 5000)),
          remainingMs: clocks.repaired,
        }
      : { moveTimeMs: Math.min(MOVE_MS, Math.max(40, clocks.legacy - 5000)), maxDepth: 6 };
    const result = engine.search(game.position, options);
    if (!result.move) {
      const now = game.status();
      return finish(now.over ? now.result : '1/2-1/2', now.reason || 'no move');
    }

    clocks[kind] -= result.timeMs || 0;
    if (clocks[kind] <= 0) {
      const resultText = kind === 'repaired'
        ? (repairedColor === 'w' ? '0-1' : '1-0')
        : (repairedColor === 'w' ? '1-0' : '0-1');
      return finish(resultText, `${kind} time forfeit`);
    }

    if (kind === 'repaired') {
      repairedMs += result.timeMs || 0;
      repairedDepth += result.depth || 0;
      repairedNodes += (result.nodes || 0) + (result.qnodes || 0);
      repairedMoves++;
    } else {
      legacyMs += result.timeMs || 0;
      legacyDepth += result.depth || 0;
      legacyNodes += (result.nodes || 0) + (result.qnodes || 0);
      legacyMoves++;
    }
    game.play(result.move);
  }
  return finish('1/2-1/2', 'ply cap');

  function finish(result, reason) {
    return {
      opening: openingName,
      repairedColor,
      result,
      reason,
      point: repairedPoint(result, repairedColor),
      plies: game.cursor - startedAt,
      remainingMs: clocks,
      repaired: {
        moves: repairedMoves,
        averageDepth: repairedMoves ? repairedDepth / repairedMoves : 0,
        averageMoveMs: repairedMoves ? repairedMs / repairedMoves : 0,
        totalNodes: repairedNodes,
      },
      legacy: {
        moves: legacyMoves,
        averageDepth: legacyMoves ? legacyDepth / legacyMoves : 0,
        averageMoveMs: legacyMoves ? legacyMs / legacyMoves : 0,
        totalNodes: legacyNodes,
      },
      moves: game.history.map(x => x.uci),
    };
  }
}

function mean(values) { return values.reduce((a,b) => a+b, 0) / Math.max(1, values.length); }
function sampleSd(values) {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(values.reduce((s,x) => s + (x-m)**2, 0) / (values.length - 1));
}

const games = [];
for (const [name, seed] of OPENINGS) {
  for (const color of ['w','b']) {
    const game = await play(name, seed, color);
    games.push(game);
    console.log(`${games.length}/${OPENINGS.length*2} ${name} repaired=${color}: ${game.result} (${game.reason})`);
  }
}

const points = games.map(g => g.point);
const score = mean(points);
const se = sampleSd(points) / Math.sqrt(points.length);
const ci95 = [Math.max(0, score - 1.96 * se), Math.min(1, score + 1.96 * se)];
const avg = key => mean(games.map(g => g[key].averageMoveMs));
const avgDepth = key => mean(games.map(g => g[key].averageDepth));
const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    games: games.length,
    openings: OPENINGS.map(([name, moves]) => ({name, moves})),
    alternatingColors: true,
    baseMoveTimeMs: MOVE_MS,
    repairedCriticalMoveCapMs: REPAIRED_MAX_MS,
    logicalStartClockMs: START_CLOCK_MS,
    maxPlies: MAX_PLIES,
    note: 'Paired deterministic scaled-rapid regression match with equal logical clocks. Repaired Vanta may spend more on volatile moves because dynamic time management is part of the tested change. This is not a universal Elo estimate.',
  },
  totals: {
    games: games.length,
    wins: games.filter(g => g.point === 1).length,
    draws: games.filter(g => g.point === 0.5).length,
    losses: games.filter(g => g.point === 0).length,
    points: points.reduce((a,b) => a+b,0),
    score,
    score95: ci95,
    repairedAverageMoveMs: avg('repaired'),
    legacyAverageMoveMs: avg('legacy'),
    repairedAverageDepth: avgDepth('repaired'),
    legacyAverageDepth: avgDepth('legacy'),
  },
  games,
};

await mkdir(REPORT.split('/').slice(0,-1).join('/') || '.', { recursive: true });
await writeFile(REPORT, JSON.stringify(report, null, 2));
console.log(`Repaired score: ${(score*100).toFixed(1)}% (${report.totals.wins}-${report.totals.draws}-${report.totals.losses}), approximate score CI ${(ci95[0]*100).toFixed(1)}-${(ci95[1]*100).toFixed(1)}%`);
console.log(`Wrote ${REPORT}`);

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';
import { ChessGame } from '../chess/game.js';
import { typeOf } from '../chess/constants.js';

const INPUT_DIR = process.argv[2] || 'benchmarks/stress-shards';
const OUTPUT = process.argv[3] || 'benchmarks/stress-1650.json';
const ANALYSIS_DEPTH = Number(process.env.STRESS_ANALYSIS_DEPTH || 9);
const BLUNDER_CP = Number(process.env.STRESS_BLUNDER_CP || 180);
const MISTAKE_CP = Number(process.env.STRESS_MISTAKE_CP || 90);

function scoreFromInfo(lines) {
  let chosen = null;
  for (const line of lines) {
    if (!line.startsWith('info ')) continue;
    const depthMatch = line.match(/\bdepth\s+(\d+)/);
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    if (!scoreMatch) continue;
    const depth = depthMatch ? Number(depthMatch[1]) : 0;
    if (chosen && depth < chosen.depth) continue;
    let score;
    let mate = null;
    if (scoreMatch[1] === 'cp') score = Number(scoreMatch[2]);
    else {
      mate = Number(scoreMatch[2]);
      score = mate > 0
        ? 100000 - Math.min(999, Math.abs(mate))
        : -100000 + Math.min(999, Math.abs(mate));
    }
    chosen = { depth, score, mate };
  }
  return chosen || { depth: 0, score: 0, mate: null };
}

class Analyzer {
  constructor(binary = '/usr/games/stockfish') {
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
        reject(new Error('Stockfish analysis timeout'));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
  async init() {
    this.send('uci');
    await this.waitFor(x => x === 'uciok');
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 64');
    this.send('setoption name UCI_LimitStrength value false');
    this.send('isready');
    await this.waitFor(x => x === 'readyok');
  }
  async eval(history, searchMove = null) {
    const start = this.lines.length;
    this.send(history.length ? `position startpos moves ${history.join(' ')}` : 'position startpos');
    this.send(`go depth ${ANALYSIS_DEPTH}${searchMove ? ` searchmoves ${searchMove}` : ''}`);
    const bestLine = await this.waitFor(x => x.startsWith('bestmove '), 15000);
    const bestMove = bestLine.split(/\s+/)[1];
    const relevant = this.lines.slice(start);
    const scored = scoreFromInfo(relevant);
    return {
      score: scored.score,
      mate: scored.mate,
      depth: scored.depth,
      bestMove: bestMove === '(none)' ? null : bestMove,
    };
  }
  quit() {
    try { this.send('quit'); } catch {}
    this.rl.close();
    this.proc.kill();
  }
}

async function loadReports() {
  const files = (await readdir(INPUT_DIR)).filter(x => x.endsWith('.json')).sort();
  const reports = [];
  for (const file of files) reports.push(JSON.parse(await readFile(`${INPUT_DIR}/${file}`, 'utf8')));
  return reports;
}

function totals(games) {
  const wins = games.filter(x => x.point === 1).length;
  const draws = games.filter(x => x.point === 0.5).length;
  const losses = games.filter(x => x.point === 0).length;
  const points = games.reduce((n, x) => n + x.point, 0);
  return {
    games: games.length,
    wins,
    draws,
    losses,
    points,
    winRate: Number((wins / Math.max(1, games.length)).toFixed(3)),
    scoreRate: Number((points / Math.max(1, games.length)).toFixed(3)),
  };
}

function aggregateStyle(games) {
  const moves = games.flatMap(g => g.vantaMoves || []);
  const early = moves.filter(m => m.ply <= 20);
  const queenEarly = early.filter(m => m.piece === 'q').length;
  const highRisk = moves.filter(m => m.selectedRisk >= 300).length;
  const veryHighRisk = moves.filter(m => m.selectedRisk >= 700).length;
  const safetyTriggered = moves.filter(m => m.safetyTriggered).length;
  const unstable = moves.filter(m => m.unstable).length;
  const avg = key => moves.length ? moves.reduce((n,m) => n + (Number(m[key]) || 0), 0) / moves.length : 0;
  return {
    vantaMoves: moves.length,
    earlyQueenMoves: queenEarly,
    earlyQueenMovesPerGame: Number((queenEarly / Math.max(1, games.length)).toFixed(2)),
    highRiskMoves: highRisk,
    veryHighRiskMoves: veryHighRisk,
    safetyTriggeredMoves: safetyTriggered,
    unstableSearchMoves: unstable,
    averageDepth: Number(avg('depth').toFixed(2)),
    averageNodes: Math.round(avg('nodes')),
    averageThinkMs: Math.round(avg('timeMs')),
    averageTargetElo: Math.round(avg('targetElo')),
  };
}

async function analyzeGame(analyzer, game) {
  const vantaByPly = new Map((game.vantaMoves || []).map(m => [m.ply, m]));
  const replay = new ChessGame();
  const diagnostics = [];
  for (let i = 0; i < game.moves.length; i++) {
    const ply = i + 1;
    const uci = game.moves[i];
    const meta = vantaByPly.get(ply);
    if (meta) {
      const history = replay.history.map(x => x.uci);
      const fen = replay.position.toFEN();
      const best = await analyzer.eval(history);
      // If unrestricted Stockfish chooses exactly Vanta's move, its objective
      // loss is zero by definition. Re-searching the same root move can produce
      // a different numeric score at finite depth because of hash/order effects;
      // treating that as a blunder created impossible diagnostics such as
      // "best Rf4, played Rf4, -99,000 cp".
      const played = best.bestMove === uci ? best : await analyzer.eval(history, uci);
      const loss = best.bestMove === uci ? 0 : Math.max(0, best.score - played.score);
      const move = replay.position.moveFromUci(uci);
      diagnostics.push({
        gameIndex: game.gameIndex,
        opening: game.opening,
        result: game.result,
        vantaColor: game.vantaColor,
        ply,
        fen,
        uci,
        piece: move ? typeOf(move.piece) : meta.piece,
        capture: Boolean(move?.captured),
        stockfishBest: best.bestMove,
        bestScore: best.score,
        bestMate: best.mate,
        playedScore: played.score,
        playedMate: played.mate,
        lossCp: loss,
        severity: loss >= BLUNDER_CP ? 'blunder' : loss >= MISTAKE_CP ? 'mistake' : 'ok',
        depth: meta.depth,
        nodes: meta.nodes,
        timeMs: meta.timeMs,
        objectiveScore: meta.objectiveScore,
        selectedRisk: meta.selectedRisk,
        safetyTriggered: meta.safetyTriggered,
        criticality: meta.criticality,
        targetElo: meta.targetElo,
        unstable: meta.unstable,
      });
    }
    replay.playUci(uci);
  }
  return diagnostics;
}

function classify(diag) {
  if (diag.lossCp < MISTAKE_CP) return 'small';
  if (diag.playedMate !== null && diag.playedMate < 0) return 'mate-horizon';
  if (diag.selectedRisk >= 700) return 'known-tactical-risk';
  if (diag.piece === 'q' && diag.ply <= 20) return 'early-queen';
  if (diag.capture) return 'capture-calculation';
  if (diag.unstable && diag.depth <= 3) return 'search-instability';
  if (diag.depth <= 2) return 'shallow-search';
  return 'quiet-evaluation-or-horizon';
}

async function main() {
  const reports = await loadReports();
  const games = reports.flatMap(r => r.games || []).sort((a,b) => a.gameIndex - b.gameIndex);
  const config = reports[0]?.config || {};
  if (!games.length) throw new Error('No stress games found.');
  const analyzer = new Analyzer(process.env.STOCKFISH_BIN || '/usr/games/stockfish');
  const diagnostics = [];
  try {
    await analyzer.init();
    for (const game of games) {
      console.log(`Analyze game ${game.gameIndex + 1}/${games.length}: ${game.opening}, ${game.result}`);
      diagnostics.push(...await analyzeGame(analyzer, game));
    }
  } finally {
    analyzer.quit();
  }

  for (const d of diagnostics) d.category = classify(d);
  const significant = diagnostics.filter(d => d.lossCp >= MISTAKE_CP);
  const blunders = diagnostics.filter(d => d.lossCp >= BLUNDER_CP);
  const categoryCounts = {};
  for (const d of significant) categoryCounts[d.category] = (categoryCounts[d.category] || 0) + 1;
  const worst = [...diagnostics].sort((a,b) => b.lossCp - a.lossCp).slice(0, 30);
  const perGame = games.map(game => {
    const ds = diagnostics.filter(d => d.gameIndex === game.gameIndex);
    return {
      gameIndex: game.gameIndex,
      opening: game.opening,
      vantaColor: game.vantaColor,
      result: game.result,
      point: game.point,
      mistakes: ds.filter(d => d.lossCp >= MISTAKE_CP).length,
      blunders: ds.filter(d => d.lossCp >= BLUNDER_CP).length,
      maxLossCp: Math.max(0, ...ds.map(d => d.lossCp)),
      avgLossCp: Number((ds.reduce((n,d) => n + d.lossCp, 0) / Math.max(1, ds.length)).toFixed(1)),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      ...config,
      pairedRandomOpenings: true,
      openingPositions: Math.ceil(games.length / 2),
      analysisDepth: ANALYSIS_DEPTH,
      mistakeThresholdCp: MISTAKE_CP,
      blunderThresholdCp: BLUNDER_CP,
      note: 'Every randomized opening position is played twice with colors reversed. Stockfish post-game analysis runs at full strength and is separate from the 1650-limited match engine.',
    },
    totals: totals(games),
    style: aggregateStyle(games),
    diagnostics: {
      analyzedVantaMoves: diagnostics.length,
      mistakes: significant.length,
      blunders: blunders.length,
      categoryCounts,
      worst,
      perGame,
    },
    games,
  };

  await mkdir(OUTPUT.split('/').slice(0,-1).join('/') || '.', { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(report, null, 2));
  console.log('\n=== Vanta 1650 stress result ===');
  console.log(`${report.totals.wins}W ${report.totals.draws}D ${report.totals.losses}L`);
  console.log(`Win rate ${(report.totals.winRate * 100).toFixed(1)}%`);
  console.log(`Score rate ${(report.totals.scoreRate * 100).toFixed(1)}%`);
  console.log(`Mistakes ${significant.length}, blunders ${blunders.length}`);
  console.log(`Categories ${JSON.stringify(categoryCounts)}`);
  console.log('Worst moves:');
  for (const d of worst.slice(0, 12)) console.log(`  G${d.gameIndex + 1} ply ${d.ply} ${d.uci}: -${d.lossCp} cp, best ${d.stockfishBest}, ${d.category}`);
  console.log(`Report: ${OUTPUT}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { ChessGame } from '../chess/game.js';
import { typeOf } from '../chess/constants.js';

const INPUT = process.argv[2] || 'benchmarks/stress-256-shard-0.json';
const OUTPUT = process.argv[3] || 'benchmarks/sf18-audit-shard-0.json';
const SCREEN_NODES = Number(process.env.SF18_SCREEN_NODES || 200000);
const VERIFY_NODES = Number(process.env.SF18_VERIFY_NODES || 1000000);
const CONFIRM_NODES = Number(process.env.SF18_CONFIRM_NODES || 4000000);
const CANDIDATE_CP = Number(process.env.SF18_CANDIDATE_CP || 35);
const MISTAKE_CP = Number(process.env.SF18_MISTAKE_CP || 50);
const BLUNDER_CP = Number(process.env.SF18_BLUNDER_CP || 100);
const THREADS = Number(process.env.SF18_THREADS || 2);
const HASH_MB = Number(process.env.SF18_HASH_MB || 512);

function scoreFromInfo(lines) {
  let chosen = null;
  for (const line of lines) {
    if (!line.startsWith('info ')) continue;
    if (/\b(lowerbound|upperbound)\b/.test(line)) continue;
    const scoreMatch = line.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    if (!scoreMatch) continue;
    const depth = Number(line.match(/\bdepth\s+(\d+)/)?.[1] || 0);
    const seldepth = Number(line.match(/\bseldepth\s+(\d+)/)?.[1] || 0);
    const nodes = Number(line.match(/\bnodes\s+(\d+)/)?.[1] || 0);
    const wdlMatch = line.match(/\bwdl\s+(\d+)\s+(\d+)\s+(\d+)/);
    let score;
    let mate = null;
    if (scoreMatch[1] === 'cp') {
      score = Number(scoreMatch[2]);
    } else {
      mate = Number(scoreMatch[2]);
      score = mate > 0
        ? 100000 - Math.min(999, Math.abs(mate))
        : -100000 + Math.min(999, Math.abs(mate));
    }
    const next = {
      depth,
      seldepth,
      nodes,
      score,
      mate,
      wdl: wdlMatch ? wdlMatch.slice(1).map(Number) : null,
    };
    if (!chosen || depth > chosen.depth || (depth === chosen.depth && nodes >= chosen.nodes)) chosen = next;
  }
  return chosen || { depth: 0, seldepth: 0, nodes: 0, score: 0, mate: null, wdl: null };
}

class Analyzer {
  constructor(binary) {
    this.binary = binary;
    this.proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'inherit'] });
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

  waitFor(predicate, timeoutMs = 30000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new Error(`Stockfish 18 analysis timeout (${this.binary})`));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async init() {
    this.send('uci');
    await this.waitFor(line => line === 'uciok');
    const id = this.lines.find(line => line.startsWith('id name '))?.slice(8) || 'Stockfish';
    this.send(`setoption name Threads value ${THREADS}`);
    this.send(`setoption name Hash value ${HASH_MB}`);
    this.send('setoption name UCI_LimitStrength value false');
    this.send('setoption name MultiPV value 1');
    this.send('setoption name UCI_ShowWDL value true');
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
    return id;
  }

  async clearHash() {
    this.send('setoption name Clear Hash');
    this.send('isready');
    await this.waitFor(line => line === 'readyok');
  }

  async eval(history, searchMove, nodes) {
    await this.clearHash();
    const start = this.lines.length;
    this.send(history.length ? `position startpos moves ${history.join(' ')}` : 'position startpos');
    this.send(`go nodes ${nodes}${searchMove ? ` searchmoves ${searchMove}` : ''}`);
    const bestLine = await this.waitFor(line => line.startsWith('bestmove '), Math.max(30000, Math.ceil(nodes / 1000) + 30000));
    const bestMove = bestLine.split(/\s+/)[1];
    const scored = scoreFromInfo(this.lines.slice(start));
    return {
      ...scored,
      bestMove: bestMove && bestMove !== '(none)' ? bestMove : null,
    };
  }

  quit() {
    try { this.send('quit'); } catch {}
    this.rl.close();
    this.proc.kill();
  }
}

function mateBlunder(best, played) {
  return played.mate !== null && played.mate < 0 && !(best.mate !== null && best.mate < 0);
}

function evalLoss(best, played, playedUci) {
  if (best.bestMove === playedUci) return 0;
  return Math.max(0, best.score - played.score);
}

async function compareMove(analyzer, history, playedUci, nodes) {
  const best = await analyzer.eval(history, null, nodes);
  if (!best.bestMove || best.bestMove === playedUci) {
    return {
      nodes,
      best,
      played: best,
      lossCp: 0,
      mateBlunder: false,
    };
  }
  const played = await analyzer.eval(history, playedUci, nodes);
  return {
    nodes,
    best,
    played,
    lossCp: evalLoss(best, played, playedUci),
    mateBlunder: mateBlunder(best, played),
  };
}

function severityFor(comparison) {
  if (comparison.mateBlunder || comparison.lossCp >= BLUNDER_CP) return 'blunder';
  if (comparison.lossCp >= MISTAKE_CP) return 'mistake';
  return 'ok';
}

function categoryFor(diag) {
  if (diag.mateBlunder) return 'conceded-forced-mate';
  if (diag.capture) return 'capture-calculation';
  if (diag.piece === 'q' && diag.ply <= 20) return 'early-queen';
  if (diag.selectedRisk >= 700) return 'known-tactical-risk';
  if (diag.unstable) return 'search-instability';
  if (diag.depth <= 3) return 'shallow-search';
  return 'quiet-evaluation-or-horizon';
}

async function analyzeMove(analyzer, replay, game, meta) {
  const history = replay.history.map(x => x.uci);
  const fen = replay.position.toFEN();
  const move = replay.position.moveFromUci(meta.uci);
  const screen = await compareMove(analyzer, history, meta.uci, SCREEN_NODES);
  let final = screen;
  let verify = null;
  let confirm = null;

  if (screen.mateBlunder || screen.lossCp >= CANDIDATE_CP) {
    verify = await compareMove(analyzer, history, meta.uci, VERIFY_NODES);
    final = verify;
    if (verify.mateBlunder || verify.lossCp >= BLUNDER_CP) {
      confirm = await compareMove(analyzer, history, meta.uci, CONFIRM_NODES);
      final = confirm;
    }
  }

  const diag = {
    gameIndex: game.gameIndex,
    pairId: game.pairId,
    opening: game.opening,
    result: game.result,
    vantaColor: game.vantaColor,
    ply: meta.ply,
    fen,
    uci: meta.uci,
    piece: move ? typeOf(move.piece) : meta.piece,
    capture: Boolean(move?.captured),
    stockfishBest: final.best.bestMove,
    bestScore: final.best.score,
    bestMate: final.best.mate,
    bestWdl: final.best.wdl,
    playedScore: final.played.score,
    playedMate: final.played.mate,
    playedWdl: final.played.wdl,
    lossCp: final.lossCp,
    mateBlunder: final.mateBlunder,
    severity: severityFor(final),
    auditStage: confirm ? 'confirm' : verify ? 'verify' : 'screen',
    auditNodes: final.nodes,
    stockfishDepth: final.best.depth,
    stockfishSelDepth: final.best.seldepth,
    screenLossCp: screen.lossCp,
    verifyLossCp: verify?.lossCp ?? null,
    confirmLossCp: confirm?.lossCp ?? null,
    depth: meta.depth,
    nodes: meta.nodes,
    timeMs: meta.timeMs,
    objectiveScore: meta.objectiveScore,
    selectedRisk: meta.selectedRisk,
    safetyTriggered: meta.safetyTriggered,
    criticality: meta.criticality,
    targetElo: meta.targetElo,
    unstable: meta.unstable,
  };
  diag.category = categoryFor(diag);
  return diag;
}

async function analyzeGame(analyzer, game) {
  const vantaByPly = new Map((game.vantaMoves || []).map(move => [move.ply, move]));
  const replay = new ChessGame();
  const diagnostics = [];
  for (let i = 0; i < game.moves.length; i++) {
    const ply = i + 1;
    const meta = vantaByPly.get(ply);
    if (meta) {
      const diag = await analyzeMove(analyzer, replay, game, meta);
      diagnostics.push(diag);
      if (diag.severity !== 'ok') {
        console.log(`  G${game.gameIndex + 1} ply ${ply} ${meta.uci}: ${diag.severity} -${diag.lossCp} cp; SF18 ${diag.stockfishBest}; stage ${diag.auditStage}`);
      }
    }
    replay.playUci(game.moves[i]);
  }
  return diagnostics;
}

function gameTotals(games) {
  const wins = games.filter(game => game.point === 1).length;
  const draws = games.filter(game => game.point === 0.5).length;
  const losses = games.filter(game => game.point === 0).length;
  const points = games.reduce((sum, game) => sum + game.point, 0);
  return {
    games: games.length,
    wins,
    draws,
    losses,
    points,
    winRate: Number((wins / Math.max(1, games.length)).toFixed(4)),
    scoreRate: Number((points / Math.max(1, games.length)).toFixed(4)),
  };
}

async function main() {
  const match = JSON.parse(await readFile(INPUT, 'utf8'));
  const games = [...(match.games || [])].sort((a, b) => a.gameIndex - b.gameIndex);
  if (!games.length) throw new Error(`No games found in ${INPUT}`);

  const analyzer = new Analyzer(process.env.STOCKFISH_BIN || '/usr/games/stockfish');
  const diagnostics = [];
  let stockfishId = 'Stockfish 18';
  try {
    stockfishId = await analyzer.init();
    console.log(`Max analyzer: ${stockfishId}; Threads=${THREADS}; Hash=${HASH_MB} MB`);
    console.log(`Screen=${SCREEN_NODES} nodes; verify=${VERIFY_NODES}; confirm=${CONFIRM_NODES}; blunder >= ${BLUNDER_CP} cp`);
    for (const game of games) {
      console.log(`Analyze game ${game.gameIndex + 1}: ${game.opening}, Vanta ${game.vantaColor}, ${game.result}`);
      diagnostics.push(...await analyzeGame(analyzer, game));
    }
  } finally {
    analyzer.quit();
  }

  const mistakes = diagnostics.filter(d => d.severity === 'mistake');
  const blunders = diagnostics.filter(d => d.severity === 'blunder');
  const worst = [...diagnostics].sort((a, b) => b.lossCp - a.lossCp).slice(0, 24);
  const categoryCounts = {};
  for (const diag of diagnostics.filter(d => d.severity !== 'ok')) {
    categoryCounts[diag.category] = (categoryCounts[diag.category] || 0) + 1;
  }

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: {
      reference: stockfishId,
      fullStrength: true,
      threads: THREADS,
      hashMb: HASH_MB,
      screenNodes: SCREEN_NODES,
      verifyNodes: VERIFY_NODES,
      confirmNodes: CONFIRM_NODES,
      candidateThresholdCp: CANDIDATE_CP,
      mistakeThresholdCp: MISTAKE_CP,
      blunderThresholdCp: BLUNDER_CP,
      mateRule: 'A move is a blunder if it concedes a forced mate when the Stockfish-best line did not have a forced mate against Vanta.',
      note: 'Stockfish itself reports evaluations rather than a universal blunder label. This gate defines a blunder as a Stockfish-18-confirmed loss of at least the configured centipawn threshold, or the forced-mate rule above. Candidate moves are re-searched at larger fixed node budgets before the verdict is accepted.',
    },
    matchConfig: match.config,
    totals: gameTotals(games),
    diagnostics: {
      analyzedVantaMoves: diagnostics.length,
      mistakes: mistakes.length,
      blunders: blunders.length,
      zeroBlunderGate: blunders.length === 0,
      categoryCounts,
      worst,
      all: diagnostics,
    },
    games,
  };

  await mkdir(OUTPUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(report, null, 2));
  console.log(`Shard result: ${report.totals.wins}W ${report.totals.draws}D ${report.totals.losses}L; ${diagnostics.length} Vanta moves; ${mistakes.length} mistakes; ${blunders.length} confirmed blunders`);
  console.log(`Report: ${OUTPUT}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { Position, moveToUci } from '../src/chess/position.js';
import { parsePgn, positionBeforeSan, positionAfterSan } from '../src/chess/pgn.js';
import { SearchEngine as LegacySearch } from '../src/engine/search.js';
import { SearchEngine as RepairedSearch } from '../src/engine/search-production.js';

const MOVE_MS = Number(process.env.SUITE_MOVE_MS || 650);
const SF_DEPTH = Number(process.env.SUITE_SF_DEPTH || 11);
const REPORT = process.env.SUITE_REPORT || 'benchmarks/stockfish-suite-compare.json';

const pgn = await readFile(new URL('../tests/fixtures/vanta-vs-1266.pgn', import.meta.url), 'utf8');
const loss = parsePgn(pgn);

const cases = [
  { group: 'opening', name: '1266 loss A: unusual knight manoeuvre', fen: positionBeforeSan(loss, 'Nd5') },
  { group: 'tactical', name: '1266 loss C: Nc2+ fork threat', fen: positionBeforeSan(loss, 'Ne6') },
  { group: 'promotion', name: '1266 loss D: f-pawn advance', fen: positionBeforeSan(loss, 'f3', 2) },
  { group: 'promotion', name: '1266 loss E: f2 promotion threat', fen: positionAfterSan(loss, 'f2+') },
  { group: 'promotion', name: '1266 loss F: distant a-pawn', fen: positionBeforeSan(loss, 'a3', 1) },
  { group: 'tactical', name: 'Mate in one', fen: '6k1/8/6KQ/8/8/8/8/8 w - - 0 1' },
  { group: 'tactical', name: 'Hanging queen', fen: '6k1/8/8/8/3q4/8/3R4/6K1 w - - 0 1' },
  { group: 'tactical', name: 'Only legal check defense', fen: '6k1/8/8/8/8/8/4r3/4K3 w - - 0 1' },
  { group: 'tactical', name: 'Knight king-queen fork', fen: '3k3q/8/8/4N3/8/8/8/4K3 w - - 0 1' },
  { group: 'promotion', name: 'Supported checking promotion', fen: '1k3r2/8/8/8/8/8/5p2/7K b - - 0 1' },
  { group: 'tactical', name: 'Poisoned queen capture', fen: '3r2k1/8/8/3p4/8/8/8/3Q2K1 w - - 0 1' },
  { group: 'tactical', name: 'Back-rank mating attack', fen: '6k1/5ppp/8/8/8/8/8/4R1K1 w - - 0 1' },
  { group: 'tactical', name: 'Absolute pin on queen', fen: '4k3/4q3/8/8/8/8/4R3/4K3 w - - 0 1' },
  { group: 'tactical', name: 'Discovered-file attack', fen: '4k3/8/8/8/8/8/4B3/4R1K1 w - - 0 1' },
  { group: 'quiet', name: 'Starting position', fen: Position.start().toFEN() },
  { group: 'quiet', name: 'Italian development', fen: 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w kq - 6 6' },
  { group: 'quiet', name: 'Queens Gambit structure', fen: 'rnbq1rk1/pp2bppp/2p1pn2/3p4/2PP4/2N1PN2/PP3PPP/R1BQKB1R w KQ - 2 7' },
  { group: 'king-safety', name: 'Attacking middlegame', fen: 'r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2N2Q1P/PPPP1PP1/R1B2RK1 w - - 2 9' },
  { group: 'king-safety', name: 'Queen near exposed king', fen: '6k1/5ppp/8/7Q/8/8/5PPP/6K1 w - - 0 1' },
];

class UciStockfish {
  constructor(binary) {
    this.proc = spawn(binary, [], { stdio: ['pipe','pipe','inherit'] });
    this.waiters = [];
    this.lastInfo = null;
    this.rl = createInterface({ input: this.proc.stdout });
    this.rl.on('line', line => {
      if (line.startsWith('info ')) this.lastInfo = line;
      for (const waiter of [...this.waiters]) {
        if (!waiter.test(line)) continue;
        clearTimeout(waiter.timer);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        waiter.resolve(line);
      }
    });
  }
  send(s) { this.proc.stdin.write(`${s}\n`); }
  wait(test, ms = 45000) {
    return new Promise((resolve, reject) => {
      const waiter = { test, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error('Stockfish timeout'));
      }, ms);
      this.waiters.push(waiter);
    });
  }
  async init() {
    this.send('uci'); await this.wait(line => line === 'uciok');
    this.send('setoption name Threads value 1');
    this.send('setoption name Hash value 64');
    this.send('isready'); await this.wait(line => line === 'readyok');
  }
  async analyze(fen, depth = SF_DEPTH) {
    this.lastInfo = null;
    this.send(`position fen ${fen}`);
    this.send(`go depth ${depth}`);
    const best = await this.wait(line => line.startsWith('bestmove '));
    const info = this.lastInfo || '';
    const scoreMatch = info.match(/\bscore\s+(cp|mate)\s+(-?\d+)/);
    const kind = scoreMatch?.[1] || 'cp';
    const raw = Number(scoreMatch?.[2] || 0);
    const score = kind === 'mate' ? Math.sign(raw || 1) * (100000 - Math.min(999, Math.abs(raw)) * 100) : raw;
    return { move: best.split(/\s+/)[1], score, rawScore: { kind, value: raw } };
  }
  quit() { try { this.send('quit'); } catch {} this.rl.close(); this.proc.kill(); }
}

async function findStockfish() {
  for (const candidate of [process.env.STOCKFISH_BIN, '/usr/games/stockfish', '/usr/bin/stockfish'].filter(Boolean)) {
    try { await access(candidate); return candidate; } catch {}
  }
  return 'stockfish';
}

function runVanta(Search, position, repaired) {
  const engine = new Search({ maxDepth: 6, moveTimeMs: MOVE_MS, nodeLimit: 260000, selectionWindow: 32, evalNoise: 4 });
  return engine.search(position, repaired
    ? { maxDepth: 6, moveTimeMs: MOVE_MS, maxMoveTimeMs: Math.max(MOVE_MS, 1800) }
    : { maxDepth: 6, moveTimeMs: MOVE_MS });
}

function aggregate(rows, variant, groups) {
  const selected = rows.filter(row => groups.includes(row.group));
  const values = selected.map(row => row[variant]);
  const mean = key => values.reduce((sum, x) => sum + x[key], 0) / Math.max(1, values.length);
  return {
    positions: values.length,
    bestMoveMatches: values.filter(x => x.bestMoveMatch).length,
    solveRate80cp: Number((values.filter(x => x.cpLoss <= 80).length / Math.max(1, values.length) * 100).toFixed(1)),
    averageCpLoss: Number(mean('cpLoss').toFixed(1)),
    averageDepth: Number(mean('depth').toFixed(2)),
    averageNodes: Math.round(mean('nodes')),
    averageMoveMs: Number(mean('timeMs').toFixed(1)),
  };
}

const sf = new UciStockfish(await findStockfish());
await sf.init();
const rows = [];
try {
  for (const testCase of cases) {
    const position = Position.fromFEN(testCase.fen);
    const rootStatus = position.status();
    if (rootStatus.over) throw new Error(`Suite root is terminal: ${testCase.name}`);
    const root = await sf.analyze(testCase.fen);
    const row = { group: testCase.group, name: testCase.name, fen: testCase.fen, stockfish: root, legacy: null, repaired: null };

    for (const [variant, Search, repaired] of [['legacy', LegacySearch, false], ['repaired', RepairedSearch, true]]) {
      const result = runVanta(Search, position, repaired);
      const uci = result.move ? moveToUci(result.move) : null;
      let choiceScore = -100000;
      if (result.move) {
        const after = position.makeMove(result.move);
        const terminal = after.status();
        if (terminal.over) {
          choiceScore = terminal.reason === 'checkmate' ? 100000 : 0;
        } else {
          const child = await sf.analyze(after.toFEN());
          choiceScore = -child.score;
        }
      }
      row[variant] = {
        move: uci,
        bestMoveMatch: uci === root.move,
        stockfishScore: choiceScore,
        cpLoss: Math.max(0, Math.min(20000, root.score - choiceScore)),
        depth: result.depth || 0,
        nodes: (result.nodes || 0) + (result.qnodes || 0),
        timeMs: result.timeMs || 0,
        criticality: result.criticality ?? null,
      };
    }
    rows.push(row);
    console.log(`${testCase.group.padEnd(11)} ${testCase.name}: SF ${root.move}, legacy ${row.legacy.move} (${row.legacy.cpLoss}cp), repaired ${row.repaired.move} (${row.repaired.cpLoss}cp)`);
  }
} finally {
  sf.quit();
}

const report = {
  generatedAt: new Date().toISOString(),
  methodology: {
    stockfishDepth: SF_DEPTH,
    vantaBaseMoveTimeMs: MOVE_MS,
    repairedDynamicTime: true,
    solveThresholdCp: 80,
    note: 'Centipawn loss is measured by re-analyzing each chosen move with the same Stockfish depth. Terminal mates are scored directly. The repaired engine may spend extra time on critical roots, matching its rapid time manager.',
  },
  summary: {
    tacticalAndPromotion: {
      legacy: aggregate(rows, 'legacy', ['tactical','promotion']),
      repaired: aggregate(rows, 'repaired', ['tactical','promotion']),
    },
    opening: {
      legacy: aggregate(rows, 'legacy', ['opening']),
      repaired: aggregate(rows, 'repaired', ['opening']),
    },
    quiet: {
      legacy: aggregate(rows, 'legacy', ['quiet']),
      repaired: aggregate(rows, 'repaired', ['quiet']),
    },
    kingSafety: {
      legacy: aggregate(rows, 'legacy', ['king-safety']),
      repaired: aggregate(rows, 'repaired', ['king-safety']),
    },
    all: {
      legacy: aggregate(rows, 'legacy', ['tactical','promotion','opening','quiet','king-safety']),
      repaired: aggregate(rows, 'repaired', ['tactical','promotion','opening','quiet','king-safety']),
    },
  },
  cases: rows,
};

await mkdir(REPORT.split('/').slice(0,-1).join('/') || '.', { recursive: true });
await writeFile(REPORT, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report.summary, null, 2));
console.log(`Wrote ${REPORT}`);

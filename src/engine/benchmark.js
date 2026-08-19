import fs from 'node:fs';
import path from 'node:path';
import { Position, moveToUci } from '../chess/position.js';
import { SearchEngine } from './search-production.js';
import { strengthConfig } from './personality.js';

const performancePositions = [
  ['Starting position', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1'],
  ['Italian tension', 'r1bqk2r/pppp1ppp/2n2n2/2b1p3/2B1P3/2N2N2/PPPP1PPP/R1BQ1RK1 w kq - 6 6'],
  ['King attack', 'r1bq1rk1/ppp2ppp/2np1n2/4p3/2B1P3/2N2Q1P/PPPP1PP1/R1B2RK1 w - - 2 9'],
];

const tacticalCases = [
  {
    name: 'Mate in one',
    fen: '6k1/8/6KQ/8/8/8/8/8 w - - 0 1',
    validate(position, result) {
      return Boolean(result.move) && position.makeMove(result.move).status().reason === 'checkmate';
    },
  },
  {
    name: 'Recover hanging queen',
    fen: '6k1/8/8/8/3q4/8/3R4/6K1 w - - 0 1',
    validate(_position, result) {
      return ['d2d4', 'd2f2'].includes(result.move ? moveToUci(result.move) : '');
    },
  },
  {
    name: 'Answer immediate rook check',
    fen: '6k1/8/8/8/8/8/4r3/4K3 w - - 0 1',
    validate(position, result) {
      if (!result.move) return false;
      const next = position.makeMove(result.move);
      return !next.isInCheck('w');
    },
  },
];

function runSearch(fen, overrides = {}) {
  const position = Position.fromFEN(fen);
  const engine = new SearchEngine({ ...strengthConfig(1500), ...overrides });
  const result = engine.search(position);
  return { position, result };
}

const performanceRows = performancePositions.map(([name, fen]) => {
  const { result } = runSearch(fen);
  const totalNodes = result.nodes + result.qnodes;
  return {
    name,
    bestMove: result.move ? moveToUci(result.move) : null,
    depth: result.depth,
    selectiveDepth: result.selectiveDepth,
    criticality: result.criticality,
    nodes: result.nodes,
    qnodes: result.qnodes,
    totalNodes,
    nodesPerSecond: result.nps,
    moveTimeMs: result.timeMs,
    allocatedTimeMs: result.allocatedTimeMs,
    transpositionHits: result.ttHits,
    transpositionHitRate: result.nodes ? Number((result.ttHits / result.nodes * 100).toFixed(2)) : 0,
  };
});

const tactical = tacticalCases.map(testCase => {
  const { position, result } = runSearch(testCase.fen, {
    maxDepth: 4,
    moveTimeMs: 600,
    nodeLimit: 250000,
    selectionWindow: 0,
    evalNoise: 0,
  });
  return {
    name: testCase.name,
    passed: testCase.validate(position, result),
    move: result.move ? moveToUci(result.move) : null,
    depth: result.depth,
    nodes: result.nodes + result.qnodes,
    timeMs: result.timeMs,
    criticality: result.criticality,
  };
});

const ponderPosition = Position.fromFEN('rnbqkbnr/pppp1ppp/8/4p3/4P3/8/PPPP1PPP/RNBQKBNR w KQkq - 0 2');
const ponderEngine = new SearchEngine({ ...strengthConfig(1500), maxDepth: 4 });
const ponderStart = performance.now();
const branches = ponderEngine.predictBranches(ponderPosition, 4, { depth: 4, timeMs: 360 });
const ponderTimeMs = Math.round(performance.now() - ponderStart);
const cache = new Map(branches.map(branch => [branch.opponentMove, branch]));
const exactProbe = branches[0]?.opponentMove ?? null;
const unexpectedProbe = ponderPosition.legalMoves().map(moveToUci).find(uci => !cache.has(uci)) ?? null;
const ponder = {
  branchesGenerated: branches.length,
  generationTimeMs: ponderTimeMs,
  exactLookupHits: exactProbe && cache.has(exactProbe) ? 1 : 0,
  unexpectedLookupMisses: unexpectedProbe && !cache.has(unexpectedProbe) ? 1 : 0,
  sampleBranches: branches.map(branch => ({
    opponentMove: branch.opponentMove,
    engineMove: branch.engineMove,
    depth: branch.depth,
    criticality: branch.criticality,
    evaluation: branch.evaluation,
  })),
};

const tacticalPassed = tactical.filter(row => row.passed).length;
const report = {
  generatedAt: new Date().toISOString(),
  targetElo: 1500,
  note: 'Target strength is a calibration goal, not an empirically verified Elo rating.',
  performance: performanceRows,
  tactical: {
    passed: tacticalPassed,
    total: tactical.length,
    successRate: Number((tacticalPassed / tactical.length * 100).toFixed(1)),
    cases: tactical,
  },
  ponder,
};

fs.mkdirSync(path.resolve('benchmarks'), { recursive: true });
fs.writeFileSync(path.resolve('benchmarks/latest.json'), `${JSON.stringify(report, null, 2)}\n`);

console.log('Vanta Chess benchmark');
console.table(performanceRows);
console.table(tactical);
console.log(`Tactical success: ${report.tactical.successRate}% (${tacticalPassed}/${tactical.length})`);
console.log(`Ponder: ${ponder.branchesGenerated} branches in ${ponder.generationTimeMs} ms, lookup hit=${ponder.exactLookupHits}, lookup miss=${ponder.unexpectedLookupMisses}`);
console.log('Wrote benchmarks/latest.json');

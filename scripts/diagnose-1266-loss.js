import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parsePgn, positionBeforeSan, positionAfterSan } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';

const pgn = await readFile(new URL('../tests/fixtures/vanta-vs-1266.pgn', import.meta.url), 'utf8');
const parsed = parsePgn(pgn);

const cases = [
  { id: 'A-before-9-Nd5', fen: positionBeforeSan(parsed, 'Nd5'), suspect: 'c3d5' },
  { id: 'B-after-9-Nxe4', fen: positionAfterSan(parsed, 'Nxe4', 1), suspect: 'g5e4' },
  { id: 'C-before-17-Ne6', fen: positionBeforeSan(parsed, 'Ne6'), suspect: 'g5e6' },
  { id: 'D-before-28-f3', fen: positionBeforeSan(parsed, 'f3', 2), suspect: null },
  { id: 'E-after-30-f2-check', fen: positionAfterSan(parsed, 'f2+'), suspect: null },
  { id: 'F-before-51-a3', fen: positionBeforeSan(parsed, 'a3', 1), suspect: null },
];

const ponderCases = [
  { id: 'ponder-after-8-e4', fen: positionAfterSan(parsed, 'e4', 1), actualOpponentMove: 'f5g6', actualVantaReply: 'c3d5' },
  { id: 'ponder-after-16-Qh3-check', fen: positionAfterSan(parsed, 'Qh3+', 1), actualOpponentMove: 'd8d7', actualVantaReply: 'g5e6' },
];

function summarizeLine(line) {
  if (!line) return null;
  return {
    move: moveToUci(line.move),
    score: line.score,
    personality: line.personality,
    exact: line.exact,
    pv: line.pv.map(moveToUci),
  };
}

const report = {
  generatedAt: new Date().toISOString(),
  commitHint: process.env.GITHUB_SHA || null,
  cases: [],
  ponderCases: [],
};

for (const item of cases) {
  const position = Position.fromFEN(item.fen);
  const engine = new SearchEngine({ maxDepth: 6, moveTimeMs: 650, nodeLimit: 260000 });
  const result = engine.search(position, { maxDepth: 6, moveTimeMs: 650 });

  const rootEngine = new SearchEngine({ maxDepth: 4, moveTimeMs: 5000, nodeLimit: 1_000_000, selectionWindow: 0, evalNoise: 0 });
  rootEngine.resetStats();
  rootEngine.start = 0;
  rootEngine.deadline = 0;
  const root = rootEngine.searchRoot(position, 4, {});
  const suspectLine = item.suspect ? root.lines.find(line => moveToUci(line.move) === item.suspect) : null;

  report.cases.push({
    id: item.id,
    fen: item.fen,
    chosen: result.move ? moveToUci(result.move) : null,
    score: result.score,
    objectiveScore: result.objectiveScore,
    depth: result.depth,
    nodes: result.nodes,
    qnodes: result.qnodes,
    ttHits: result.ttHits,
    cutoffs: result.cutoffs,
    timeMs: result.timeMs,
    pv: result.pv.map(moveToUci),
    candidates: result.candidates,
    suspect: item.suspect,
    suspectDepth4: summarizeLine(suspectLine),
    rootDepth4Top: root.lines.slice(0, 10).map(summarizeLine),
  });
}

for (const item of ponderCases) {
  const position = Position.fromFEN(item.fen);
  const engine = new SearchEngine();
  const branches = engine.predictBranches(position, 4, { depth: 4, timeMs: 280 });
  const hit = branches.find(branch => branch.opponentMove === item.actualOpponentMove) || null;
  report.ponderCases.push({
    ...item,
    branches,
    actualMoveWasPredicted: Boolean(hit),
    cachedReplyMatchedGame: Boolean(hit && hit.engineMove === item.actualVantaReply),
    matchingBranch: hit,
  });
}

await mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true });
await writeFile(new URL('../benchmarks/loss-1266-diagnostic.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { parsePgn, positionBeforeSan, positionAfterSan } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine as LegacySearchEngine } from '../src/engine/search.js';
import { SearchEngine } from '../src/engine/search-production.js';

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

function summarizeResult(result) {
  return {
    chosen: result.move ? moveToUci(result.move) : null,
    score: result.score,
    objectiveScore: result.objectiveScore,
    depth: result.depth,
    selectiveDepth: result.selectiveDepth ?? result.depth,
    nodes: result.nodes,
    qnodes: result.qnodes,
    ttHits: result.ttHits,
    ttCutoffs: result.ttCutoffs ?? 0,
    cutoffs: result.cutoffs,
    lmrReductions: result.lmrReductions ?? 0,
    qPrunes: result.qPrunes ?? 0,
    criticality: result.criticality ?? null,
    allocatedTimeMs: result.allocatedTimeMs ?? null,
    timeMs: result.timeMs,
    pv: result.pv.map(moveToUci),
    depthTrace: result.depthTrace ?? [],
    guard: result.guard ?? null,
    candidates: result.candidates,
  };
}

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

  const legacy = new LegacySearchEngine({ maxDepth: 6, moveTimeMs: 650, nodeLimit: 260000 });
  const before = legacy.search(position, { maxDepth: 6, moveTimeMs: 650 });

  const repaired = new SearchEngine({ maxDepth: 6, moveTimeMs: 650, nodeLimit: 260000 });
  const after = repaired.search(position, { maxDepth: 6, moveTimeMs: 650 });

  const rootEngine = new LegacySearchEngine({ maxDepth: 4, moveTimeMs: 5000, nodeLimit: 1_000_000, selectionWindow: 0, evalNoise: 0 });
  rootEngine.resetStats();
  rootEngine.start = 0;
  rootEngine.deadline = 0;
  const root = rootEngine.searchRoot(position, 4, {});
  const suspectLine = item.suspect ? root.lines.find(line => moveToUci(line.move) === item.suspect) : null;

  report.cases.push({
    id: item.id,
    fen: item.fen,
    suspect: item.suspect,
    before: summarizeResult(before),
    after: summarizeResult(after),
    legacySuspectDepth4: summarizeLine(suspectLine),
    legacyRootDepth4Top: root.lines.slice(0, 10).map(summarizeLine),
  });
}

for (const item of ponderCases) {
  const position = Position.fromFEN(item.fen);
  const legacy = new LegacySearchEngine();
  const legacyBranches = legacy.predictBranches(position, 4, { depth: 4, timeMs: 280 });
  const legacyHit = legacyBranches.find(branch => branch.opponentMove === item.actualOpponentMove) || null;

  const repaired = new SearchEngine();
  const repairedBranches = repaired.predictBranches(position, 4, { depth: 4, timeMs: 280 });
  const repairedHit = repairedBranches.find(branch => branch.opponentMove === item.actualOpponentMove) || null;

  report.ponderCases.push({
    ...item,
    legacy: {
      branches: legacyBranches,
      actualMoveWasPredicted: Boolean(legacyHit),
      cachedReplyMatchedGame: Boolean(legacyHit && legacyHit.engineMove === item.actualVantaReply),
      matchingBranch: legacyHit,
    },
    repaired: {
      branches: repairedBranches,
      actualMoveWasPredicted: Boolean(repairedHit),
      suggestedReplyMatchedGame: Boolean(repairedHit && repairedHit.engineMove === item.actualVantaReply),
      matchingBranch: repairedHit,
      note: 'Repaired controller never auto-plays this suggestion; full move search validates every response.',
    },
  });
}

await mkdir(new URL('../benchmarks/', import.meta.url), { recursive: true });
await writeFile(new URL('../benchmarks/loss-1266-diagnostic.json', import.meta.url), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

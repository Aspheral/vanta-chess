import { readdir, readFile, writeFile, mkdir } from 'node:fs/promises';

const INPUT_DIR = process.argv[2] || 'benchmarks/sf18-shards';
const OUTPUT = process.argv[3] || 'benchmarks/sf18-256.json';

function totals(games) {
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
  const files = (await readdir(INPUT_DIR)).filter(file => file.endsWith('.json')).sort();
  if (!files.length) throw new Error(`No SF18 shard reports found in ${INPUT_DIR}`);

  const reports = [];
  for (const file of files) reports.push(JSON.parse(await readFile(`${INPUT_DIR}/${file}`, 'utf8')));

  const games = reports.flatMap(report => report.games || []).sort((a, b) => a.gameIndex - b.gameIndex);
  const diagnostics = reports.flatMap(report => report.diagnostics?.all || []).sort((a, b) => a.gameIndex - b.gameIndex || a.ply - b.ply);
  const uniqueGameIndexes = new Set(games.map(game => game.gameIndex));
  if (uniqueGameIndexes.size !== games.length) throw new Error('Duplicate game indexes found across shards.');

  const expectedGames = Number(reports[0]?.matchConfig?.games || 256);
  if (games.length !== expectedGames) throw new Error(`Expected ${expectedGames} games, received ${games.length}.`);

  const mistakes = diagnostics.filter(diag => diag.severity === 'mistake');
  const blunders = diagnostics.filter(diag => diag.severity === 'blunder');
  const categoryCounts = {};
  for (const diag of diagnostics.filter(d => d.severity !== 'ok')) {
    categoryCounts[diag.category] = (categoryCounts[diag.category] || 0) + 1;
  }
  const worst = [...diagnostics].sort((a, b) => b.lossCp - a.lossCp).slice(0, 100);
  const perGame = games.map(game => {
    const ds = diagnostics.filter(diag => diag.gameIndex === game.gameIndex);
    return {
      gameIndex: game.gameIndex,
      pairId: game.pairId,
      opening: game.opening,
      vantaColor: game.vantaColor,
      result: game.result,
      point: game.point,
      analyzedMoves: ds.length,
      mistakes: ds.filter(d => d.severity === 'mistake').length,
      blunders: ds.filter(d => d.severity === 'blunder').length,
      maxLossCp: Math.max(0, ...ds.map(d => d.lossCp)),
      averageLossCp: Number((ds.reduce((sum, d) => sum + d.lossCp, 0) / Math.max(1, ds.length)).toFixed(1)),
    };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    methodology: reports[0]?.methodology || {},
    matchConfig: reports[0]?.matchConfig || {},
    totals: totals(games),
    diagnostics: {
      analyzedVantaMoves: diagnostics.length,
      mistakes: mistakes.length,
      blunders: blunders.length,
      zeroBlunderGate: blunders.length === 0,
      categoryCounts,
      worst,
      blundersBySeverity: [...blunders].sort((a, b) => b.lossCp - a.lossCp),
      perGame,
    },
    games,
  };

  await mkdir(OUTPUT.split('/').slice(0, -1).join('/') || '.', { recursive: true });
  await writeFile(OUTPUT, JSON.stringify(report, null, 2));

  console.log('\n=== Vanta 256-game Stockfish 18 Max audit ===');
  console.log(`${report.totals.wins}W ${report.totals.draws}D ${report.totals.losses}L`);
  console.log(`Win rate ${(report.totals.winRate * 100).toFixed(1)}%; score ${(report.totals.scoreRate * 100).toFixed(1)}%`);
  console.log(`Analyzed Vanta moves: ${diagnostics.length}`);
  console.log(`Mistakes: ${mistakes.length}`);
  console.log(`Confirmed blunders: ${blunders.length}`);
  console.log(`Zero-blunder gate: ${report.diagnostics.zeroBlunderGate ? 'PASS' : 'FAIL'}`);
  if (blunders.length) {
    console.log('Worst confirmed blunders:');
    for (const diag of [...blunders].sort((a, b) => b.lossCp - a.lossCp).slice(0, 30)) {
      console.log(`  G${diag.gameIndex + 1} ply ${diag.ply} ${diag.uci}: -${diag.lossCp} cp; SF18 ${diag.stockfishBest}; ${diag.category}; ${diag.fen}`);
    }
  }
  console.log(`Report: ${OUTPUT}`);
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});

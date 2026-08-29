import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { replayPgn, fenBeforePly } from '../src/chess/pgn.js';
import { Position, moveToUci } from '../src/chess/position.js';
import { SearchEngine } from '../src/engine/search.js';
import { evaluateBreakdown } from '../src/engine/evaluation.js';
import { attackReadiness } from '../src/engine/attack-plan.js';
import { positionCriticality, allocateRapidTime, rootTacticalRisk } from '../src/engine/tactics.js';

const here=dirname(fileURLToPath(import.meta.url));
const PGN=readFileSync(join(here,'fixtures','vanta-vs-1227-rapid.pgn'),'utf8');
const replay=replayPgn(PGN);

function engine(ms=1100,depth=4,extra={}) {
  return new SearchEngine({maxDepth:depth,moveTimeMs:ms,nodeLimit:320000,selectionWindow:32,evalNoise:0,...extra});
}

test('1227 rapid win replays exactly to mate',()=>{
  assert.equal(replay.plies.length,78);
  const status=replay.game.status();
  assert.equal(status.result,'0-1');
  assert.equal(status.reason,'checkmate');
  assert.equal(replay.plies[11].san,'Nxe5');
  assert.equal(replay.plies[37].san,'Rxd4');
  assert.equal(replay.plies[41].san,'Bxe7');
});

test('a captured opening minor is not counted as successful development',()=>{
  const healthy=Position.fromFEN('r1bqkbnr/pppppppp/2n5/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 1 1');
  const casualty=Position.fromFEN('r1bqkb1r/pppppppp/2n5/8/8/8/PPPPPPPP/RNBQKBNR b KQkq - 0 1');
  const healthyDev=evaluateBreakdown(healthy,'b').development;
  const casualtyDev=evaluateBreakdown(casualty,'b').development;
  assert.ok(casualtyDev<=healthyDev,`captured knight inflated development: healthy ${healthyDev}, casualty ${casualtyDev}`);
  const healthyReady=attackReadiness(healthy,'b').score;
  const casualtyReady=attackReadiness(casualty,'b').score;
  assert.ok(casualtyReady<=healthyReady,`captured knight inflated readiness: healthy ${healthyReady}, casualty ${casualtyReady}`);
});

test('after 6.f3 an attacked knight is a critical position and Vanta must not ignore it',()=>{
  const p=Position.fromFEN(fenBeforePly(replay,12)); // before 6...Nxe5
  const blunder=p.moveFromUci('c6e5');
  assert.ok(blunder);
  const risk=rootTacticalRisk(p,blunder);
  assert.ok(risk>=280,`Nxe5 tactical risk only ${risk}`);

  const quiet=Position.fromFEN('r1bqkbnr/pppp1ppp/2n5/4p3/4P3/2N2N2/PPPP1PPP/R1BQKB1R b KQkq - 2 3');
  const critical=positionCriticality(p);
  const quietCritical=positionCriticality(quiet);
  assert.ok(critical>=quietCritical+18,`endangered knight was not urgent enough: ${critical} vs quiet ${quietCritical}`);
  const t=allocateRapidTime(p,600000,0);
  const tq=allocateRapidTime(quiet,600000,0);
  assert.ok(t.hardTimeMs>=tq.hardTimeMs+250,`hanging-minor crisis got no extra time: ${JSON.stringify({t,tq})}`);

  const r=engine(1300,4).search(p,{moveTimeMs:1300,maxDepth:4});
  assert.notEqual(moveToUci(r.move),'c6e5',`Vanta still ignored the attacked e4 knight: ${JSON.stringify(r.candidates)}`);
});

test('while already materially behind Vanta rejects the speculative Rxd4 exchange sacrifice',()=>{
  const p=Position.fromFEN(fenBeforePly(replay,38)); // before 19...Rxd4
  const sac=p.moveFromUci('d8d4');
  assert.ok(sac,'expected ...Rxd4 to be legal');
  const risk=rootTacticalRisk(p,sac);
  assert.ok(risk>=300,`Rxd4 tactical risk only ${risk}`);
  const r=engine(1500,4).search(p,{moveTimeMs:1500,maxDepth:4});
  assert.notEqual(moveToUci(r.move),'d8d4',`Vanta still chose speculative Rxd4: ${JSON.stringify(r.candidates)}`);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Position, moveToUci } from '../src/chess/position.js';
import { replayPgn, fenBeforePly } from '../src/chess/pgn.js';
import { SearchEngine } from '../src/engine/search.js';
import { rootTacticalRisk } from '../src/engine/tactics.js';
import { strategicMoveBonus, strategicEvaluation, quietTacticalThreatRisk, cycleUtility } from '../src/engine/strategic-discipline.js';

const DEV_PGN=readFileSync(new URL('./fixtures/itzvanta-vs-devtheexpertback.pgn',import.meta.url),'utf8');
const DAN_PGN=readFileSync(new URL('./fixtures/itzvanta-vs-danhngunhunglanhlung.pgn',import.meta.url),'utf8');
function engine(ms=450){return new SearchEngine({maxDepth:5,moveTimeMs:ms,nodeLimit:180000,selectionWindow:32,evalNoise:0});}

test('August regression: ignoring attacked Na4 trips the tactical seatbelt',()=>{const replay=replayPgn(DEV_PGN);const p=Position.fromFEN(fenBeforePly(replay,11));const bad=p.moveFromUci('c2c3');assert.ok(bad);assert.ok(rootTacticalRisk(p,bad)>=240);assert.notEqual(moveToUci(engine().search(p,{maxDepth:5,moveTimeMs:450}).move),'c2c3');});
test('August regression: queen pawn-grab cannot ignore attacked Nb5',()=>{const replay=replayPgn(DAN_PGN);const p=Position.fromFEN(fenBeforePly(replay,17));const bad=p.moveFromUci('a1g7');assert.ok(bad);assert.ok(rootTacticalRisk(p,bad)>=240);assert.notEqual(moveToUci(engine().search(p,{maxDepth:5,moveTimeMs:450}).move),'a1g7');});
test('opening move economy prefers development over knight tourism',()=>{const p=Position.fromFEN('rnbqkbnr/pppppppp/8/8/4P3/5N2/PPPP1PPP/RNBQKB1R w KQkq - 1 2');const b=p.moveFromUci('f1c4'),n=p.moveFromUci('f3e5');assert.ok(b&&n);assert.ok(strategicMoveBonus(p,b)>=strategicMoveBonus(p,n)+30);});
test('premature queen adventures are discouraged',()=>{const p=Position.fromFEN('rnbqkbnr/pppppppp/8/8/4P3/2N5/PPPP1PPP/R1BQKBNR w KQkq - 1 2');const b=p.moveFromUci('f1c4'),q=p.moveFromUci('d1h5');assert.ok(b&&q);assert.ok(strategicMoveBonus(p,b)>=strategicMoveBonus(p,q)+30);});
test('castling receives opening readiness preference',()=>{const p=Position.fromFEN('rnbqkbnr/pppppppp/8/8/2B1P3/5N2/PPPP1PPP/RNBQK2R w KQkq - 2 3');const c=p.moveFromUci('e1g1'),h=p.moveFromUci('h2h3');assert.ok(c&&h);assert.ok(strategicMoveBonus(p,c)>=strategicMoveBonus(p,h)+25);});
test('quiet horizon recognizes pawn fork of two minors',()=>{const p=Position.fromFEN('6k1/8/8/8/4n1b1/8/5P2/6K1 w - - 0 1');const f=p.moveFromUci('f2f3');assert.ok(f);assert.ok(quietTacticalThreatRisk(p,f)>=500);});
test('endgame mode rewards king activity',()=>{const c=Position.fromFEN('7k/8/8/8/4K3/8/P7/8 w - - 0 1'),e=Position.fromFEN('7k/8/8/8/8/8/P7/K7 w - - 0 1');assert.ok(strategicEvaluation(c,'w')>=strategicEvaluation(e,'w')+20);});
test('endgame mode values a blockade',()=>{const b=Position.fromFEN('7k/8/8/8/8/1p6/1B6/6K1 w - - 0 1'),l=Position.fromFEN('7k/8/8/8/8/1p6/2B5/6K1 w - - 0 1');assert.ok(strategicEvaluation(b,'w')>strategicEvaluation(l,'w'));});
test('twofold cycling loses value when ahead',()=>{const p=Position.fromFEN('7k/8/8/8/4K3/8/P7/8 w - - 0 1');assert.ok(cycleUtility(p,180)<80);assert.ok(cycleUtility(p,-180)>-150);});

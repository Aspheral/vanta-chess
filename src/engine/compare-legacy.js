import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Position, moveToUci } from '../chess/position.js';
import { SearchEngine as CurrentSearch } from './search.js';

const legacyRoot=resolve(process.env.LEGACY_ROOT||'legacy');
const { SearchEngine: LegacySearch }=await import(pathToFileURL(resolve(legacyRoot,'src/engine/search.js')).href);

const CASES=[
  {id:'A-unsound-Nxh2',fen:'r2qkb1r/1bpppppp/1pn5/p2P4/2B1PBn1/2N2N2/PPP2PPP/R2QK2R b KQkq - 0 7'},
  {id:'B-dangerous-passer',fen:'r2qkb1r/3ppppp/np1P4/pN2P3/2p2B2/P4N2/1PP2PPR/R2QK3 b Qkq - 0 13'},
  {id:'C-promotion-recapture',fen:'r3kb1r/2P1p1pp/1p2p3/p7/3QnB2/P7/1pP2PPR/3RK3 b kq - 1 20'},
  {id:'D-quiet-mate-threat',fen:'r1r5/6pp/3bp2k/pp6/6Q1/P4R2/2P2PP1/4K3 b - - 7 32'},
];

function summarize(Search,fen,timeMs=350) {
  const p=Position.fromFEN(fen);
  const engine=new Search({maxDepth:5,moveTimeMs:timeMs,nodeLimit:180000,selectionWindow:55,evalNoise:12});
  const r=engine.search(p,{moveTimeMs:timeMs,maxDepth:5});
  return {
    move:r.move?moveToUci(r.move):null,
    score:r.score,
    objectiveScore:r.objectiveScore??r.score,
    depth:r.depth,
    nodes:r.nodes,
    qnodes:r.qnodes,
    nps:r.nps,
    timeMs:r.timeMs,
    pv:(r.pv||[]).map(moveToUci),
    candidates:(r.candidates||[]).slice(0,6),
    rootMateRejects:r.rootMateRejects??null,
    seeCalls:r.seeCalls??null,
  };
}

const report={generatedAt:new Date().toISOString(),legacyRoot,cases:[]};
for(const c of CASES) {
  const legacy=summarize(LegacySearch,c.fen,350);
  const current=summarize(CurrentSearch,c.fen,350);
  report.cases.push({...c,legacy,current});
  console.log(`\n=== ${c.id} ===`);
  console.log('legacy',JSON.stringify(legacy));
  console.log('current',JSON.stringify(current));
}
console.log('\nCOMPARISON_JSON');
console.log(JSON.stringify(report,null,2));

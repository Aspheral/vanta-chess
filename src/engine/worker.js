import { Position, moveToUci } from '../chess/position.js';
import { SearchEngine } from './search-production.js';

let activeSearchId=0;
let engine=new SearchEngine();

self.onmessage = event => {
  const msg=event.data;
  if(msg.type==='cancel') { activeSearchId++; engine.stop(); return; }
  if(msg.type==='configure') { engine=new SearchEngine(msg.config||{}); return; }
  if(msg.type==='search') {
    const id=msg.searchId;
    activeSearchId=id;
    engine=new SearchEngine(msg.config||{});
    try {
      const position=Position.fromFEN(msg.fen);
      const result=engine.search(position,msg.options||{});
      if(activeSearchId!==id) return;
      self.postMessage({type:'search-result',searchId:id,result:{...result,move:result.move?moveToUci(result.move):null,pv:result.pv.map(moveToUci)}});
    } catch(error) {
      self.postMessage({type:'error',searchId:id,error:error?.message||String(error)});
    }
    return;
  }
  if(msg.type==='ponder') {
    const id=msg.searchId;
    activeSearchId=id;
    engine=new SearchEngine(msg.config||{});
    try {
      const position=Position.fromFEN(msg.fen);
      const branches=engine.predictBranches(position,msg.count||4,msg.options||{});
      if(activeSearchId!==id) return;
      self.postMessage({type:'ponder-result',searchId:id,branches});
    } catch(error) {
      self.postMessage({type:'error',searchId:id,error:error?.message||String(error)});
    }
  }
};

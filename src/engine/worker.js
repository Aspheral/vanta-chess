import { Position, moveToUci } from '../chess/position.js';
import { StrongSearchEngine } from './strong-search.js';
import { adaptiveStrengthProfile } from './adaptive-strength.js';
import { searchWithPracticalSafety } from './practical-safety.js';

let activeSearchId=0;
let engine=new StrongSearchEngine();

function adaptiveRequest(position, config = {}, options = {}) {
  if (config.adaptiveStrength === false || options.adaptiveStrength === false) {
    return { config, options, profile: null };
  }

  const profile = adaptiveStrengthProfile(position, options);
  const effectiveConfig = {
    ...config,
    targetElo: profile.targetElo,
    maxDepth: profile.maxDepth,
    nodeLimit: profile.nodeLimit,
    selectionWindow: profile.selectionWindow,
    evalNoise: profile.evalNoise,
  };
  const effectiveOptions = {
    ...options,
    maxDepth: profile.maxDepth,
    moveTimeMs: profile.hardTimeMs,
    softTimeMs: profile.softTimeMs,
    hardTimeMs: profile.hardTimeMs,
  };

  // The adaptive policy has already used the real clock to preserve a reserve.
  // Passing remainingTimeMs again would cause SearchEngine to allocate time a
  // second time and erase the complexity-dependent budget.
  delete effectiveOptions.remainingTimeMs;
  delete effectiveOptions.incrementMs;

  return { config: effectiveConfig, options: effectiveOptions, profile };
}

function applyConfig(config={}) {
  engine.config={...engine.config,...config};
}

self.onmessage = event => {
  const msg=event.data;
  if(msg.type==='cancel') { activeSearchId++; engine.stop(); return; }
  if(msg.type==='configure') { engine=new StrongSearchEngine(msg.config||{}); return; }
  if(msg.type==='search') {
    const id=msg.searchId;
    activeSearchId=id;
    try {
      const position=Position.fromFEN(msg.fen);
      const request=adaptiveRequest(position,msg.config||{},msg.options||{});
      // Keep TT/history across moves. Recreating the engine every turn threw
      // away exactly the information iterative search had just learned.
      applyConfig(request.config);
      const result=searchWithPracticalSafety(engine,position,request.options);
      if(activeSearchId!==id) return;
      self.postMessage({
        type:'search-result',
        searchId:id,
        result:{
          ...result,
          move:result.move?moveToUci(result.move):null,
          pv:result.pv.map(moveToUci),
          adaptiveProfile:request.profile,
          targetElo:request.profile?.targetElo??request.config.targetElo??null,
        },
      });
    } catch(error) {
      self.postMessage({type:'error',searchId:id,error:error?.message||String(error)});
    }
    return;
  }
  if(msg.type==='ponder') {
    const id=msg.searchId;
    activeSearchId=id;
    try {
      const position=Position.fromFEN(msg.fen);
      applyConfig(msg.config||{});
      // Pondering intentionally stays bounded. TT/history produced here are
      // retained, so a real ponder hit can make the subsequent move deeper.
      const branches=engine.predictBranches(position,msg.count||4,msg.options||{});
      if(activeSearchId!==id) return;
      self.postMessage({type:'ponder-result',searchId:id,branches});
    } catch(error) {
      self.postMessage({type:'error',searchId:id,error:error?.message||String(error)});
    }
  }
};

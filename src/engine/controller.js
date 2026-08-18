import { strengthConfig } from './personality.js';

export class EngineController extends EventTarget {
  constructor(workerUrl, config={}) {
    super();
    this.workerUrl=workerUrl;
    this.config={...strengthConfig(1500),...config};
    this.searchId=0;
    this.worker=null;
    this.ponderCache=new Map();
    this.ponderFen=null;
    this.busy=false;
    this.ponderHits=0;
    this.ponderMisses=0;
    this.restartWorker();
  }

  restartWorker() {
    if(this.worker) this.worker.terminate();
    this.worker=new Worker(this.workerUrl,{type:'module'});
    this.worker.onmessage=e=>this.onMessage(e.data);
  }

  onMessage(msg) {
    if(msg.searchId!==this.searchId) return;
    this.busy=false;
    if(msg.type==='search-result') this.dispatchEvent(new CustomEvent('search-result',{detail:msg.result}));
    else if(msg.type==='ponder-result') {
      this.ponderCache.clear();
      for(const b of msg.branches) this.ponderCache.set(b.opponentMove,b);
      this.dispatchEvent(new CustomEvent('ponder-result',{detail:msg.branches}));
    } else if(msg.type==='error') this.dispatchEvent(new CustomEvent('engine-error',{detail:msg.error}));
  }

  cancel() {
    this.searchId++;
    this.restartWorker();
    this.busy=false;
    this.ponderCache.clear(); this.ponderFen=null;
  }

  search(fen,options={}) {
    if(this.busy) this.restartWorker();
    this.searchId++;
    this.busy=true;
    this.ponderCache.clear(); this.ponderFen=null;
    this.worker.postMessage({type:'search',searchId:this.searchId,fen,config:this.config,options});
    return this.searchId;
  }

  ponder(fen,count=4,options={}) {
    if(this.busy) this.restartWorker();
    this.searchId++;
    this.busy=true;
    this.ponderFen=fen;
    this.ponderCache.clear();
    this.worker.postMessage({type:'ponder',searchId:this.searchId,fen,count,config:this.config,options});
    return this.searchId;
  }

  refinePonder(fen,count=4,options={}) {
    if(this.ponderFen!==fen) return this.ponder(fen,count,options);
    if(this.busy) return null;
    this.searchId++;
    this.busy=true;
    // Keep the last completed branch cache live while the worker refines it.
    this.worker.postMessage({type:'ponder',searchId:this.searchId,fen,count,config:this.config,options});
    return this.searchId;
  }

  consumePonder(opponentUci,currentFen) {
    if(this.ponderFen!==currentFen) return null;
    const branch=this.ponderCache.get(opponentUci)||null;
    if(branch) this.ponderHits++; else this.ponderMisses++;
    this.ponderCache.clear(); this.ponderFen=null;
    return branch;
  }

  getPonderStats() { return {hits:this.ponderHits,misses:this.ponderMisses}; }

  setConfig(config) { this.config={...this.config,...config}; this.cancel(); }
  destroy() { if(this.worker) this.worker.terminate(); }
}

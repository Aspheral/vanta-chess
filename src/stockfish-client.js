export const STOCKFISH_VERSION='10.0.2';
export const STOCKFISH_LABEL='Stockfish 10';
export const STOCKFISH_CDN=`https://cdn.jsdelivr.net/npm/stockfish.js@${STOCKFISH_VERSION}`;

function linesFrom(data){
  const text=typeof data==='string'?data:String(data?.data??'');
  return text.split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
}

function parseInfo(line){
  if(!line.startsWith('info '))return null;
  const out={depth:0,nodes:0,nps:0,score:null,mate:null,pv:[]};
  const parts=line.split(/\s+/);
  for(let i=1;i<parts.length;i++){
    const key=parts[i];
    if(key==='depth')out.depth=Number(parts[++i])||out.depth;
    else if(key==='nodes')out.nodes=Number(parts[++i])||out.nodes;
    else if(key==='nps')out.nps=Number(parts[++i])||out.nps;
    else if(key==='score'){
      const type=parts[++i],value=Number(parts[++i]);
      if(type==='cp')out.score=Number.isFinite(value)?value:null;
      if(type==='mate')out.mate=Number.isFinite(value)?value:null;
    }else if(key==='pv'){
      out.pv=parts.slice(i+1);
      break;
    }
  }
  return out;
}

function makeWorkerSource(jsUrl,wasmUrl=null){
  const locate=wasmUrl
    ? `self.Module={locateFile:function(path){return path.endsWith('.wasm')?'${wasmUrl}':path;}};`
    : '';
  return `${locate}\nimportScripts('${jsUrl}');`;
}

async function spawnCandidate(jsName,wasmName=null,timeoutMs=18000){
  const jsUrl=`${STOCKFISH_CDN}/${jsName}`;
  const wasmUrl=wasmName?`${STOCKFISH_CDN}/${wasmName}`:null;
  const source=makeWorkerSource(jsUrl,wasmUrl);
  const blob=new Blob([source],{type:'text/javascript'});
  const blobUrl=URL.createObjectURL(blob);
  const worker=new Worker(blobUrl);
  let settled=false;
  try{
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Stockfish startup timed out')),timeoutMs);
      const onMessage=e=>{
        for(const line of linesFrom(e.data)){
          if(line==='uciok'){
            settled=true;
            clearTimeout(timeout);
            worker.removeEventListener('message',onMessage);
            resolve();
            return;
          }
        }
      };
      worker.addEventListener('message',onMessage);
      worker.addEventListener('error',e=>{
        if(settled)return;
        clearTimeout(timeout);
        reject(new Error(e.message||'Stockfish worker failed'));
      },{once:true});
      worker.postMessage('uci');
    });
    return {worker,blobUrl};
  }catch(error){
    worker.terminate();
    URL.revokeObjectURL(blobUrl);
    throw error;
  }
}

export class StockfishClient extends EventTarget{
  constructor(){
    super();
    this.worker=null;
    this.blobUrl=null;
    this.ready=false;
    this.searchToken=0;
    this.lastInfo={depth:0,nodes:0,nps:0,score:null,mate:null,pv:[]};
    this.flavor='';
  }

  async init(){
    if(this.ready)return;
    // stockfish.js 10.0.2 is intentionally used here because its WebWorker
    // build is single-threaded and works on plain static hosts without the
    // COOP/COEP headers required by modern pthread Stockfish builds.
    const candidates=[
      ['stockfish.wasm.js','stockfish.wasm','Stockfish 10 WASM'],
      ['stockfish.js',null,'Stockfish 10 JavaScript fallback'],
    ];
    let lastError=null;
    for(const [js,wasm,label] of candidates){
      try{
        const instance=await spawnCandidate(js,wasm);
        this.worker=instance.worker;
        this.blobUrl=instance.blobUrl;
        this.flavor=label;
        this.worker.onmessage=e=>this.handleMessage(e.data);
        this.worker.postMessage('setoption name Hash value 32');
        this.worker.postMessage('ucinewgame');
        await this.waitForReady();
        this.ready=true;
        this.dispatchEvent(new CustomEvent('ready',{detail:{flavor:this.flavor}}));
        return;
      }catch(error){lastError=error;}
    }
    throw lastError||new Error('Unable to load Stockfish');
  }

  waitForReady(timeoutMs=8000){
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('Stockfish isready timed out')),timeoutMs);
      const listener=e=>{
        if(linesFrom(e.data).includes('readyok')){
          clearTimeout(timeout);
          this.worker.removeEventListener('message',listener);
          resolve();
        }
      };
      this.worker.addEventListener('message',listener);
      this.worker.postMessage('isready');
    });
  }

  handleMessage(data){
    for(const line of linesFrom(data)){
      const info=parseInfo(line);
      if(info){
        this.lastInfo={...this.lastInfo,...info,pv:info.pv.length?info.pv:this.lastInfo.pv};
        this.dispatchEvent(new CustomEvent('info',{detail:this.lastInfo}));
      }
    }
  }

  async search(fen,{moveTimeMs=2200}={}){
    await this.init();
    const token=++this.searchToken;
    this.lastInfo={depth:0,nodes:0,nps:0,score:null,mate:null,pv:[]};
    return new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>{
        this.worker?.postMessage('stop');
        cleanup();
        reject(new Error('Stockfish search timed out'));
      },Math.max(10000,moveTimeMs+12000));
      const cleanup=()=>{
        clearTimeout(timeout);
        this.worker?.removeEventListener('message',listener);
      };
      const listener=e=>{
        if(token!==this.searchToken)return;
        for(const line of linesFrom(e.data)){
          const info=parseInfo(line);
          if(info){
            this.lastInfo={...this.lastInfo,...info,pv:info.pv.length?info.pv:this.lastInfo.pv};
            this.dispatchEvent(new CustomEvent('info',{detail:this.lastInfo}));
          }
          if(line.startsWith('bestmove ')){
            const move=line.split(/\s+/)[1];
            cleanup();
            resolve({move,info:this.lastInfo,flavor:this.flavor});
            return;
          }
        }
      };
      this.worker.addEventListener('message',listener);
      this.worker.postMessage(`position fen ${fen}`);
      this.worker.postMessage(`go movetime ${Math.max(250,Math.round(moveTimeMs))}`);
    });
  }

  stop(){
    this.searchToken++;
    this.worker?.postMessage('stop');
  }

  destroy(){
    this.stop();
    this.worker?.terminate();
    this.worker=null;
    if(this.blobUrl)URL.revokeObjectURL(this.blobUrl);
    this.blobUrl=null;
    this.ready=false;
  }
}

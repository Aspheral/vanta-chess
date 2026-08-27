import {ChessGame} from './chess/game.js';
import {WHITE,BLACK} from './chess/constants.js';
import {BoardView} from './ui/board.js';
import {EngineController} from './engine/controller.js';
import {StockfishClient,STOCKFISH_VERSION,STOCKFISH_LABEL} from './stockfish-client.js';

const ULTRA_CONFIG=Object.freeze({
  targetElo:3000,
  adaptiveStrength:false,
  maxDepth:12,
  moveTimeMs:10000,
  nodeLimit:4500000,
  selectionWindow:0,
  evalNoise:0,
});

const ULTRA_OPTIONS=Object.freeze({
  adaptiveStrength:false,
  moveTimeMs:10000,
  softTimeMs:6500,
  hardTimeMs:10000,
  maxDepth:12,
});

const OPENINGS=Object.freeze([
  {name:'Ruy Lopez',eco:'C84',moves:['e2e4','e7e5','g1f3','b8c6','f1b5','a7a6','b5a4','g8f6','e1g1','f8e7']},
  {name:'Italian Game',eco:'C50',moves:['e2e4','e7e5','g1f3','b8c6','f1c4','g8f6','d2d3','f8c5']},
  {name:'Sicilian Najdorf',eco:'B90',moves:['e2e4','c7c5','g1f3','d7d6','d2d4','c5d4','f3d4','g8f6','b1c3','a7a6']},
  {name:"Queen's Gambit Declined",eco:'D30',moves:['d2d4','d7d5','c2c4','e7e6','b1c3','g8f6','c1g5','f8e7']},
  {name:"King's Indian Defense",eco:'E60',moves:['d2d4','g8f6','c2c4','g7g6','b1c3','f8g7','e2e4','d7d6']},
  {name:'English Opening',eco:'A28',moves:['c2c4','e7e5','b1c3','g8f6','g2g3','d7d5','c4d5','f6d5']},
  {name:'Caro-Kann Classical',eco:'B18',moves:['e2e4','c7c6','d2d4','d7d5','b1c3','d5e4','c3e4','c8f5']},
  {name:'Catalan Opening',eco:'E06',moves:['d2d4','g8f6','c2c4','e7e6','g2g3','d7d5','f1g2','f8e7']},
]);

const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const fmt=n=>n>=1e6?`${(n/1e6).toFixed(1)}m`:n>=1e3?`${(n/1e3).toFixed(1)}k`:String(n||0);

class UltraSpectate{
  constructor(root){
    this.root=root;
    this.game=new ChessGame();
    this.vantaColor=Math.random()<.5?WHITE:BLACK;
    this.stockfishColor=this.vantaColor===WHITE?BLACK:WHITE;
    this.opening=null;
    this.paused=false;
    this.ended=false;
    this.generation=0;
    this.currentArrow=null;
    this.thinkingSide=null;
    this.vantaInfo=null;
    this.stockfishInfo=null;
    this.status='Preparing the arena…';
    this.vanta=new EngineController(new URL('./engine/worker.js',import.meta.url),ULTRA_CONFIG);
    this.stockfish=new StockfishClient();
    this.renderShell();
    this.board=new BoardView(this.root.querySelector('#spectateBoard'));
    this.bind();
    this.newMatch();
  }

  renderShell(){
    this.root.innerHTML=`<div class="spectate-app">
      <header class="spectate-topbar">
        <button class="spectate-back" id="spectateBack" aria-label="Exit spectate">‹</button>
        <div class="spectate-brand"><span class="spectate-live-dot"></span><div><b>Vanta Arena</b><span>ULTRA exhibition</span></div></div>
        <button class="btn primary" id="newSpectate">New match</button>
      </header>
      <main class="spectate-layout">
        <section class="spectate-game">
          <div class="fighter-row">
            <article class="fighter-card vanta-card" id="vantaCard"><div class="fighter-icon">V</div><div><span class="fighter-name">FULL MAX ULTRA Vanta</span><span class="fighter-sub">~3000 target · maximum search</span></div><b class="fighter-color" id="vantaColor"></b></article>
            <div class="versus">VS</div>
            <article class="fighter-card stockfish-card" id="stockfishCard"><div class="fighter-icon fish">SF</div><div><span class="fighter-name">${STOCKFISH_LABEL}</span><span class="fighter-sub">portable browser UCI · full skill</span></div><b class="fighter-color" id="stockfishColor"></b></article>
          </div>
          <div class="opening-banner"><span>OPENING</span><b id="openingName">Random popular opening</b><em id="openingEco"></em></div>
          <div class="board-wrap spectate-board" id="spectateBoard"></div>
          <div class="spectate-underboard"><div><span class="spectate-pulse"></span><b id="spectateStatus">Preparing…</b></div><div class="spectate-controls"><button class="icon-btn" id="spectateFlip" title="Flip board">⇅</button><button class="btn" id="spectatePause">Pause</button></div></div>
        </section>
        <aside class="spectate-rail">
          <section class="panel broadcast-card"><div class="panel-head"><span class="panel-title">Live broadcast</span><span class="panel-sub">engine vs engine</span></div>
            <div class="broadcast-body"><div class="broadcast-turn"><span id="turnEngine">—</span><b id="turnState">waiting</b></div><div class="eval-big" id="liveEval">—</div><div class="broadcast-pv" id="livePv">Waiting for calculation…</div>
              <div class="ultra-metrics"><div><span>Depth</span><b id="liveDepth">0</b></div><div><span>Nodes</span><b id="liveNodes">0</b></div><div><span>NPS</span><b id="liveNps">0</b></div><div><span>Think</span><b id="liveTime">0s</b></div></div>
            </div>
          </section>
          <section class="panel"><div class="panel-head"><span class="panel-title">Grandmaster feed</span><span class="panel-sub" id="plyCount">0 plies</span></div><div class="spectate-history" id="spectateHistory"></div></section>
          <section class="panel arena-note"><b>FULL MAX ULTRA</b><p>Vanta uses its maximum exhibition profile on every move: zero evaluation noise, zero personality tolerance, up to depth 12, 4.5M nodes and a 10-second hard think budget.</p><small>“~3000” is a target strength mode, not a certified rating. The opponent is the pinned ${STOCKFISH_LABEL} (${STOCKFISH_VERSION}) single-thread browser build, chosen because it works on plain static hosts and remains vastly stronger than ordinary human play.</small></section>
        </aside>
      </main>
    </div>`;
  }

  bind(){
    this.root.querySelector('#spectateBack').onclick=()=>{
      this.destroy();
      const url=new URL(location.href);url.searchParams.delete('spectate');location.href=url.href;
    };
    this.root.querySelector('#newSpectate').onclick=()=>this.newMatch();
    this.root.querySelector('#spectatePause').onclick=()=>this.togglePause();
    this.root.querySelector('#spectateFlip').onclick=()=>{this.orientation=this.orientation===WHITE?BLACK:WHITE;this.renderBoard();};
    this.stockfish.addEventListener('info',e=>{
      if(this.thinkingSide!=='stockfish')return;
      this.stockfishInfo=e.detail;
      this.renderLiveInfo();
    });
  }

  async newMatch(){
    const generation=++this.generation;
    this.vanta.cancel();this.stockfish.stop();
    this.game.reset();this.ended=false;this.paused=false;this.currentArrow=null;
    this.vantaInfo=null;this.stockfishInfo=null;
    this.vantaColor=Math.random()<.5?WHITE:BLACK;this.stockfishColor=this.vantaColor===WHITE?BLACK:WHITE;
    this.orientation=this.vantaColor;
    this.opening=OPENINGS[Math.floor(Math.random()*OPENINGS.length)];
    for(const uci of this.opening.moves){
      try{this.game.playUci(uci);}catch{break;}
    }
    this.status=`${this.opening.name} loaded. Engines entering calculation.`;
    this.updateStaticUi();this.renderBoard();this.renderHistory();this.renderLiveInfo();
    try{
      this.status=`Loading ${STOCKFISH_LABEL}…`;this.updateStatus();
      await this.stockfish.init();
      if(generation!==this.generation)return;
      this.status=`${this.opening.name} · live`;
      this.updateStatus();
      await delay(500);
      this.runTurn(generation);
    }catch(error){
      if(generation!==this.generation)return;
      this.status=`Stockfish could not load: ${error.message}`;
      this.updateStatus();
    }
  }

  togglePause(){
    this.paused=!this.paused;
    this.root.querySelector('#spectatePause').textContent=this.paused?'Resume':'Pause';
    if(this.paused){
      this.vanta.cancel();this.stockfish.stop();this.status='Match paused';this.updateStatus();
    }else{
      this.status='Match resumed';this.updateStatus();
      this.runTurn(this.generation);
    }
  }

  async runTurn(generation){
    if(generation!==this.generation||this.paused||this.ended)return;
    const state=this.game.status();
    if(state.over){this.finish(state);return;}
    const isVanta=this.game.position.turn===this.vantaColor;
    this.thinkingSide=isVanta?'vanta':'stockfish';
    this.currentArrow=null;
    this.status=isVanta?'FULL MAX ULTRA Vanta is calculating…':'Stockfish is calculating…';
    this.updateStatus();this.renderLiveInfo();this.highlightFighter();
    try{
      const fen=this.game.position.toFEN();
      const started=performance.now();
      let moveUci;
      if(isVanta){
        const result=await this.searchVanta(fen,generation);
        if(!result)return;
        this.vantaInfo=result;
        moveUci=result.move;
      }else{
        const result=await this.stockfish.search(fen,{moveTimeMs:2200});
        if(generation!==this.generation||this.paused)return;
        this.stockfishInfo={...result.info,timeMs:Math.round(performance.now()-started)};
        moveUci=result.move;
      }
      if(generation!==this.generation||this.paused||!moveUci)return;
      const move=this.game.position.moveFromUci(moveUci);
      if(!move)throw new Error(`Engine returned illegal move ${moveUci}`);
      this.currentArrow=moveUci;
      this.status=`${isVanta?'Vanta':'Stockfish'} found ${moveUci}`;
      this.renderBoard();this.renderLiveInfo();this.updateStatus();
      await delay(650);
      if(generation!==this.generation||this.paused)return;
      this.currentArrow=null;
      this.game.play(move);
      this.renderBoard();this.renderHistory();this.updateStaticUi();
      const after=this.game.status();
      if(after.over){this.finish(after);return;}
      await delay(520);
      this.runTurn(generation);
    }catch(error){
      if(generation!==this.generation)return;
      this.status=`Arena error: ${error.message}`;
      this.updateStatus();
    }
  }

  searchVanta(fen,generation){
    return new Promise((resolve,reject)=>{
      const onResult=e=>{cleanup();if(generation===this.generation&&!this.paused)resolve(e.detail);else resolve(null);};
      const onError=e=>{cleanup();reject(new Error(e.detail));};
      const cleanup=()=>{this.vanta.removeEventListener('search-result',onResult);this.vanta.removeEventListener('engine-error',onError);};
      this.vanta.addEventListener('search-result',onResult,{once:true});
      this.vanta.addEventListener('engine-error',onError,{once:true});
      this.vanta.search(fen,ULTRA_OPTIONS);
    });
  }

  renderBoard(){
    const snap=this.game.snapshot();
    this.board.render(this.game.position,{orientation:this.orientation||WHITE,interactive:false,lastMove:snap.lastMove,analysisArrow:this.currentArrow,predictionArrows:false,branches:[],animateMoves:true,sounds:true,checkSquare:this.game.position.isInCheck(this.game.position.turn)?this.game.position.kingSquare(this.game.position.turn):null});
  }

  renderHistory(){
    const rows=this.game.moveRows();
    const el=this.root.querySelector('#spectateHistory');
    el.innerHTML=rows.length?rows.map(r=>`<div class="spectate-move"><span>${r.move}.</span><b>${r.white||'…'}</b><b>${r.black||''}</b></div>`).join(''):'<div class="empty">Opening moves will appear here.</div>';
    el.scrollTop=el.scrollHeight;
    this.root.querySelector('#plyCount').textContent=`${this.game.cursor} plies`;
  }

  updateStaticUi(){
    this.root.querySelector('#openingName').textContent=this.opening?.name||'Random opening';
    this.root.querySelector('#openingEco').textContent=this.opening?.eco||'';
    this.root.querySelector('#vantaColor').textContent=this.vantaColor===WHITE?'WHITE':'BLACK';
    this.root.querySelector('#stockfishColor').textContent=this.stockfishColor===WHITE?'WHITE':'BLACK';
    this.root.querySelector('#vantaColor').className=`fighter-color ${this.vantaColor===WHITE?'white':'black'}`;
    this.root.querySelector('#stockfishColor').className=`fighter-color ${this.stockfishColor===WHITE?'white':'black'}`;
    this.root.querySelector('#spectatePause').textContent=this.paused?'Resume':'Pause';
  }

  updateStatus(){this.root.querySelector('#spectateStatus').textContent=this.status;}

  highlightFighter(){
    this.root.querySelector('#vantaCard').classList.toggle('thinking',this.thinkingSide==='vanta');
    this.root.querySelector('#stockfishCard').classList.toggle('thinking',this.thinkingSide==='stockfish');
  }

  renderLiveInfo(){
    const vanta=this.thinkingSide==='vanta';
    const info=vanta?this.vantaInfo:this.stockfishInfo;
    this.root.querySelector('#turnEngine').textContent=vanta?'FULL MAX ULTRA Vanta':STOCKFISH_LABEL;
    this.root.querySelector('#turnState').textContent=this.paused?'paused':'THINKING';
    let score='—';
    if(info?.mate!=null)score=`M${info.mate}`;
    else if(info?.objectiveScore!=null)score=`${info.objectiveScore>=0?'+':''}${(info.objectiveScore/100).toFixed(2)}`;
    else if(info?.score!=null)score=`${info.score>=0?'+':''}${(info.score/100).toFixed(2)}`;
    this.root.querySelector('#liveEval').textContent=score;
    const pv=info?.pv||[];
    this.root.querySelector('#livePv').textContent=pv.length?pv.slice(0,10).join(' '):(this.thinkingSide?'Calculating principal variation…':'Waiting for calculation…');
    this.root.querySelector('#liveDepth').textContent=info?.depth??0;
    this.root.querySelector('#liveNodes').textContent=fmt(info?.nodes??0);
    this.root.querySelector('#liveNps').textContent=fmt(info?.nps??0);
    const ms=info?.timeMs??0;
    this.root.querySelector('#liveTime').textContent=ms?`${(ms/1000).toFixed(1)}s`:'—';
  }

  finish(state){
    this.ended=true;this.thinkingSide=null;this.highlightFighter();
    const label=state.result==='1-0'?'White wins':state.result==='0-1'?'Black wins':'Draw';
    this.status=`${label} · ${state.reason}`;this.updateStatus();
    this.root.querySelector('#turnEngine').textContent='GAME OVER';
    this.root.querySelector('#turnState').textContent=state.result;
  }

  destroy(){
    this.generation++;this.vanta.destroy();this.stockfish.destroy();
  }
}

new UltraSpectate(document.querySelector('#app'));

import { ChessGame } from './chess/game.js';
import { moveToSAN } from './chess/san.js';
import { Position } from './chess/position.js';
import { WHITE, BLACK, colorOf, indexToSquare, squareToIndex } from './chess/constants.js';
import { EngineController } from './engine/controller.js';
import { repetitionExclusions, shouldRejectRepetitionMove } from './engine/draw-policy.js';
import { BoardView } from './ui/board.js';
import { BRANCH_COLORS } from './ui/arrows.js';

const STATES=Object.freeze({IDLE:'IDLE',PLAYER_TURN:'PLAYER_TURN',ENGINE_SEARCHING:'ENGINE_SEARCHING',PONDERING:'PONDERING',POSITION_EDITING:'POSITION_EDITING',ANALYSIS:'ANALYSIS',GAME_OVER:'GAME_OVER'});
const GLYPHS={K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};

class VantaApp {
  constructor(root){
    this.root=root;
    this.game=new ChessGame();
    this.playerColor=WHITE;
    this.orientation=WHITE;
    this.manualFlip=false;
    this.mode='play';
    this.state=STATES.PLAYER_TURN;
    this.predictionArrows=true;
    this.debug=false;
    this.branches=[];
    this.highlightBranch=null;
    this.analysisArrow=null;
    this.engineInfo=null;
    this.pendingPurpose=null;
    this.pendingFen=null;
    this.editorTool='P';
    this.editorPosition=this.game.position.clone();
    this.editorWarning='';
    this.controller=new EngineController(new URL('./engine/worker.js',import.meta.url));
    this.controller.addEventListener('search-result',e=>this.onSearchResult(e.detail));
    this.controller.addEventListener('ponder-result',e=>this.onPonderResult(e.detail));
    this.controller.addEventListener('engine-error',e=>{this.state=STATES.IDLE;this.setBanner(`Engine error: ${e.detail}`);this.render();});
    this.renderSkeleton();
    this.board=new BoardView(this.boardRoot,{onMoveRequest:(f,t,m)=>this.onMoveRequest(f,t,m),onEditorSquare:i=>this.onEditorSquare(i)});
    this.render();
  }

  renderSkeleton(){
    this.root.innerHTML=`<div class="app">
      <header class="topbar"><div class="brand"><span class="mark"></span><span>Vanta Chess</span><span class="mode-pill" id="modePill">PLAY</span></div>
      <div class="top-actions"><button class="btn hide-mobile" id="analysisBtn">Analysis</button><button class="btn primary" id="newBtn">New game</button></div></header>
      <main class="workspace"><section class="left-col"><div class="board-wrap" id="board"></div><div class="board-footer"><div class="turn-label" id="turnLabel"></div><div class="compact-actions"><button class="icon-btn" id="undoBtn" title="Back move">↶</button><button class="icon-btn" id="redoBtn" title="Forward move">↷</button><button class="icon-btn" id="flipBtn" title="Flip board">⇅</button></div></div></section><aside class="side" id="side"></aside></main>
      <div class="toast" id="toast" aria-live="polite"></div><div id="modal"></div></div>`;
    this.boardRoot=this.root.querySelector('#board');
    this.sideRoot=this.root.querySelector('#side');
    this.root.querySelector('#newBtn').onclick=()=>this.newGame(this.playerColor);
    this.root.querySelector('#analysisBtn').onclick=()=>this.toggleAnalysis();
    this.root.querySelector('#undoBtn').onclick=()=>this.undo();
    this.root.querySelector('#redoBtn').onclick=()=>this.redo();
    this.root.querySelector('#flipBtn').onclick=()=>{this.manualFlip=!this.manualFlip;this.render();};
  }

  effectiveOrientation(){
    const natural=this.playerColor;
    return this.manualFlip?(natural===WHITE?BLACK:WHITE):natural;
  }

  newGame(color=WHITE){
    this.controller.cancel();
    this.game.reset(); this.playerColor=color; this.orientation=color; this.manualFlip=false; this.mode='play';
    this.branches=[];this.analysisArrow=null;this.engineInfo=null;this.highlightBranch=null;
    this.state=this.game.position.turn===this.playerColor?STATES.PLAYER_TURN:STATES.ENGINE_SEARCHING;
    this.render();
    if(this.game.position.turn!==this.playerColor) this.startEngineMove();
  }

  setBanner(text){
    this.banner=text;
    clearTimeout(this.bannerTimer);
    this.updateToast();
    this.bannerTimer=setTimeout(()=>{this.banner='';this.updateToast();},2600);
  }

  updateToast(){
    const el=this.root.querySelector('#toast');
    if(!el)return;
    el.textContent=this.banner||'';
    el.classList.toggle('show',Boolean(this.banner));
  }

  toggleAnalysis(){
    this.controller.cancel(); this.branches=[]; this.analysisArrow=null; this.highlightBranch=null;
    if(this.mode==='analysis') {
      this.mode='play';
      const status=this.game.status();
      if(status.over) this.state=STATES.GAME_OVER;
      else if(this.game.position.turn===this.playerColor) this.state=STATES.PLAYER_TURN;
      else {this.state=STATES.ENGINE_SEARCHING; this.startEngineMove(); return;}
    } else {
      this.mode='analysis'; this.state=STATES.ANALYSIS; this.startAnalysis();
    }
    this.render();
  }

  enterEditor(){
    this.controller.cancel(); this.mode='editing'; this.state=STATES.POSITION_EDITING; this.editorPosition=this.game.position.clone(); this.editorWarning=''; this.branches=[];this.analysisArrow=null;this.render();
  }

  startFromEditor(){
    const errors=this.editorPosition.validate();
    if(errors.length){this.editorWarning=errors.join(' ');this.render();return;}
    this.game.reset(this.editorPosition.toFEN()); this.mode='play'; this.state=this.game.position.turn===this.playerColor?STATES.PLAYER_TURN:STATES.ENGINE_SEARCHING; this.editorWarning='';this.render();
    if(this.game.position.turn!==this.playerColor) this.startEngineMove();
  }

  onEditorSquare(index){
    const board=[...this.editorPosition.board];
    board[index]=this.editorTool==='erase'?null:this.editorTool;
    this.editorPosition=new Position({board,turn:this.editorPosition.turn,castling:this.editorPosition.castling,epSquare:this.editorPosition.epSquare,halfmove:this.editorPosition.halfmove,fullmove:this.editorPosition.fullmove});
    this.render();
  }

  setEditorMeta(){
    const side=this.sideRoot.querySelector('#editorTurn')?.value||'w';
    const rights=['K','Q','k','q'].filter(x=>this.sideRoot.querySelector(`#castle_${x}`)?.checked).join('');
    const epRaw=this.sideRoot.querySelector('#editorEp')?.value.trim()||'-';
    const ep=epRaw==='-'?null:squareToIndex(epRaw);
    if(epRaw!=='-'&&ep==null){this.editorWarning='En-passant square must be like e3 or d6.';this.render();return;}
    this.editorPosition=new Position({board:this.editorPosition.board,turn:side,castling:rights,epSquare:ep,halfmove:0,fullmove:1});
    this.editorWarning='';this.render();
  }

  loadFen(raw,intoEditor=false){
    try{
      const p=Position.fromFEN(raw.trim());
      if(intoEditor){this.editorPosition=p;this.editorWarning='';this.render();}
      else {this.controller.cancel();this.game.reset(p.toFEN());this.branches=[];this.analysisArrow=null;this.state=this.mode==='analysis'?STATES.ANALYSIS:(p.turn===this.playerColor?STATES.PLAYER_TURN:STATES.ENGINE_SEARCHING);this.render(); if(this.mode==='analysis')this.startAnalysis();else if(p.turn!==this.playerColor)this.startEngineMove();}
    }catch(err){this.editorWarning=err.message;this.render();}
  }

  async copyFen(){
    const fen=(this.mode==='editing'?this.editorPosition:this.game.position).toFEN();
    let copied=false;
    try{
      await navigator.clipboard.writeText(fen);
      copied=true;
    }catch{
      const textarea=document.createElement('textarea');
      textarea.value=fen;
      textarea.setAttribute('readonly','');
      textarea.style.position='fixed';
      textarea.style.opacity='0';
      document.body.appendChild(textarea);
      textarea.select();
      copied=document.execCommand('copy');
      textarea.remove();
    }
    this.setBanner(copied?'FEN copied.':`Copy this FEN: ${fen}`);
    this.render();
  }

  onMoveRequest(from,to,legal){
    if(this.mode==='editing')return;
    const position=this.game.position;
    const canMove=this.mode==='analysis'||(this.mode==='play'&&(this.state===STATES.PLAYER_TURN||this.state===STATES.PONDERING)&&position.turn===this.playerColor);
    if(!canMove)return;
    if(legal.length>1&&legal.some(m=>m.promotion)) {this.showPromotion(legal);return;}
    this.commitHumanMove(legal[0]);
  }

  showPromotion(moves){
    const modal=this.root.querySelector('#modal');
    const color=this.game.position.turn;
    modal.innerHTML=`<div class="promotion-modal"><div class="promotion-box">${['q','r','b','n'].map(t=>`<button data-p="${t}">${GLYPHS[color===WHITE?t.toUpperCase():t]}</button>`).join('')}</div></div>`;
    modal.querySelectorAll('button').forEach(b=>b.onclick=()=>{const m=moves.find(x=>x.promotion===b.dataset.p);modal.innerHTML='';this.commitHumanMove(m);});
  }

  commitHumanMove(move){
    const preFen=this.game.position.toFEN();
    const uci=`${indexToSquare(move.from)}${indexToSquare(move.to)}${move.promotion||''}`;
    const ponderHit=this.mode==='play'?this.controller.consumePonder(uci,preFen):null;
    this.controller.cancel();
    this.game.play(move); this.branches=[]; this.highlightBranch=null; this.analysisArrow=null;
    const status=this.game.status();
    if(status.over){this.state=STATES.GAME_OVER;this.render();return;}
    if(this.mode==='analysis'){this.state=STATES.ANALYSIS;this.render();this.startAnalysis();return;}
    this.state=STATES.ENGINE_SEARCHING; this.render();
    if(ponderHit){
      const planned=this.game.position.moveFromUci(ponderHit.engineMove);
      if(planned){
        this.engineInfo={score:ponderHit.evaluation,objectiveScore:ponderHit.evaluation,depth:ponderHit.depth,nodes:0,qnodes:0,ttHits:0,timeMs:0,nps:0,pv:ponderHit.continuation.slice(1),ponderHit:true,candidates:[]};
        queueMicrotask(()=>this.applyEngineMove(planned,true)); return;
      }
    }
    this.startEngineMove();
  }

  startEngineMove(knownScore=0){
    if(this.game.status().over)return;
    const fen=this.game.position.toFEN();
    const excludeMoves=repetitionExclusions(this.game,knownScore);
    this.pendingPurpose='play';this.pendingFen=fen;this.state=STATES.ENGINE_SEARCHING;this.analysisArrow=null;this.render();
    this.controller.search(fen,{moveTimeMs:650,maxDepth:6,excludeMoves});
  }

  startAnalysis(){
    const fen=this.game.position.toFEN();this.pendingPurpose='analysis';this.pendingFen=fen;this.state=STATES.ANALYSIS;this.render();
    this.controller.search(fen,{moveTimeMs:450,maxDepth:6});
  }

  onSearchResult(result){
    if(this.pendingFen!==this.game.position.toFEN())return;
    this.engineInfo=result;
    if(this.pendingPurpose==='analysis'){
      this.analysisArrow=result.move;this.state=STATES.ANALYSIS;this.render();return;
    }
    if(this.pendingPurpose==='play'&&result.move){
      const m=this.game.position.moveFromUci(result.move);
      const objective=result.objectiveScore??result.score??0;
      if(m&&shouldRejectRepetitionMove(this.game,m,objective)){
        this.setBanner('Vanta refuses a repetition draw while ahead.');
        this.startEngineMove(objective);
        return;
      }
      if(m)this.applyEngineMove(m,false);
    }
  }

  applyEngineMove(move,ponderHit=false){
    if(this.game.position.turn===this.playerColor&&this.mode==='play')return;
    const objective=this.engineInfo?.objectiveScore??this.engineInfo?.score??0;
    if(this.mode==='play'&&shouldRejectRepetitionMove(this.game,move,objective)){
      this.setBanner('Vanta refuses a repetition draw while ahead.');
      this.startEngineMove(objective);
      return;
    }
    this.game.play(move);this.analysisArrow=null;
    const status=this.game.status();
    if(status.over){this.state=STATES.GAME_OVER;this.render();return;}
    this.state=STATES.PONDERING;this.render();
    const fen=this.game.position.toFEN();
    this.controller.ponder(fen,4,{depth:4,timeMs:280});
  }

  onPonderResult(branches){
    if(this.mode!=='play'||this.game.position.turn!==this.playerColor)return;
    const fen=this.game.position.toFEN();
    this.branches=branches;this.state=STATES.PONDERING;this.render();
    clearTimeout(this.ponderTimer);
    this.ponderTimer=setTimeout(()=>{
      if(this.mode==='play'&&this.game.position.toFEN()===fen&&this.game.position.turn===this.playerColor&&this.controller.ponderFen===fen) {
        this.controller.refinePonder(fen,4,{depth:5,timeMs:900});
      }
    },35);
  }

  undo(){
    if(!this.game.canUndo||this.mode==='editing')return;
    this.controller.cancel();this.game.undo();this.branches=[];this.analysisArrow=null;this.engineInfo=null;this.board?.clearSelection();
    const st=this.game.status();
    if(this.mode==='analysis'){this.state=STATES.ANALYSIS;this.render();this.startAnalysis();return;}
    this.state=st.over?STATES.GAME_OVER:(this.game.position.turn===this.playerColor?STATES.PLAYER_TURN:STATES.IDLE);this.render();
  }

  redo(){
    if(!this.game.canRedo||this.mode==='editing')return;
    this.controller.cancel();this.game.redo();this.branches=[];this.analysisArrow=null;this.engineInfo=null;this.board?.clearSelection();
    const st=this.game.status();
    if(this.mode==='analysis'){this.state=STATES.ANALYSIS;this.render();this.startAnalysis();return;}
    this.state=st.over?STATES.GAME_OVER:(this.game.position.turn===this.playerColor?STATES.PLAYER_TURN:STATES.IDLE);this.render();
  }

  currentCheckSquare(position){return position.isInCheck(position.turn)?position.kingSquare(position.turn):null;}

  render(){
    if(!this.board)return;
    const position=this.mode==='editing'?this.editorPosition:this.game.position;
    const interactive=this.mode==='editing'||this.mode==='analysis'||((this.state===STATES.PLAYER_TURN||this.state===STATES.PONDERING)&&position.turn===this.playerColor);
    const snap=this.game.snapshot();
    this.board.render(position,{orientation:this.effectiveOrientation(),interactive,lastMove:this.mode==='editing'?null:snap.lastMove,branches:this.branches,predictionArrows:this.predictionArrows,analysisArrow:this.analysisArrow,editing:this.mode==='editing',checkSquare:this.currentCheckSquare(position),highlightBranch:this.highlightBranch});
    this.root.querySelector('#undoBtn').disabled=!this.game.canUndo||this.mode==='editing';
    this.root.querySelector('#redoBtn').disabled=!this.game.canRedo||this.mode==='editing';
    this.root.querySelector('#analysisBtn').textContent=this.mode==='analysis'?'Exit analysis':'Analysis';
    this.root.querySelector('#modePill').textContent=this.mode==='editing'?'EDIT':this.mode==='analysis'?'ANALYSIS':'PLAY';
    this.root.querySelector('#turnLabel').innerHTML=`<span class="status-dot"></span>${this.statusText()}`;
    this.renderSide();
    this.updateToast();
  }

  statusText(){
    if(this.mode==='editing')return 'Position editor';
    const status=this.game.status();
    if(status.over)return `${status.result} · ${status.reason}`;
    if(this.state===STATES.ENGINE_SEARCHING)return 'Vanta is calculating';
    if(this.state===STATES.PONDERING)return 'Your turn · Vanta is pondering';
    if(this.mode==='analysis')return `${this.game.position.turn===WHITE?'White':'Black'} to move · analysis`;
    if(this.state===STATES.IDLE&&this.game.position.turn!==this.playerColor)return 'Engine turn paused after timeline navigation';
    return `${this.game.position.turn===WHITE?'White':'Black'} to move`;
  }

  renderSide(){
    const status=this.mode==='editing'?null:this.game.status();
    const info=this.engineInfo;
    const evalText=info?this.formatEval(this.whitePerspective(info.objectiveScore??info.score,this.pendingFen)):'—';
    const pv=info?.pv?.length?this.pvToSan(this.pendingFen||this.game.position.toFEN(),info.pv):'No line calculated yet.';
    const branchHtml=this.branches.length?this.branches.map((b,i)=>`<div class="branch" data-branch="${i}"><span class="branch-color" style="background:${BRANCH_COLORS[i%BRANCH_COLORS.length]}"></span><div class="branch-main"><b>${b.opponentMove}</b> → <b>${b.engineMove}</b><div class="branch-meta">depth ${b.depth} · ${b.continuation.join(' ')}</div></div><div class="branch-eval">${this.formatEval(b.evaluation)}</div></div>`).join(''):`<div class="empty">${this.state===STATES.PONDERING?'Calculating likely replies…':'Prediction branches appear here after Vanta moves.'}</div>`;
    const history=this.game.moveRows();
    const historyHtml=history.length?history.map(r=>`<div class="move-row"><span class="move-no">${r.move}.</span><span class="move-cell">${r.white}</span><span class="move-cell">${r.black}</span></div>`).join(''):'<div class="empty">No moves yet.</div>';
    const candidates=this.mode==='analysis'&&info?.candidates?.length?`<div class="candidate-strip">${info.candidates.slice(0,5).map((c,i)=>`<span><b>${i+1}</b> ${c.uci} <em>${this.formatEval(this.whitePerspective(c.score,this.pendingFen))}</em></span>`).join('')}</div>`:'';
    let html=`<section class="panel"><div class="panel-head"><span class="panel-title">Engine</span><span class="panel-sub">target ≈ 1500 Elo</span></div><div class="engine-card"><div class="eval-row"><div class="eval">${evalText}</div><div class="thinking">${this.state===STATES.ENGINE_SEARCHING?'searching':this.state===STATES.PONDERING?'pondering':info?.ponderHit?'ponder hit':'ready'}</div></div><div class="metrics"><div class="metric"><b>${info?.depth??0}</b><span>depth</span></div><div class="metric"><b>${this.compact(info?.nodes??0)}</b><span>nodes</span></div><div class="metric"><b>${this.compact(info?.nps??0)}</b><span>nps</span></div><div class="metric"><b>${info?.timeMs??0} ms</b><span>time</span></div></div><div class="pv">${pv}</div>${candidates}</div>${status?.over?`<div class="game-result">${this.resultText(status)}</div>`:''}</section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Prediction map</span><span class="panel-sub">if this → then this</span></div><div class="branches">${branchHtml}</div><div class="toggle-row"><span>Prediction arrows</span><button class="switch ${this.predictionArrows?'on':''}" id="arrowToggle"><span></span></button></div></section>
    <section class="panel"><div class="panel-head"><span class="panel-title">Move history</span><span class="panel-sub">SAN</span></div><div class="history">${historyHtml}</div></section>`;
    html+=this.mode==='editing'?this.editorPanel():this.controlPanel();
    if(this.debug&&info) {
      const ponder=this.controller.getPonderStats();
      html+=`<section class="panel"><div class="panel-head"><span class="panel-title">Debug</span></div><div class="debug">qnodes ${info.qnodes}\ntt hits ${info.ttHits}\ncutoffs ${info.cutoffs??0}\nponder hits ${ponder.hits}\nponder misses ${ponder.misses}\nobjective ${info.objectiveScore}\nselected ${info.score}\n${(info.candidates||[]).map(c=>`${c.uci} ${c.score} p:${c.personality}`).join('\n')}</div></section>`;
    }
    this.sideRoot.innerHTML=html;
    this.bindSide();
  }

  controlPanel(){
    return `<section class="panel"><div class="panel-head"><span class="panel-title">Game</span><span class="panel-sub">Vanta · controlled violence</span></div><div class="controls">
      <button class="btn ${this.playerColor===WHITE?'primary':''}" id="playWhite">Play White</button><button class="btn ${this.playerColor===BLACK?'primary':''}" id="playBlack">Play Black</button>
      <button class="btn" id="editBtn">Edit position</button><button class="btn" id="analyzeBtn">${this.mode==='analysis'?'Exit analysis':'Analyze'}</button>
      <div class="field wide"><label>FEN</label><input id="fenInput" value="${this.escapeAttr(this.game.position.toFEN())}" /></div>
      <button class="btn" id="loadFen">Load FEN</button><button class="btn" id="copyFen">Copy FEN</button>
    </div><div class="toggle-row"><span>Developer statistics</span><button class="switch ${this.debug?'on':''}" id="debugToggle"><span></span></button></div></section>`;
  }

  editorPanel(){
    const p=this.editorPosition;
    return `<section class="panel"><div class="panel-head"><span class="panel-title">Position editor</span><span class="panel-sub">free placement</span></div><div class="editor"><div class="palette">${['K','Q','R','B','N','P','k','q','r','b','n','p','erase'].map(x=>`<button class="${this.editorTool===x?'active':''}" data-tool="${x}">${x==='erase'?'×':GLYPHS[x]}</button>`).join('')}</div>
      <div class="editor-row"><div class="field"><label>Side to move</label><select id="editorTurn"><option value="w" ${p.turn==='w'?'selected':''}>White</option><option value="b" ${p.turn==='b'?'selected':''}>Black</option></select></div><div class="field"><label>En passant</label><input id="editorEp" value="${p.epSquare==null?'-':indexToSquare(p.epSquare)}" /></div></div>
      <div class="checks">${['K','Q','k','q'].map(x=>`<label><input type="checkbox" id="castle_${x}" ${p.castling.includes(x)?'checked':''}> ${x}</label>`).join('')}</div>
      <div class="editor-row"><button class="btn" id="applyMeta">Apply rights</button><button class="btn" id="clearBoard">Clear board</button></div>
      <div class="field"><label>FEN</label><textarea class="fenbox" id="editorFen">${p.toFEN()}</textarea></div>
      <div class="editor-row"><button class="btn" id="editorLoadFen">Load FEN</button><button class="btn" id="copyFen">Copy FEN</button></div>
      ${this.editorWarning?`<div class="warning">${this.escapeHtml(this.editorWarning)}</div>`:''}
      <div class="editor-row"><button class="btn" id="cancelEditor">Cancel</button><button class="btn primary" id="startPosition">Start from position</button></div></div></section>`;
  }

  bindSide(){
    this.sideRoot.querySelector('#arrowToggle')?.addEventListener('click',()=>{this.predictionArrows=!this.predictionArrows;this.render();});
    this.sideRoot.querySelector('#debugToggle')?.addEventListener('click',()=>{this.debug=!this.debug;this.render();});
    this.sideRoot.querySelector('#playWhite')?.addEventListener('click',()=>this.newGame(WHITE));
    this.sideRoot.querySelector('#playBlack')?.addEventListener('click',()=>this.newGame(BLACK));
    this.sideRoot.querySelector('#editBtn')?.addEventListener('click',()=>this.enterEditor());
    this.sideRoot.querySelector('#analyzeBtn')?.addEventListener('click',()=>this.toggleAnalysis());
    this.sideRoot.querySelector('#loadFen')?.addEventListener('click',()=>this.loadFen(this.sideRoot.querySelector('#fenInput').value));
    this.sideRoot.querySelector('#copyFen')?.addEventListener('click',()=>this.copyFen());
    this.sideRoot.querySelectorAll('[data-branch]').forEach(el=>{el.onmouseenter=()=>{this.highlightBranch=Number(el.dataset.branch);this.renderBoardOnly();};el.onmouseleave=()=>{this.highlightBranch=null;this.renderBoardOnly();};});
    if(this.mode==='editing'){
      this.sideRoot.querySelectorAll('[data-tool]').forEach(el=>el.onclick=()=>{this.editorTool=el.dataset.tool;this.render();});
      this.sideRoot.querySelector('#applyMeta')?.addEventListener('click',()=>this.setEditorMeta());
      this.sideRoot.querySelector('#clearBoard')?.addEventListener('click',()=>{this.editorPosition=new Position({board:Array(64).fill(null),turn:this.editorPosition.turn,castling:'',epSquare:null,halfmove:0,fullmove:1});this.render();});
      this.sideRoot.querySelector('#editorLoadFen')?.addEventListener('click',()=>this.loadFen(this.sideRoot.querySelector('#editorFen').value,true));
      this.sideRoot.querySelector('#cancelEditor')?.addEventListener('click',()=>{this.mode='play';this.state=this.game.position.turn===this.playerColor?STATES.PLAYER_TURN:STATES.IDLE;this.editorWarning='';this.render();});
      this.sideRoot.querySelector('#startPosition')?.addEventListener('click',()=>this.startFromEditor());
    }
  }

  renderBoardOnly(){
    const position=this.mode==='editing'?this.editorPosition:this.game.position;
    const snap=this.game.snapshot();
    this.board.render(position,{orientation:this.effectiveOrientation(),interactive:this.mode==='editing'||this.mode==='analysis'||this.state===STATES.PLAYER_TURN||this.state===STATES.PONDERING,lastMove:this.mode==='editing'?null:snap.lastMove,branches:this.branches,predictionArrows:this.predictionArrows,analysisArrow:this.analysisArrow,editing:this.mode==='editing',checkSquare:this.currentCheckSquare(position),highlightBranch:this.highlightBranch});
  }

  whitePerspective(score,fen){
    if(score==null)return null;
    try{return Position.fromFEN(fen||this.game.position.toFEN()).turn===WHITE?score:-score;}catch{return score;}
  }
  formatEval(score){if(score==null)return '—';if(Math.abs(score)>99000)return score>0?'MATE':'-MATE';const v=score/100;return `${v>=0?'+':''}${v.toFixed(2)}`;}
  compact(n){if(n>=1e6)return `${(n/1e6).toFixed(1)}m`;if(n>=1e3)return `${(n/1e3).toFixed(1)}k`;return String(n||0);}
  pvToSan(fen,pv){
    try{let p=Position.fromFEN(fen);const out=[];for(const u of pv){const m=p.moveFromUci(u);if(!m)break;out.push(moveToSAN(p,m));p=p.makeMove(m);}return out.join(' ');}catch{return pv.join(' ');}
  }
  resultText(s){if(s.reason==='checkmate')return `${s.result==='1-0'?'White':'Black'} wins by checkmate.`;return `Draw by ${s.reason}.`;}
  escapeHtml(s){return String(s).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');}
  escapeAttr(s){return this.escapeHtml(s);}
}

new VantaApp(document.querySelector('#app'));
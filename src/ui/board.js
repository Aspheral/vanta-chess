import { colorOf, indexToSquare } from '../chess/constants.js';
import { renderArrowLayer } from './arrows.js';
import { pieceName, pieceSvg } from './pieces.js';
import { chessAudio } from './audio.js';

export class BoardView {
  constructor(root,{onMoveRequest,onEditorSquare,onEditorMove}={}) {
    this.root=root;
    this.onMoveRequest=onMoveRequest;
    this.onEditorSquare=onEditorSquare;
    this.onEditorMove=onEditorMove;
    this.selected=null;
    this.dragFrom=null;
    this.position=null;
    this.options={};
    this.currentHash=null;
    this.currentDistinctPosition=null;
    this.transitionForward=false;
    this.completedAnimationKey=null;
    this.lastSoundKey=null;
    this.animationGeneration=0;
    this.suppressEditorClick=false;
    this.suppressBoardClick=false;
    this.pointerDrag=null;
  }

  render(position,options={}) {
    this.cancelPointerDrag(false);
    this.position=position;
    this.options={orientation:'w',interactive:true,lastMove:null,branches:[],predictionArrows:true,analysisArrow:null,editing:false,checkSquare:null,highlightBranch:null,animateMoves:true,sounds:true,...options};
    const order=this.options.orientation==='w'?[...Array(64).keys()]:[...Array(64).keys()].reverse();
    if(this.options.editing) this.selected=null;
    const legalSelected=!this.options.editing&&this.selected!=null?position.legalMoves().filter(m=>m.from===this.selected):[];
    const legalTargets=new Map();
    for(const m of legalSelected) legalTargets.set(m.to,m);
    const lastFrom=this.options.lastMove?.from?this.squareIndex(this.options.lastMove.from):null;
    const lastTo=this.options.lastMove?.to?this.squareIndex(this.options.lastMove.to):null;
    const hash=String(position.hash??position.toFEN());
    const moveKey=this.options.lastMove&&!this.options.editing?`${hash}:${this.options.lastMove.from}:${this.options.lastMove.to}`:null;

    if(this.currentHash!==hash){
      const previous=this.currentDistinctPosition;
      this.transitionForward=Boolean(previous&&this.options.lastMove&&this.isForwardTransition(previous,position,this.options.lastMove));
      if(!this.transitionForward){
        this.completedAnimationKey=moveKey;
        this.lastSoundKey=null;
      }
      this.currentDistinctPosition=position;
      this.currentHash=hash;
    }

    const reduceMotion=globalThis.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
    const shouldAnimate=Boolean(moveKey&&this.transitionForward&&this.options.animateMoves&&!reduceMotion&&moveKey!==this.completedAnimationKey);
    const shouldSound=Boolean(moveKey&&this.transitionForward&&this.options.sounds&&moveKey!==this.lastSoundKey);

    let html='<div class="board-shell"><div class="board-grid" role="grid" aria-label="Chess board">';
    for(const index of order) {
      const p=position.board[index];
      const row=Math.floor(index/8),col=index%8;
      const light=(row+col)%2===0;
      const classes=['square',light?'light':'dark'];
      if(index===this.selected) classes.push('selected');
      if(index===lastFrom||index===lastTo) classes.push('last-move');
      if(index===this.options.checkSquare) classes.push('in-check');
      if(legalTargets.has(index)) classes.push(p?'legal-capture':'legal-target');
      const square=indexToSquare(index);
      const labelFile=(this.options.orientation==='w'?row===7:row===0)?square[0]:'';
      const labelRank=(this.options.orientation==='w'?col===0:col===7)?square[1]:'';
      html+=`<button class="${classes.join(' ')}" data-index="${index}" role="gridcell" aria-label="${square}${p?' '+pieceName(p):''}">`;
      if(p) html+=`<span class="piece ${colorOf(p)==='w'?'white-piece':'black-piece'}${shouldAnimate&&index===lastTo?' animation-destination':''}" draggable="${this.options.interactive?'true':'false'}" data-from="${index}">${pieceSvg(p)}</span>`;
      if(labelFile) html+=`<span class="coord file">${labelFile}</span>`;
      if(labelRank) html+=`<span class="coord rank">${labelRank}</span>`;
      html+='</button>';
    }
    html+='</div>';
    if(this.options.predictionArrows||this.options.analysisArrow) html+=renderArrowLayer({orientation:this.options.orientation,branches:this.options.predictionArrows?this.options.branches:[],analysisArrow:this.options.analysisArrow,highlightBranch:this.options.highlightBranch});
    html+='</div>';
    this.root.innerHTML=html;
    this.bind();

    if(shouldSound){
      this.lastSoundKey=moveKey;
      chessAudio.playMoveResult(position);
    }
    if(shouldAnimate)this.animateLastMove(lastFrom,lastTo,moveKey);
    else if(moveKey&&this.transitionForward)this.completedAnimationKey=moveKey;
  }

  isForwardTransition(previous,current,lastMove){
    try{
      const from=this.squareIndex(lastMove.from),to=this.squareIndex(lastMove.to);
      return previous.legalMoves().filter(move=>move.from===from&&move.to===to).some(move=>previous.makeMove(move).hash===current.hash);
    }catch{return false;}
  }

  animateLastMove(from,to,key){
    if(from==null||to==null)return;
    const shell=this.root.querySelector('.board-shell');
    const fromSquare=this.root.querySelector(`.square[data-index="${from}"]`);
    const toSquare=this.root.querySelector(`.square[data-index="${to}"]`);
    const destination=toSquare?.querySelector('.piece');
    if(!shell||!fromSquare||!toSquare||!destination){this.completedAnimationKey=key;return;}

    const generation=++this.animationGeneration;
    const shellRect=shell.getBoundingClientRect();
    const fromRect=fromSquare.getBoundingClientRect();
    const toRect=toSquare.getBoundingClientRect();
    const ghost=document.createElement('span');
    ghost.className=`moving-piece ${destination.classList.contains('white-piece')?'white-piece':'black-piece'}`;
    ghost.innerHTML=destination.innerHTML;
    ghost.style.left=`${fromRect.left-shellRect.left}px`;
    ghost.style.top=`${fromRect.top-shellRect.top}px`;
    ghost.style.width=`${fromRect.width}px`;
    ghost.style.height=`${fromRect.height}px`;
    destination.classList.add('animation-hidden');
    shell.appendChild(ghost);

    const dx=toRect.left-fromRect.left;
    const dy=toRect.top-fromRect.top;
    const finish=()=>{
      if(generation!==this.animationGeneration)return;
      ghost.remove();
      destination.classList.remove('animation-hidden');
      this.completedAnimationKey=key;
    };

    if(typeof ghost.animate==='function'){
      const animation=ghost.animate([
        {transform:'translate3d(0,0,0) scale(1)',filter:'drop-shadow(0 2px 2px #0003)'},
        {transform:`translate3d(${dx}px,${dy}px,0) scale(1.025)`,filter:'drop-shadow(0 7px 5px #0005)'}
      ],{duration:165,easing:'cubic-bezier(.22,.72,.2,1)',fill:'forwards'});
      animation.finished.then(finish).catch(finish);
    }else{
      requestAnimationFrame(()=>{
        ghost.style.transition='transform 165ms cubic-bezier(.22,.72,.2,1)';
        ghost.style.transform=`translate3d(${dx}px,${dy}px,0)`;
        setTimeout(finish,175);
      });
    }
  }

  squareIndex(square) {
    const file='abcdefgh'.indexOf(square[0]);
    return (8-Number(square[1]))*8+file;
  }

  showTransientTargets(from){
    this.root.querySelectorAll('.square.selected,.square.legal-target,.square.legal-capture').forEach(el=>el.classList.remove('selected','legal-target','legal-capture'));
    const source=this.root.querySelector(`.square[data-index="${from}"]`);
    source?.classList.add('selected');
    if(this.options.editing||!this.position)return;
    for(const move of this.position.legalMoves().filter(m=>m.from===from)){
      const target=this.root.querySelector(`.square[data-index="${move.to}"]`);
      if(!target)continue;
      target.classList.add(this.position.board[move.to]?'legal-capture':'legal-target');
    }
  }

  clearTransientTargets(){
    this.root.querySelectorAll('.square.selected,.square.legal-target,.square.legal-capture').forEach(el=>el.classList.remove('selected','legal-target','legal-capture'));
  }

  suppressClickBriefly(){
    this.suppressBoardClick=true;
    clearTimeout(this.suppressClickTimer);
    this.suppressClickTimer=setTimeout(()=>{this.suppressBoardClick=false;},420);
  }

  beginPointerDrag(piece,e,from){
    const rect=piece.closest('.square')?.getBoundingClientRect();
    if(!rect)return;
    this.pointerDrag={
      pointerId:e.pointerId,
      from,
      startX:e.clientX,
      startY:e.clientY,
      size:rect.width,
      moved:false,
      piece,
      ghost:null,
    };
    this.showTransientTargets(from);
    try{piece.setPointerCapture(e.pointerId);}catch{}
  }

  movePointerDrag(e){
    const drag=this.pointerDrag;
    if(!drag||drag.pointerId!==e.pointerId)return;
    const distance=Math.hypot(e.clientX-drag.startX,e.clientY-drag.startY);
    if(!drag.moved&&distance<5)return;
    e.preventDefault();
    if(!drag.moved){
      drag.moved=true;
      drag.piece.classList.add('dragging');
      document.documentElement.classList.add('board-drag-active');
      const ghost=document.createElement('span');
      ghost.className='touch-drag-ghost';
      ghost.innerHTML=drag.piece.innerHTML;
      ghost.style.width=`${drag.size}px`;
      ghost.style.height=`${drag.size}px`;
      document.body.appendChild(ghost);
      drag.ghost=ghost;
    }
    if(drag.ghost){
      const x=e.clientX-drag.size/2;
      const y=e.clientY-drag.size*.88;
      drag.ghost.style.transform=`translate3d(${x}px,${y}px,0) scale(1.08)`;
    }
  }

  finishPointerDrag(e){
    const drag=this.pointerDrag;
    if(!drag||drag.pointerId!==e.pointerId)return;
    if(!drag.moved){
      this.cancelPointerDrag(false);
      return;
    }

    e.preventDefault();
    const target=document.elementFromPoint(e.clientX,e.clientY)?.closest?.('.square');
    const to=target?Number(target.dataset.index):null;
    const from=drag.from;
    this.suppressClickBriefly();
    this.cancelPointerDrag(false);

    if(Number.isInteger(to)&&to!==from){
      if(this.options.editing){
        this.suppressEditorClick=true;
        this.onEditorMove?.(from,to);
      }else{
        const legal=this.position.legalMoves().filter(m=>m.from===from&&m.to===to);
        if(legal.length){
          this.selected=null;
          this.onMoveRequest?.(from,to,legal);
        }else{
          this.selected=from;
          this.render(this.position,this.options);
        }
      }
    }else if(!this.options.editing){
      this.selected=from;
      this.render(this.position,this.options);
    }else{
      this.render(this.position,this.options);
    }
  }

  cancelPointerDrag(restore=true){
    const drag=this.pointerDrag;
    if(drag){
      try{drag.piece.releasePointerCapture(drag.pointerId);}catch{}
      drag.piece.classList.remove('dragging');
      drag.ghost?.remove();
    }
    document.documentElement.classList.remove('board-drag-active');
    this.pointerDrag=null;
    if(restore&&this.position)this.render(this.position,this.options);
  }

  bind() {
    this.root.querySelectorAll('.square').forEach(el=>{
      el.addEventListener('click',()=>{
        if(this.suppressBoardClick){this.suppressBoardClick=false;return;}
        if(this.options.editing&&this.suppressEditorClick){this.suppressEditorClick=false;return;}
        this.handleSquare(Number(el.dataset.index));
      });
      el.addEventListener('dragover',e=>{ if(this.options.interactive) e.preventDefault(); });
      el.addEventListener('drop',e=>{
        e.preventDefault();
        const raw=e.dataTransfer.getData('text/plain');
        const from=raw!==''?Number(raw):this.dragFrom;
        const to=Number(el.dataset.index);
        if(Number.isInteger(from)){
          if(this.options.editing){this.suppressEditorClick=true;this.onEditorMove?.(from,to);}
          else this.requestMove(from,to);
        }
      });
    });

    this.root.querySelectorAll('.piece[draggable="true"]').forEach(piece=>{
      piece.addEventListener('dragstart',e=>{
        chessAudio.unlock();
        this.dragFrom=Number(piece.dataset.from);
        this.showTransientTargets(this.dragFrom);
        e.dataTransfer.setData('text/plain',String(this.dragFrom));
        e.dataTransfer.effectAllowed='move';
        piece.classList.add('dragging');
      });
      piece.addEventListener('dragend',()=>{
        piece.classList.remove('dragging');
        this.dragFrom=null;
        this.clearTransientTargets();
      });

      // Mobile Safari's HTML drag-and-drop is inconsistent and also competes
      // with document scrolling. Touch/pen input therefore uses Pointer Events
      // for both normal play and the position editor.
      piece.addEventListener('pointerdown',e=>{
        if(e.pointerType==='mouse'||!this.options.interactive)return;
        const from=Number(piece.dataset.from);
        const boardPiece=this.position?.board[from];
        if(!this.options.editing&&(!boardPiece||colorOf(boardPiece)!==this.position.turn))return;
        chessAudio.unlock();
        this.beginPointerDrag(piece,e,from);
      },{passive:false});
      piece.addEventListener('pointermove',e=>this.movePointerDrag(e),{passive:false});
      piece.addEventListener('pointerup',e=>this.finishPointerDrag(e),{passive:false});
      piece.addEventListener('pointercancel',()=>this.cancelPointerDrag(true));
    });
  }

  handleSquare(index) {
    chessAudio.unlock();
    if(this.options.editing) { this.onEditorSquare?.(index); return; }
    if(!this.options.interactive) return;
    const p=this.position.board[index];
    if(this.selected==null) {
      if(p&&colorOf(p)===this.position.turn) { this.selected=index; this.render(this.position,this.options); }
      return;
    }
    if(index===this.selected) { this.selected=null; this.render(this.position,this.options); return; }
    const legal=this.position.legalMoves().filter(m=>m.from===this.selected&&m.to===index);
    if(legal.length) {
      const from=this.selected;
      this.selected=null;
      this.onMoveRequest?.(from,index,legal);
      return;
    }
    if(p&&colorOf(p)===this.position.turn) { this.selected=index; this.render(this.position,this.options); }
    else { this.selected=null; this.render(this.position,this.options); }
  }

  requestMove(from,to) {
    chessAudio.unlock();
    const legal=this.position.legalMoves().filter(m=>m.from===from&&m.to===to);
    if(legal.length) { this.selected=null; this.onMoveRequest?.(from,to,legal); }
  }

  clearSelection(){this.selected=null;}
}

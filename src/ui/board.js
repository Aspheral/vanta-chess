import { colorOf, indexToSquare } from '../chess/constants.js';
import { renderArrowLayer } from './arrows.js';
import { pieceName, pieceSvg } from './pieces.js';
import { chessAudio } from './audio.js';

export class BoardView {
  constructor(root,{onMoveRequest,onEditorSquare}={}) {
    this.root=root;
    this.onMoveRequest=onMoveRequest;
    this.onEditorSquare=onEditorSquare;
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
  }

  render(position,options={}) {
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
      if(p) html+=`<span class="piece ${colorOf(p)==='w'?'white-piece':'black-piece'}${shouldAnimate&&index===lastTo?' animation-destination':''}" draggable="${this.options.interactive&&!this.options.editing?'true':'false'}" data-from="${index}">${pieceSvg(p)}</span>`;
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

  bind() {
    this.root.querySelectorAll('.square').forEach(el=>{
      el.addEventListener('click',()=>this.handleSquare(Number(el.dataset.index)));
      el.addEventListener('dragover',e=>{ if(this.options.interactive) e.preventDefault(); });
      el.addEventListener('drop',e=>{
        e.preventDefault();
        const from=Number(e.dataTransfer.getData('text/plain')||this.dragFrom);
        const to=Number(el.dataset.index);
        if(Number.isInteger(from)) this.requestMove(from,to);
      });
    });
    this.root.querySelectorAll('.piece[draggable="true"]').forEach(piece=>{
      piece.addEventListener('dragstart',e=>{
        chessAudio.unlock();
        this.dragFrom=Number(piece.dataset.from);
        e.dataTransfer.setData('text/plain',String(this.dragFrom));
        e.dataTransfer.effectAllowed='move';
        piece.classList.add('dragging');
      });
      piece.addEventListener('dragend',()=>{
        piece.classList.remove('dragging');
        this.dragFrom=null;
      });
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

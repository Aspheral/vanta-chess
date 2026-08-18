import { colorOf, indexToSquare } from '../chess/constants.js';
import { renderArrowLayer } from './arrows.js';

const GLYPHS={K:'♔',Q:'♕',R:'♖',B:'♗',N:'♘',P:'♙',k:'♚',q:'♛',r:'♜',b:'♝',n:'♞',p:'♟'};

export class BoardView {
  constructor(root,{onMoveRequest,onEditorSquare}={}) {
    this.root=root;
    this.onMoveRequest=onMoveRequest;
    this.onEditorSquare=onEditorSquare;
    this.selected=null;
    this.dragFrom=null;
    this.position=null;
    this.options={};
  }

  render(position,options={}) {
    this.position=position;
    this.options={orientation:'w',interactive:true,lastMove:null,branches:[],predictionArrows:true,analysisArrow:null,editing:false,checkSquare:null,highlightBranch:null,...options};
    const order=this.options.orientation==='w'?[...Array(64).keys()]:[...Array(64).keys()].reverse();
    if(this.options.editing) this.selected=null;
    const legalSelected=!this.options.editing&&this.selected!=null?position.legalMoves().filter(m=>m.from===this.selected):[];
    const legalTargets=new Map();
    for(const m of legalSelected) legalTargets.set(m.to,m);
    const lastFrom=this.options.lastMove?.from?this.squareIndex(this.options.lastMove.from):null;
    const lastTo=this.options.lastMove?.to?this.squareIndex(this.options.lastMove.to):null;
    let html='<div class="board-shell"><div class="board-grid">';
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
      html+=`<button class="${classes.join(' ')}" data-index="${index}" aria-label="${square}${p?' '+p:''}">`;
      if(p) html+=`<span class="piece ${colorOf(p)==='w'?'white-piece':'black-piece'}" draggable="${this.options.interactive&&!this.options.editing?'true':'false'}" data-from="${index}">${GLYPHS[p]}</span>`;
      if(labelFile) html+=`<span class="coord file">${labelFile}</span>`;
      if(labelRank) html+=`<span class="coord rank">${labelRank}</span>`;
      html+='</button>';
    }
    html+='</div>';
    if(this.options.predictionArrows||this.options.analysisArrow) html+=renderArrowLayer({orientation:this.options.orientation,branches:this.options.predictionArrows?this.options.branches:[],analysisArrow:this.options.analysisArrow,highlightBranch:this.options.highlightBranch});
    html+='</div>';
    this.root.innerHTML=html;
    this.bind();
  }

  squareIndex(square) {
    const file='abcdefgh'.indexOf(square[0]); return (8-Number(square[1]))*8+file;
  }

  bind() {
    this.root.querySelectorAll('.square').forEach(el=>{
      el.addEventListener('click',e=>this.handleSquare(Number(el.dataset.index)));
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
        this.dragFrom=Number(piece.dataset.from);
        e.dataTransfer.setData('text/plain',String(this.dragFrom));
        e.dataTransfer.effectAllowed='move';
      });
      piece.addEventListener('dragend',()=>{this.dragFrom=null;});
    });
  }

  handleSquare(index) {
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
      const from=this.selected; this.selected=null; this.onMoveRequest?.(from,index,legal); return;
    }
    if(p&&colorOf(p)===this.position.turn) { this.selected=index; this.render(this.position,this.options); }
    else { this.selected=null; this.render(this.position,this.options); }
  }

  requestMove(from,to) {
    const legal=this.position.legalMoves().filter(m=>m.from===from&&m.to===to);
    if(legal.length) { this.selected=null; this.onMoveRequest?.(from,to,legal); }
  }

  clearSelection(){this.selected=null;}
}

import { squareToIndex } from '../chess/constants.js';

export const BRANCH_COLORS = ['#42d392','#ff6b6b','#58a6ff','#f7b955','#b985ff'];

function coord(index, orientation) {
  const row=Math.floor(index/8), col=index%8;
  const displayRow=orientation==='w'?row:7-row;
  const displayCol=orientation==='w'?col:7-col;
  return {x:displayCol*100+50,y:displayRow*100+50};
}

function geometry(from,to,orientation){
  const a=coord(typeof from==='string'?squareToIndex(from):from,orientation);
  const b=coord(typeof to==='string'?squareToIndex(to):to,orientation);
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
  const ux=dx/len,uy=dy/len;
  const endX=b.x-ux*22,endY=b.y-uy*22;
  const head=24,wing=14,px=-uy,py=ux;
  return {a,b,endX,endY,p1:`${b.x},${b.y}`,p2:`${endX-ux*head+px*wing},${endY-uy*head+py*wing}`,p3:`${endX-ux*head-px*wing},${endY-uy*head-py*wing}`};
}

function arrowSvg(from,to,color,orientation,opacity=0.78,thickness=13) {
  const g=geometry(from,to,orientation);
  return `<g opacity="${opacity}"><line x1="${g.a.x}" y1="${g.a.y}" x2="${g.endX}" y2="${g.endY}" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round"/><polygon points="${g.p1} ${g.p2} ${g.p3}" fill="${color}"/></g>`;
}

function analysisArrowSvg(from,to,orientation){
  const g=geometry(from,to,orientation);
  return `<g class="analysis-best-arrow" opacity="1">
    <line class="analysis-arrow-outline" x1="${g.a.x}" y1="${g.a.y}" x2="${g.endX}" y2="${g.endY}" stroke="#071009" stroke-width="22" stroke-linecap="round"/>
    <polygon class="analysis-arrow-head-outline" points="${g.p1} ${g.p2} ${g.p3}" fill="#071009" stroke="#071009" stroke-width="7" stroke-linejoin="round"/>
    <line class="analysis-arrow-core" x1="${g.a.x}" y1="${g.a.y}" x2="${g.endX}" y2="${g.endY}" stroke="#b7ff6a" stroke-width="12" stroke-linecap="round"/>
    <polygon class="analysis-arrow-head" points="${g.p1} ${g.p2} ${g.p3}" fill="#b7ff6a" stroke="#efffdc" stroke-width="2.5" stroke-linejoin="round"/>
    <circle cx="${g.a.x}" cy="${g.a.y}" r="10" fill="#b7ff6a" stroke="#071009" stroke-width="5"/>
  </g>`;
}

export function renderArrowLayer({orientation='w',branches=[],analysisArrow=null,highlightBranch=null}) {
  let svg='';
  branches.forEach((b,i)=>{
    const color=BRANCH_COLORS[i%BRANCH_COLORS.length];
    const active=highlightBranch==null||highlightBranch===i;
    const opacity=active?0.82:0.20;
    svg+=arrowSvg(b.opponentMove.slice(0,2),b.opponentMove.slice(2,4),color,orientation,opacity,13);
    svg+=arrowSvg(b.engineMove.slice(0,2),b.engineMove.slice(2,4),color,orientation,opacity,9);
  });
  if(analysisArrow&&analysisArrow.length>=4) svg+=analysisArrowSvg(analysisArrow.slice(0,2),analysisArrow.slice(2,4),orientation);
  return `<svg class="arrow-layer" viewBox="0 0 800 800" aria-hidden="true">${svg}</svg>`;
}

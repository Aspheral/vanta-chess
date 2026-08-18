import { squareToIndex } from '../chess/constants.js';

export const BRANCH_COLORS = ['#42d392','#ff6b6b','#58a6ff','#f7b955','#b985ff'];

function coord(index, orientation) {
  const row=Math.floor(index/8), col=index%8;
  const displayRow=orientation==='w'?row:7-row;
  const displayCol=orientation==='w'?col:7-col;
  return {x:displayCol*100+50,y:displayRow*100+50};
}

function arrowSvg(from,to,color,orientation,opacity=0.78,thickness=13) {
  const a=coord(typeof from==='string'?squareToIndex(from):from,orientation);
  const b=coord(typeof to==='string'?squareToIndex(to):to,orientation);
  const dx=b.x-a.x,dy=b.y-a.y,len=Math.hypot(dx,dy)||1;
  const ux=dx/len,uy=dy/len;
  const endX=b.x-ux*22,endY=b.y-uy*22;
  const head=24,wing=14;
  const px=-uy,py=ux;
  const p1=`${b.x},${b.y}`;
  const p2=`${endX-ux*head+px*wing},${endY-uy*head+py*wing}`;
  const p3=`${endX-ux*head-px*wing},${endY-uy*head-py*wing}`;
  return `<g opacity="${opacity}"><line x1="${a.x}" y1="${a.y}" x2="${endX}" y2="${endY}" stroke="${color}" stroke-width="${thickness}" stroke-linecap="round"/><polygon points="${p1} ${p2} ${p3}" fill="${color}"/></g>`;
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
  if(analysisArrow) svg+=arrowSvg(analysisArrow.slice(0,2),analysisArrow.slice(2,4),'#f1f5f3',orientation,0.72,10);
  return `<svg class="arrow-layer" viewBox="0 0 800 800" aria-hidden="true">${svg}</svg>`;
}

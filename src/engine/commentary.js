import { colorOf, typeOf, opposite, indexToSquare, squareToIndex } from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

const names = {p:'pawn',n:'knight',b:'bishop',r:'rook',q:'queen',k:'king'};
function attacks(position, from, to) {
  const piece=position.board[from];
  if(!piece||from===to)return false;
  const dr=Math.floor(to/8)-Math.floor(from/8),dc=to%8-from%8;
  const ar=Math.abs(dr),ac=Math.abs(dc),type=typeOf(piece);
  if(type==='p')return dr===(colorOf(piece)==='w'?-1:1)&&ac===1;
  if(type==='n')return ar*ac===2;
  if(type==='k')return Math.max(ar,ac)===1;
  if(!(type==='b'&&ar===ac||type==='r'&&(!dr||!dc)||type==='q'&&(ar===ac||!dr||!dc)))return false;
  const step=Math.sign(dr)*8+Math.sign(dc);
  for(let i=from+step;i!==to;i+=step)if(position.board[i])return false;
  return true;
}

// Facts about the move already on the board. Deliberately exclude search PVs:
// those are provisional and cannot promise the engine's next choice.
export function moveFacts(game, vantaColor) {
  if(!game.cursor)return null;
  const entry=game.timeline[game.cursor],before=game.timeline[game.cursor-1].position;
  const after=entry.position,move=entry.move,enemy=opposite(before.turn);
  const targets=after.board.flatMap((p,i)=>p&&colorOf(p)===enemy&&typeOf(p)!=='k'&&attacks(after,move.to,i)?[{piece:names[typeOf(p)],square:indexToSquare(i)}]:[]);
  const center=['d4','e4','d5','e5'].filter(s=>attacks(after,move.to,squareToIndex(s)));
  const status=game.status(),check=after.isInCheck(enemy);
  return {
    san:entry.san,moveNumber:before.fullmove,mover:before.turn==='w'?'White':'Black',
    actor:before.turn===vantaColor?'Vanta':'opponent',piece:names[typeOf(move.piece)],
    from:indexToSquare(move.from),to:indexToSquare(move.to),
    captured:move.captured?names[typeOf(move.captured)]:null,
    promotion:move.promotion?names[move.promotion]:null,enPassant:Boolean(move.flags&FLAGS.EP_CAPTURE),
    castle:move.flags&FLAGS.CASTLE_K?'kingside':move.flags&FLAGS.CASTLE_Q?'queenside':null,
    check,terminal:status.over?{result:status.result,reason:status.reason}:null,
    centralInfluence:center,geometricPressure:targets,
    developsMinorPiece:['n','b'].includes(typeOf(move.piece))&&Math.floor(move.from/8)===(before.turn==='w'?7:0)&&Math.floor(move.to/8)!==Math.floor(move.from/8),
    pawnAdvance:typeOf(move.piece)==='p'&&!move.captured?(move.to%8<3?'queenside':move.to%8>4?'kingside':'center'):null,
    noteworthy:Boolean(status.over||check||move.captured||move.promotion||(move.flags&(FLAGS.CASTLE_K|FLAGS.CASTLE_Q))||targets.some(t=>t.piece!=='pawn'))
  };
}

export function coachRequestForGame(game,vantaColor) {
  return {startFen:game.timeline[0].position.toFEN(),moves:game.history.map(e=>e.uci),vantaColor,
    recentNotes:game.history.slice(0,-1).filter(e=>e.coach?.state==='done').slice(-2).map(e=>e.coach.text.slice(0,600))};
}

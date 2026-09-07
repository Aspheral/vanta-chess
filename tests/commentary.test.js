import test from 'node:test';
import assert from 'node:assert/strict';
import { Position } from '../src/chess/position.js';
import { ChessGame } from '../src/chess/game.js';
import { MoveCommentator, recordCommentary, commentaryPanel } from '../src/engine/commentary.js';

function comment(fen, uci, options) {
  const p = fen ? Position.fromFEN(fen) : Position.start();
  const move = p.moveFromUci(uci);
  assert.ok(move, uci);
  return new MoveCommentator(() => 0).explain(p, move, options);
}

test('central influence and development are grounded in the board', () => {
  const result = comment(null, 'g1f3');
  assert.match(result.text, /d4 and e5/);
  assert.match(result.text, /minor piece/);
  assert.doesNotMatch(result.text, /checkmate|great move|winning/);
});
test('knight pressure names the actual bishop and square', () => {
  const result = comment('4k3/8/4b3/8/8/7N/8/4K3 w - - 0 1', 'h3f4');
  assert.match(result.text, /bishop on e6/);
});
test('sliding pressure does not pass through a blocker', () => {
  const result = comment('4k3/8/8/6q1/5p2/8/3B4/4K3 w - - 0 1', 'd2e3');
  assert.doesNotMatch(result.text, /queen on g5/);
});
test('quiet opponent moves are skipped, captures get a comment', () => {
  assert.equal(comment(null, 'e2e4', { isVanta: false }), null);
  const game = new ChessGame();
  game.playUci('e2e4'); game.playUci('d7d5');
  const p = game.position;
  assert.match(new MoveCommentator(() => 0).explain(p, p.moveFromUci('e4d5'), { isVanta:false }).text, /pawn on d5/);
});
test('continuations must be legal and start with the selected move', () => {
  assert.match(comment(null, 'e2e4', { pv:['e2e4','e7e5','g1f3'] }).text, /If the reply is e5.*Nf3/);
  assert.doesNotMatch(comment(null, 'e2e4', { pv:['d2d4','e7e5','g1f3'] }).text, /calculated|reply is/);
  assert.doesNotMatch(comment(null, 'e2e4', { pv:['e2e4','e7e4','g1f3'] }).text, /calculated|reply is/);
});
test('special moves and terminal positions are described accurately', () => {
  assert.match(comment('4k3/8/8/8/8/8/8/4K2R w K - 0 1', 'e1g1').text, /Castling/);
  assert.match(comment('4k3/8/8/3pP3/8/8/8/4K3 w - d6 0 1', 'e5d6').text, /en passant/);
  assert.match(comment('8/4P2k/8/8/8/8/8/K7 w - - 0 1', 'e7e8n').text, /draw/);
  assert.match(comment('8/4P2k/8/8/8/8/8/K7 w - - 0 1', 'e7e8q').text, /promotes to a queen/);
  const g = new ChessGame();
  for (const u of ['f2f3','e7e5','g2g4']) g.playUci(u);
  assert.match(comment(g.position.toFEN(),'d8h4').text, /checkmate/);
});
test('variation combines independent phrases and avoids adjacent repeats', () => {
  let seed = 12345;
  const generator = new MoveCommentator(() => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296));
  const p = Position.start(), move = p.moveFromUci('g1f3'), texts = [];
  for (let i=0; i<120; i++) texts.push(generator.explain(p,move,{pv:['g1f3','d7d5','d2d4']}).text);
  assert.ok(new Set(texts).size > 100);
  for(let i=1;i<texts.length;i++) assert.notEqual(texts[i].split('.')[0],texts[i-1].split('.')[0]);
});
test('generation leaves board, hash and legal moves untouched', () => {
  const p=Position.start(), fen=p.toFEN(), hash=p.hash;
  new MoveCommentator().explain(p,p.moveFromUci('e2e4'),{pv:['e2e4','e7e5','g1f3']});
  assert.equal(p.toFEN(),fen); assert.equal(p.hash,hash); assert.equal(p.legalMoves().length,20);
});
test('comments follow undo, redo, branch replacement and reset', () => {
  const g=new ChessGame(), gen=new MoveCommentator(()=>0);
  const before=g.position, move=before.moveFromUci('e2e4');
  g.play(move); recordCommentary(g,gen,before,move,{isVanta:true});
  assert.match(commentaryPanel(g),/pawn to e4/);
  g.undo(); assert.doesNotMatch(commentaryPanel(g),/pawn to e4/);
  g.redo(); assert.match(commentaryPanel(g),/pawn to e4/);
  g.undo(); g.playUci('d2d4'); assert.doesNotMatch(commentaryPanel(g),/pawn to e4/);
  g.reset(); assert.doesNotMatch(commentaryPanel(g),/pawn to e4/);
});
test('disabled comments and HTML escaping work', () => {
  const g=new ChessGame(); g.playUci('e2e4');
  g.timeline[g.cursor].commentary={isVanta:true,text:'<script>alert("x")</script>'};
  assert.doesNotMatch(commentaryPanel(g),/<script>/);
  assert.match(commentaryPanel(g),/&lt;script&gt;/);
  assert.doesNotMatch(commentaryPanel(g,false),/alert/);
});

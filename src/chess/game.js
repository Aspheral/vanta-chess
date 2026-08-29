import { FLAGS, Position, moveToUci } from './position.js';
import { moveToSAN } from './san.js';
import { indexToSquare } from './constants.js';

export function repetitionKey(position) {
  const [board, turn, castling, ep] = position.toFEN().split(' ');
  // Under FIDE repetition rules, an en-passant target only changes the position
  // identity when an en-passant capture is actually legal.
  let repetitionEp = '-';
  if (ep !== '-' && position.legalMoves({ capturesOnly: true }).some(move => move.flags & FLAGS.EP_CAPTURE)) {
    repetitionEp = ep;
  }
  return `${board} ${turn} ${castling} ${repetitionEp}`;
}

export class ChessGame {
  constructor(fen = null) {
    this.timeline = [];
    this.cursor = 0;
    this.reset(fen);
  }

  reset(fen = null) {
    const position = fen ? Position.fromFEN(fen) : Position.start();
    this.timeline = [{ position, move: null, san: null, uci: null }];
    this.cursor = 0;
  }

  get position() { return this.timeline[this.cursor].position; }
  get canUndo() { return this.cursor > 0; }
  get canRedo() { return this.cursor < this.timeline.length - 1; }
  get history() { return this.timeline.slice(1, this.cursor + 1); }

  play(move) {
    const legal = this.position.legalMoves().find(m => m.from === move.from && m.to === move.to && (m.promotion || null) === (move.promotion || null));
    if (!legal) throw new Error('Illegal move.');
    const san = moveToSAN(this.position, legal);
    const next = this.position.makeMove(legal);
    if (this.canRedo) this.timeline.splice(this.cursor + 1);
    this.timeline.push({ position: next, move: legal, san, uci: moveToUci(legal) });
    this.cursor++;
    return { san, position: next, move: legal };
  }

  playUci(uci) {
    const move = this.position.moveFromUci(uci);
    if (!move) throw new Error(`Illegal move: ${uci}`);
    return this.play(move);
  }

  undo() { if (this.canUndo) this.cursor--; return this.position; }
  redo() { if (this.canRedo) this.cursor++; return this.position; }

  repetitionCount(position = this.position) {
    const key = repetitionKey(position);
    return this.timeline.slice(0, this.cursor + 1).filter(x => repetitionKey(x.position) === key).length;
  }

  wouldCauseRepetition(move, existingOccurrences = 1) {
    if (!move) return false;
    const legal = this.position.legalMoves().find(m => m.from === move.from && m.to === move.to && (m.promotion || null) === (move.promotion || null));
    if (!legal) return false;
    return this.repetitionCount(this.position.makeMove(legal)) >= existingOccurrences;
  }

  wouldCauseTwofold(move) {
    // If the resulting position has appeared once already, this move cycles
    // back to it for occurrence #2. It is not a draw yet, but it is a useful
    // progress signal when Vanta is already better.
    return this.wouldCauseRepetition(move, 1);
  }

  wouldCauseThreefold(move) {
    // If the resulting position has already appeared twice, making this move
    // creates occurrence #3 and therefore a claimable repetition draw.
    return this.wouldCauseRepetition(move, 2);
  }

  repetitionDrawMoves() {
    return this.position.legalMoves().filter(move => this.wouldCauseThreefold(move));
  }

  status() { return this.position.status(this.repetitionCount()); }

  moveRows() {
    const rows = [];
    for (let i = 1; i <= this.cursor; i += 2) {
      rows.push({ move: Math.ceil(i / 2), white: this.timeline[i]?.san || '', black: this.timeline[i + 1]?.san || '' });
    }
    return rows;
  }

  snapshot() {
    return {
      fen: this.position.toFEN(), cursor: this.cursor,
      history: this.history.map(h => ({ san: h.san, uci: h.uci })),
      lastMove: this.cursor ? { from: indexToSquare(this.timeline[this.cursor].move.from), to: indexToSquare(this.timeline[this.cursor].move.to) } : null,
    };
  }
}

import {
  BLACK, WHITE, START_FEN, FILES, BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS,
  KING_DELTAS, KNIGHT_DELTAS, colorOf, typeOf, opposite, inBounds,
  indexToSquare, rowCol, squareToIndex, pieceFor,
} from './constants.js';
import { hashPosition, pieceKey, castleKey, epKey, turnKey, normalizeHash } from './zobrist.js';

export const FLAGS = Object.freeze({
  CAPTURE: 1,
  EP_CAPTURE: 2,
  CASTLE_K: 4,
  CASTLE_Q: 8,
  PROMOTION: 16,
  PAWN_DOUBLE: 32,
});

export class Position {
  constructor({ board, turn = WHITE, castling = 'KQkq', epSquare = null, halfmove = 0, fullmove = 1, hash = null, _takeBoard = false } = {}) {
    // Public construction remains defensive: caller-owned arrays are copied.
    // Internal callers may transfer a freshly-created board with _takeBoard to
    // avoid cloning the same 64-square array twice on every search child.
    this.board = board ? (_takeBoard ? board : [...board]) : Position.fromFEN(START_FEN).board;
    this.turn = turn;
    this.castling = castling === '-' ? '' : castling;
    this.epSquare = epSquare;
    this.halfmove = halfmove;
    this.fullmove = fullmove;
    this.hash = hash == null ? hashPosition(this) : normalizeHash(hash);
  }

  static start() { return Position.fromFEN(START_FEN); }

  static fromFEN(fen) {
    const parts = fen.trim().split(/\s+/);
    if (parts.length < 4) throw new Error('FEN must contain at least 4 fields.');
    const [placement, turn, castling, ep, half = '0', full = '1'] = parts;
    if (!['w', 'b'].includes(turn)) throw new Error('Invalid side to move.');
    const rows = placement.split('/');
    if (rows.length !== 8) throw new Error('FEN placement must contain 8 ranks.');
    const board = [];
    for (const rank of rows) {
      let count = 0;
      for (const char of rank) {
        if (/\d/.test(char)) {
          const n = Number(char);
          if (n < 1 || n > 8) throw new Error('Invalid FEN digit.');
          for (let i = 0; i < n; i++) board.push(null);
          count += n;
        } else if ('prnbqkPRNBQK'.includes(char)) {
          board.push(char); count++;
        } else throw new Error(`Invalid FEN piece: ${char}`);
      }
      if (count !== 8) throw new Error('Each FEN rank must contain 8 squares.');
    }
    if (board.length !== 64) throw new Error('Invalid FEN board size.');
    const epSquare = ep === '-' ? null : squareToIndex(ep);
    if (ep !== '-' && epSquare == null) throw new Error('Invalid en-passant square.');
    return new Position({
      board,
      turn,
      castling: castling === '-' ? '' : castling,
      epSquare,
      halfmove: Number(half),
      fullmove: Number(full),
      _takeBoard: true,
    });
  }

  toFEN() {
    const ranks = [];
    for (let r = 0; r < 8; r++) {
      let text = '', empty = 0;
      for (let c = 0; c < 8; c++) {
        const p = this.board[r * 8 + c];
        if (!p) empty++;
        else {
          if (empty) text += empty;
          empty = 0;
          text += p;
        }
      }
      if (empty) text += empty;
      ranks.push(text);
    }
    return `${ranks.join('/')} ${this.turn} ${this.castling || '-'} ${this.epSquare == null ? '-' : indexToSquare(this.epSquare)} ${this.halfmove} ${this.fullmove}`;
  }

  clone() { return Position.fromFEN(this.toFEN()); }

  kingSquare(color) {
    const king = color === WHITE ? 'K' : 'k';
    return this.board.indexOf(king);
  }

  isSquareAttacked(square, byColor) {
    const [r, c] = rowCol(square);
    const pawnRow = byColor === WHITE ? r + 1 : r - 1;
    if (pawnRow >= 0 && pawnRow < 8) {
      for (const dc of [-1, 1]) {
        const pc = c + dc;
        if (inBounds(pawnRow, pc) && this.board[pawnRow * 8 + pc] === pieceFor(byColor, 'p')) return true;
      }
    }
    for (const [dr, dc] of KNIGHT_DELTAS) {
      const rr = r + dr, cc = c + dc;
      if (inBounds(rr, cc) && this.board[rr * 8 + cc] === pieceFor(byColor, 'n')) return true;
    }
    for (const [dr, dc] of KING_DELTAS) {
      const rr = r + dr, cc = c + dc;
      if (inBounds(rr, cc) && this.board[rr * 8 + cc] === pieceFor(byColor, 'k')) return true;
    }
    const scan = (dirs, types) => {
      for (const [dr, dc] of dirs) {
        let rr = r + dr, cc = c + dc;
        while (inBounds(rr, cc)) {
          const p = this.board[rr * 8 + cc];
          if (p) {
            if (colorOf(p) === byColor && types.includes(typeOf(p))) return true;
            break;
          }
          rr += dr; cc += dc;
        }
      }
      return false;
    };
    return scan(BISHOP_DIRS, ['b', 'q']) || scan(ROOK_DIRS, ['r', 'q']);
  }

  isInCheck(color = this.turn) {
    const king = this.kingSquare(color);
    return king >= 0 && this.isSquareAttacked(king, opposite(color));
  }

  pseudoMoves({ capturesOnly = false } = {}) {
    const moves = [];
    const us = this.turn;
    for (let from = 0; from < 64; from++) {
      const piece = this.board[from];
      if (!piece || colorOf(piece) !== us) continue;
      const type = typeOf(piece);
      const [r, c] = rowCol(from);
      const add = (to, flags = 0, promotion = null) => {
        const target = this.board[to];
        if (target && colorOf(target) === us) return;
        let f = flags;
        if (target && colorOf(target) !== us) f |= FLAGS.CAPTURE;
        if (capturesOnly && !(f & (FLAGS.CAPTURE | FLAGS.EP_CAPTURE)) && !promotion) return;
        moves.push({ from, to, piece, captured: target || null, promotion, flags: f });
      };
      if (type === 'p') {
        const dir = us === WHITE ? -1 : 1;
        const startRow = us === WHITE ? 6 : 1;
        const promoRow = us === WHITE ? 0 : 7;
        const oneR = r + dir;
        if (inBounds(oneR, c) && !this.board[oneR * 8 + c] && !capturesOnly) {
          const to = oneR * 8 + c;
          if (oneR === promoRow) for (const pr of ['q', 'r', 'b', 'n']) add(to, FLAGS.PROMOTION, pr);
          else add(to);
          const twoR = r + dir * 2;
          if (r === startRow && !this.board[twoR * 8 + c]) add(twoR * 8 + c, FLAGS.PAWN_DOUBLE);
        }
        for (const dc of [-1, 1]) {
          const rr = r + dir, cc = c + dc;
          if (!inBounds(rr, cc)) continue;
          const to = rr * 8 + cc;
          const target = this.board[to];
          if (target && colorOf(target) !== us) {
            if (rr === promoRow) for (const pr of ['q', 'r', 'b', 'n']) add(to, FLAGS.PROMOTION | FLAGS.CAPTURE, pr);
            else add(to, FLAGS.CAPTURE);
          } else if (to === this.epSquare) {
            moves.push({ from, to, piece, captured: pieceFor(opposite(us), 'p'), promotion: null, flags: FLAGS.EP_CAPTURE | FLAGS.CAPTURE });
          }
        }
      } else if (type === 'n' || type === 'k') {
        const deltas = type === 'n' ? KNIGHT_DELTAS : KING_DELTAS;
        for (const [dr, dc] of deltas) {
          const rr = r + dr, cc = c + dc;
          if (inBounds(rr, cc)) add(rr * 8 + cc);
        }
        if (type === 'k' && !capturesOnly) this.#castleMoves(from, moves);
      } else {
        const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
        for (const [dr, dc] of dirs) {
          let rr = r + dr, cc = c + dc;
          while (inBounds(rr, cc)) {
            const to = rr * 8 + cc;
            const target = this.board[to];
            if (!target) add(to);
            else {
              if (colorOf(target) !== us) add(to, FLAGS.CAPTURE);
              break;
            }
            rr += dr; cc += dc;
          }
        }
      }
    }
    return moves;
  }

  #castleMoves(from, moves) {
    const us = this.turn;
    const enemy = opposite(us);
    if (this.isInCheck(us)) return;
    if (us === WHITE && from === 60) {
      if (this.castling.includes('K') && this.board[61] == null && this.board[62] == null && this.board[63] === 'R' && !this.isSquareAttacked(61, enemy) && !this.isSquareAttacked(62, enemy)) {
        moves.push({ from: 60, to: 62, piece: 'K', captured: null, promotion: null, flags: FLAGS.CASTLE_K });
      }
      if (this.castling.includes('Q') && this.board[59] == null && this.board[58] == null && this.board[57] == null && this.board[56] === 'R' && !this.isSquareAttacked(59, enemy) && !this.isSquareAttacked(58, enemy)) {
        moves.push({ from: 60, to: 58, piece: 'K', captured: null, promotion: null, flags: FLAGS.CASTLE_Q });
      }
    } else if (us === BLACK && from === 4) {
      if (this.castling.includes('k') && this.board[5] == null && this.board[6] == null && this.board[7] === 'r' && !this.isSquareAttacked(5, enemy) && !this.isSquareAttacked(6, enemy)) {
        moves.push({ from: 4, to: 6, piece: 'k', captured: null, promotion: null, flags: FLAGS.CASTLE_K });
      }
      if (this.castling.includes('q') && this.board[3] == null && this.board[2] == null && this.board[1] == null && this.board[0] === 'r' && !this.isSquareAttacked(3, enemy) && !this.isSquareAttacked(2, enemy)) {
        moves.push({ from: 4, to: 2, piece: 'k', captured: null, promotion: null, flags: FLAGS.CASTLE_Q });
      }
    }
  }

  legalMoves(opts = {}) {
    const us = this.turn;
    return this.pseudoMoves(opts).filter(move => !this.makeMove(move).isInCheck(us));
  }

  makeMove(move) {
    const board = [...this.board];
    const us = this.turn;
    const piece = board[move.from];
    const target = board[move.to];
    let hash = this.hash ^ pieceKey(piece, move.from) ^ castleKey(this.castling) ^ epKey(this.epSquare) ^ turnKey();
    board[move.from] = null;
    if (target) hash ^= pieceKey(target, move.to);
    if (move.flags & FLAGS.EP_CAPTURE) {
      const capSq = move.to + (us === WHITE ? 8 : -8);
      const capturedEp = board[capSq];
      if (capturedEp) hash ^= pieceKey(capturedEp, capSq);
      board[capSq] = null;
    }
    const placed = move.promotion ? pieceFor(us, move.promotion) : piece;
    board[move.to] = placed;
    hash ^= pieceKey(placed, move.to);
    if (move.flags & FLAGS.CASTLE_K) {
      if (us === WHITE) { hash ^= pieceKey('R',63) ^ pieceKey('R',61); board[63] = null; board[61] = 'R'; }
      else { hash ^= pieceKey('r',7) ^ pieceKey('r',5); board[7] = null; board[5] = 'r'; }
    }
    if (move.flags & FLAGS.CASTLE_Q) {
      if (us === WHITE) { hash ^= pieceKey('R',56) ^ pieceKey('R',59); board[56] = null; board[59] = 'R'; }
      else { hash ^= pieceKey('r',0) ^ pieceKey('r',3); board[0] = null; board[3] = 'r'; }
    }
    let castling = this.castling;
    const strip = chars => { for (const ch of chars) castling = castling.replace(ch, ''); };
    if (piece === 'K') strip('KQ');
    if (piece === 'k') strip('kq');
    if (move.from === 63 || move.to === 63) strip('K');
    if (move.from === 56 || move.to === 56) strip('Q');
    if (move.from === 7 || move.to === 7) strip('k');
    if (move.from === 0 || move.to === 0) strip('q');
    const epSquare = move.flags & FLAGS.PAWN_DOUBLE ? (move.from + move.to) >> 1 : null;
    hash ^= castleKey(castling) ^ epKey(epSquare);
    const pawnMove = typeOf(piece) === 'p';
    const capture = Boolean(target) || Boolean(move.flags & FLAGS.EP_CAPTURE);
    return new Position({
      board,
      turn: opposite(us),
      castling,
      epSquare,
      halfmove: pawnMove || capture ? 0 : this.halfmove + 1,
      fullmove: this.fullmove + (us === BLACK ? 1 : 0),
      hash,
      _takeBoard: true,
    });
  }

  moveFromUci(uci) {
    const match = /^([a-h][1-8])([a-h][1-8])([qrbn])?$/.exec(uci);
    if (!match) return null;
    const from = squareToIndex(match[1]), to = squareToIndex(match[2]), promotion = match[3] || null;
    return this.legalMoves().find(m => m.from === from && m.to === to && (m.promotion || null) === promotion) || null;
  }

  status(repetitionCount = 1) {
    const legal = this.legalMoves();
    if (legal.length === 0) {
      if (this.isInCheck()) return { over: true, result: this.turn === WHITE ? '0-1' : '1-0', reason: 'checkmate' };
      return { over: true, result: '1/2-1/2', reason: 'stalemate' };
    }
    if (this.halfmove >= 100) return { over: true, result: '1/2-1/2', reason: 'fifty-move rule' };
    if (repetitionCount >= 3) return { over: true, result: '1/2-1/2', reason: 'threefold repetition' };
    if (this.isInsufficientMaterial()) return { over: true, result: '1/2-1/2', reason: 'insufficient material' };
    return { over: false, result: '*', reason: null };
  }

  isInsufficientMaterial() {
    const pieces = this.board.map((p, i) => ({ p, i })).filter(x => x.p);
    const nonKings = pieces.filter(x => typeOf(x.p) !== 'k');
    if (nonKings.length === 0) return true;
    if (nonKings.length === 1 && ['b', 'n'].includes(typeOf(nonKings[0].p))) return true;
    if (nonKings.every(x => typeOf(x.p) === 'b')) {
      const colors = new Set(nonKings.map(x => {
        const [r, c] = rowCol(x.i); return (r + c) & 1;
      }));
      return colors.size === 1;
    }
    return false;
  }

  validate() {
    const errors = [];
    if (this.board.filter(p => p === 'K').length !== 1) errors.push('Position must contain exactly one white king.');
    if (this.board.filter(p => p === 'k').length !== 1) errors.push('Position must contain exactly one black king.');
    const wk = this.kingSquare(WHITE), bk = this.kingSquare(BLACK);
    if (wk >= 0 && bk >= 0) {
      const [wr, wc] = rowCol(wk), [br, bc] = rowCol(bk);
      if (Math.max(Math.abs(wr - br), Math.abs(wc - bc)) <= 1) errors.push('Kings may not be adjacent.');
    }
    for (let i = 0; i < 8; i++) {
      if (['P', 'p'].includes(this.board[i]) || ['P', 'p'].includes(this.board[56 + i])) errors.push('Pawns may not be placed on the first or eighth rank.');
    }
    return errors;
  }
}

export function moveToUci(move) {
  return `${indexToSquare(move.from)}${indexToSquare(move.to)}${move.promotion || ''}`;
}

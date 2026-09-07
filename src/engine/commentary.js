import { colorOf, typeOf, opposite, indexToSquare, squareToIndex } from '../chess/constants.js';
import { FLAGS, moveToUci } from '../chess/position.js';
import { moveToSAN } from '../chess/san.js';

const names = { p: 'pawn', n: 'knight', b: 'bishop', r: 'rook', q: 'queen', k: 'king' };
const list = items => items.length < 2 ? items[0] : items.slice(0, -1).join(', ') + ' and ' + items.at(-1);

// Geometric pressure, not a promise of a legal capture or a winning tactic.
function attacks(position, from, to) {
  const piece = position.board[from];
  if (!piece || from === to) return false;
  const dr = Math.floor(to / 8) - Math.floor(from / 8), dc = to % 8 - from % 8;
  const ar = Math.abs(dr), ac = Math.abs(dc), type = typeOf(piece);
  if (type === 'p') return dr === (colorOf(piece) === 'w' ? -1 : 1) && ac === 1;
  if (type === 'n') return ar * ac === 2;
  if (type === 'k') return Math.max(ar, ac) === 1;
  if (!(type === 'b' && ar === ac || type === 'r' && (!dr || !dc) || type === 'q' && (ar === ac || !dr || !dc))) return false;
  const step = Math.sign(dr) * 8 + Math.sign(dc);
  for (let i = from + step; i !== to; i += step) if (position.board[i]) return false;
  return true;
}

export class MoveCommentator {
  constructor(random = Math.random) { this.random = random; this.recent = new Map(); }

  pick(key, choices) {
    const used = this.recent.get(key) || [];
    const available = choices.filter((_, i) => !used.includes(i));
    const choice = available[Math.min(available.length - 1, Math.floor(this.random() * available.length))];
    const index = choices.indexOf(choice);
    this.recent.set(key, [...used, index].slice(-Math.min(5, choices.length - 1)));
    return choice;
  }

  explain(before, move, { isVanta = true, pv = [], status = null } = {}) {
    const after = before.makeMove(move);
    const end = status || after.status();
    const color = before.turn, enemy = opposite(color), type = typeOf(move.piece);
    const square = indexToSquare(move.to), piece = names[type];
    const label = `${piece} to ${square}`;
    const san = moveToSAN(before, move);
    const facts = [];
    const add = (key, choices) => facts.push(this.pick(key, choices));
    const check = after.isInCheck(enemy);
    const targets = after.board.flatMap((p, i) => p && colorOf(p) === enemy && typeOf(p) !== 'k' && typeOf(p) !== 'p' && attacks(after, move.to, i) ? [`the ${names[typeOf(p)]} on ${indexToSquare(i)}`] : []);
    const central = ['d4', 'e4', 'd5', 'e5'].filter(s => attacks(after, move.to, squareToIndex(s)));
    const notable = end.over || check || move.captured || move.promotion || targets.length || (move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q));
    if (!isVanta && !notable) return null;

    const intro = isVanta ? this.pick('intro', [
      `I'm going with ${label}.`, `Now, ${label}.`, `I've played ${label}.`,
      `${label[0].toUpperCase() + label.slice(1)} is my choice here.`, `My move is ${label}.`,
      `I'll put my ${piece} on ${square}.`, `Here's the idea behind ${san}.`,
      `Let's look at ${label}.`, `With ${san}, my ${piece} lands on ${square}.`,
      `I've chosen ${san}; here's what changes.`, `Time for ${label}.`,
      `The move on the board is ${san}.`
    ]) : this.pick('opponentIntro', [
      `That ${label} deserves a look.`, `The opponent has played ${san}.`,
      `I need to take account of ${label}.`, `Let's unpack the opponent's ${san}.`,
      `There is a concrete point to ${label}.`, `After their ${san}, the position changes.`,
      `Their ${piece} has arrived on ${square}.`, `That was ${san}; here's what matters.`
    ]);

    if (end.over) {
      if (end.reason === 'checkmate') add('mate', ['That is checkmate: the king has no legal escape.', 'Checkmate—the checked side has no legal reply.', 'This ends the game with checkmate.', 'The king is in check, and no legal move can answer it.']);
      else add('draw', [`The game ends in a draw by ${end.reason}.`, `That brings a draw by ${end.reason}.`, `The result is a draw: ${end.reason}.`]);
      return { san, isVanta, text: intro + ' ' + facts[0] };
    }
    if (check) add('check', ['It gives check, so the king threat must be answered.', 'The opposing king is in check; that takes priority over other plans.', 'This is a forcing check: the reply has to resolve it.', 'The immediate point is check against the opposing king.', 'It puts the king in check and narrows the available replies.', 'The other side must deal with the check before pursuing anything else.']);
    if (move.promotion) {
      const promoted = names[move.promotion];
      add('promotion', [`The pawn promotes to a ${promoted}.`, `That pawn has reached the last rank and become a ${promoted}.`, `Promotion brings a new ${promoted} onto the board.`, `The advance converts the pawn into a ${promoted}.`]);
    }
    if (move.captured) {
      const captured = names[typeOf(move.captured)];
      add('capture', move.flags & FLAGS.EP_CAPTURE ? [
        'It takes the pawn en passant, removing it from the adjacent file.',
        'This is an en-passant capture of the pawn that just advanced two squares.',
        'The capture is en passant: the pawn beside the destination comes off the board.'
      ] : [`It captures the ${captured} on ${square}.`, `The opposing ${captured} on ${square} comes off the board.`, `The immediate result is the capture of that ${captured}.`, `This takes the ${captured} that occupied ${square}.`, `The move removes the opposing ${captured} from ${square}.`, `At once, it picks off the ${captured} on ${square}.`]);
    }
    if (move.flags & (FLAGS.CASTLE_K | FLAGS.CASTLE_Q)) add('castle', ['Castling brings the rook toward the center and moves the king off its starting square.', 'The king and rook both relocate with this castle.', 'This completes castling and brings the rook into a more central file.', 'With castling, the rook comes inward while the king moves toward the flank.']);
    if (targets.length) {
      const target = list(targets.slice(0, 2));
      add('pressure', [`From ${square}, it puts pressure on ${target}.`, `The ${piece} now bears on ${target}.`, `Notice its line of attack toward ${target}.`, `It now eyes ${target} from ${square}.`, `One point is the pressure it directs at ${target}.`, `The new square brings ${target} into its sights.`, `Its reach from ${square} includes ${target}.`, `There is now direct pressure from this piece toward ${target}.`]);
    }
    if (central.length) {
      const center = list(central);
      add('center', [`It controls ${center} in the center.`, `From here, it influences the central ${central.length > 1 ? 'squares' : 'square'} ${center}.`, `Its central reach includes ${center}.`, `It bears on ${center}, adding a presence in the center.`, `A useful feature is its control of ${center}.`, `The central point is pressure on ${center}.`, `It keeps ${center} within reach.`, `The piece's influence now extends to ${center} in the center.`]);
    }
    if (['n', 'b'].includes(type) && Math.floor(move.from / 8) === (color === 'w' ? 7 : 0) && Math.floor(move.to / 8) !== Math.floor(move.from / 8)) add('development', ['It brings a minor piece off the back rank.', 'This develops a minor piece away from its home rank.', 'Another minor piece leaves the back rank and joins the play.', 'The move gets a minor piece out from the back row.', 'Development is part of the idea: this piece leaves its home rank.']);
    if (type === 'p' && !move.captured && !move.promotion) {
      const flank = move.to % 8 < 3 ? 'queenside' : move.to % 8 > 4 ? 'kingside' : 'center';
      add('pawn', [`The pawn advances on the ${flank}.`, `This pushes the pawn farther forward on the ${flank}.`, `The move shifts the pawn front on the ${flank}.`, `That is a pawn advance on the ${flank} to ${square}.`, `The pawn now stands farther up the ${flank}.`]);
    }
    if (!facts.length) add('quiet', [`It repositions the ${piece} from ${indexToSquare(move.from)} to ${square}; there is no immediate check or capture.`, 'This is a quiet repositioning move, with no immediate check or capture.', `The idea starts with relocating the ${piece}; the next step depends on the reply.`, 'This changes the piece placement without forcing an immediate check response.', `The ${piece} has a new post on ${square}; concrete follow-ups depend on the reply.`, 'It adjusts the position quietly, without a capture or check.']);

    // Only narrate a continuation rooted in the move actually played.
    let continuation = '';
    if (isVanta && pv[0] === moveToUci(move) && pv.length >= 3) {
      const reply = after.moveFromUci(pv[1]);
      if (reply) {
        const next = after.makeMove(reply), follow = next.moveFromUci(pv[2]);
        if (follow) {
          const r = moveToSAN(after, reply), f = moveToSAN(next, follow);
          continuation = this.pick('line', [
            `If the reply is ${r}, one calculated continuation is ${f}.`,
            `A line I'm considering is ${r}, then ${f}; the reply is not forced.`,
            `Against ${r}, my current line continues with ${f}.`,
            `One possibility is ${r}, when I can answer with ${f}.`,
            `The calculation includes ${r} followed by ${f}, depending on their choice.`,
            `If they choose ${r}, I have ${f} in the calculated line.`
          ]);
        }
      }
    }
    return { san, isVanta, text: [intro, ...facts.slice(0, 2), continuation].filter(Boolean).join(' ') };
  }
}

// Keep comments on timeline entries, so undo/redo and alternate lines stay aligned.
export function recordCommentary(game, generator, before, move, options) {
  const entry = generator.explain(before, move, { ...options, status: game.status() });
  game.timeline[game.cursor].commentary = entry;
  return entry;
}

export function commentaryPanel(game, enabled = true) {
  const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
  const entries = game.history.filter(e => e.commentary).slice(-4).reverse();
  return `<section class="panel commentary-panel" aria-label="Vanta commentary"><div class="panel-head"><span class="panel-title">Vanta's thoughts</span><button class="btn" data-commentary-toggle aria-pressed="${enabled}">${enabled ? 'On' : 'Off'}</button></div><div class="commentary-feed" role="log" aria-live="polite" aria-relevant="additions text">${!enabled ? '<p class="empty">Move commentary is off.</p>' : entries.length ? entries.map(e => `<article class="commentary-entry"><b>${e.commentary.isVanta ? 'Vanta' : 'On the opponent'} · ${escape(e.san)}</b><p>${escape(e.commentary.text)}</p></article>`).join('') : '<p class="empty">Vanta will explain its moves and weigh in on noteworthy replies.</p>'}</div><div class="panel-head"><span class="panel-sub">Local chess-aware commentary</span></div></section>`;
}

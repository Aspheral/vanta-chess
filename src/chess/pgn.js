import { ChessGame } from './game.js';
import { moveToSAN } from './san.js';

function stripVariations(text) {
  let out = '', depth = 0;
  for (const ch of text) {
    if (ch === '(') { depth++; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue; }
    if (!depth) out += ch;
  }
  return out;
}

function normalizeSan(san) {
  return String(san)
    .trim()
    .replace(/[!?]+$/g, '')
    .replace(/0-0-0/g, 'O-O-O')
    .replace(/0-0/g, 'O-O')
    .replace(/[+#]+$/g, '');
}

export function tokenizePgn(pgn) {
  let text = String(pgn)
    .replace(/^\s*\[[^\]]*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/gs, ' ')
    .replace(/;[^\n]*/g, ' ');
  text = stripVariations(text)
    .replace(/\$\d+/g, ' ')
    .replace(/\d+\.(?:\.\.)?/g, ' ');
  return text.split(/\s+/).map(x => x.trim()).filter(Boolean)
    .filter(token => !['1-0','0-1','1/2-1/2','*'].includes(token));
}

export function moveFromSan(position, san) {
  const target = normalizeSan(san);
  const matches = position.legalMoves().filter(move => normalizeSan(moveToSAN(position, move)) === target);
  if (matches.length !== 1) {
    throw new Error(`Could not uniquely resolve SAN ${san} in ${position.toFEN()} (${matches.length} matches)`);
  }
  return matches[0];
}

export function replayPgn(pgn, startFen = null) {
  const game = new ChessGame(startFen);
  const positions = [game.position.toFEN()];
  const plies = [];
  for (const san of tokenizePgn(pgn)) {
    const beforeFen = game.position.toFEN();
    const move = moveFromSan(game.position, san);
    const played = game.play(move);
    plies.push({ san: played.san, uci: game.history.at(-1).uci, beforeFen, afterFen: game.position.toFEN() });
    positions.push(game.position.toFEN());
  }
  return { game, plies, positions };
}

export function fenBeforePly(replay, plyNumber) {
  if (!Number.isInteger(plyNumber) || plyNumber < 1 || plyNumber > replay.plies.length) throw new Error(`Invalid ply ${plyNumber}`);
  return replay.plies[plyNumber - 1].beforeFen;
}

export function fenAfterPly(replay, plyNumber) {
  if (!Number.isInteger(plyNumber) || plyNumber < 1 || plyNumber > replay.plies.length) throw new Error(`Invalid ply ${plyNumber}`);
  return replay.plies[plyNumber - 1].afterFen;
}

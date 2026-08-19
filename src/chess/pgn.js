import { ChessGame } from './game.js';
import { moveToSAN } from './san.js';

export function tokenizePgn(pgn) {
  let text = String(pgn || '')
    .replace(/^\s*\[[^\]]*\]\s*$/gm, ' ')
    .replace(/\{[^}]*\}/gs, ' ')
    .replace(/;[^\n]*/g, ' ');
  while (/\([^()]*\)/s.test(text)) text = text.replace(/\([^()]*\)/gs, ' ');
  text = text.replace(/\d+\.(?:\.\.)?/g, ' ');
  return text.split(/\s+/)
    .map(token => token.trim())
    .filter(Boolean)
    .filter(token => !['1-0', '0-1', '1/2-1/2', '*'].includes(token));
}

function normalizeSan(san) {
  return String(san)
    .replace(/^0-0-0/, 'O-O-O')
    .replace(/^0-0/, 'O-O')
    .replace(/[!?]+$/g, '')
    .replace(/e\.p\.?$/i, '')
    .trim();
}

export function parseSan(position, san) {
  const wanted = normalizeSan(san);
  const legal = position.legalMoves();
  const matches = legal.filter(move => normalizeSan(moveToSAN(position, move)) === wanted);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) throw new Error(`Ambiguous SAN: ${san}`);

  // Be lenient about a missing check/mate suffix in imported PGNs.
  const loose = wanted.replace(/[+#]$/g, '');
  const looseMatches = legal.filter(move => normalizeSan(moveToSAN(position, move)).replace(/[+#]$/g, '') === loose);
  if (looseMatches.length === 1) return looseMatches[0];
  throw new Error(`Illegal or unsupported SAN ${san} in ${position.toFEN()}`);
}

export function parsePgn(pgn, fen = null) {
  const game = new ChessGame(fen);
  const plies = [];
  for (const token of tokenizePgn(pgn)) {
    const before = game.position.toFEN();
    const move = parseSan(game.position, token);
    const played = game.play(move);
    plies.push({
      token,
      san: played.san,
      uci: game.history.at(-1).uci,
      before,
      after: game.position.toFEN(),
    });
  }
  return { game, plies };
}

export function positionBeforeSan(parsed, san, occurrence = 1) {
  let seen = 0;
  for (const ply of parsed.plies) {
    if (normalizeSan(ply.san) === normalizeSan(san)) {
      seen++;
      if (seen === occurrence) return ply.before;
    }
  }
  throw new Error(`SAN not found: ${san} occurrence ${occurrence}`);
}

export function positionAfterSan(parsed, san, occurrence = 1) {
  let seen = 0;
  for (const ply of parsed.plies) {
    if (normalizeSan(ply.san) === normalizeSan(san)) {
      seen++;
      if (seen === occurrence) return ply.after;
    }
  }
  throw new Error(`SAN not found: ${san} occurrence ${occurrence}`);
}

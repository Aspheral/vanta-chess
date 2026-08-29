import {
  WHITE, BLACK, colorOf, typeOf, rowCol, opposite,
  BISHOP_DIRS, ROOK_DIRS, QUEEN_DIRS, KNIGHT_DELTAS, inBounds,
} from '../chess/constants.js';

const HOME = Object.freeze({
  [WHITE]: Object.freeze({
    minors: Object.freeze([[57, 'N'], [62, 'N'], [58, 'B'], [61, 'B']]),
    queen: 59,
    queenPiece: 'Q',
    king: 60,
    castles: Object.freeze([62, 58]),
  }),
  [BLACK]: Object.freeze({
    minors: Object.freeze([[1, 'n'], [6, 'n'], [2, 'b'], [5, 'b']]),
    queen: 3,
    queenPiece: 'q',
    king: 4,
    castles: Object.freeze([6, 2]),
  }),
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function attacksSquare(position, from, target) {
  const piece = position.board[from];
  if (!piece) return false;
  const type = typeOf(piece);
  const color = colorOf(piece);
  const [fr, fc] = rowCol(from);
  const [tr, tc] = rowCol(target);
  const dr = tr - fr;
  const dc = tc - fc;

  if (type === 'p') {
    const forward = color === WHITE ? -1 : 1;
    return dr === forward && Math.abs(dc) === 1;
  }
  if (type === 'n') {
    return KNIGHT_DELTAS.some(([r, c]) => r === dr && c === dc);
  }
  if (type === 'k') {
    return Math.max(Math.abs(dr), Math.abs(dc)) === 1;
  }

  const dirs = type === 'b' ? BISHOP_DIRS : type === 'r' ? ROOK_DIRS : QUEEN_DIRS;
  for (const [stepR, stepC] of dirs) {
    if (stepR === 0 && dr !== 0) continue;
    if (stepC === 0 && dc !== 0) continue;
    if (stepR !== 0 && stepC !== 0 && Math.abs(dr) !== Math.abs(dc)) continue;
    if (dr !== 0 && Math.sign(dr) !== Math.sign(stepR)) continue;
    if (dc !== 0 && Math.sign(dc) !== Math.sign(stepC)) continue;

    let r = fr + stepR;
    let c = fc + stepC;
    while (inBounds(r, c)) {
      const sq = r * 8 + c;
      if (sq === target) return true;
      if (position.board[sq]) break;
      r += stepR;
      c += stepC;
    }
  }
  return false;
}

function kingZone(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return [];
  const [r, c] = rowCol(king);
  const zone = [king];
  for (let rr = r - 1; rr <= r + 1; rr++) {
    for (let cc = c - 1; cc <= c + 1; cc++) {
      if (inBounds(rr, cc)) zone.push(rr * 8 + cc);
    }
  }
  return [...new Set(zone)];
}

function developedMinorStats(position, color) {
  const home = HOME[color];
  let surviving = 0;
  let active = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || !['n', 'b'].includes(typeOf(piece))) continue;
    surviving++;
    const homeMatch = home.minors.some(([homeSq, homePiece]) => homeSq === sq && homePiece === piece);
    if (!homeMatch) active++;
  }

  // The army starts with four minor-piece slots. A captured knight or bishop
  // must never make the remaining pieces look more developed by shrinking the
  // denominator. Losing a soldier is not mobilizing one.
  const originalSlots = home.minors.length;
  return {
    surviving,
    active,
    casualties: Math.max(0, originalSlots - surviving),
    unmobilized: Math.max(0, originalSlots - active),
    ratio: clamp(active / originalSlots, 0, 1),
  };
}

function rookConnection(position, color) {
  const rooks = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = position.board[sq];
    if (p && colorOf(p) === color && typeOf(p) === 'r') rooks.push(sq);
  }
  if (rooks.length < 2) return 0;
  for (let i = 0; i < rooks.length; i++) {
    for (let j = i + 1; j < rooks.length; j++) {
      const [r1, c1] = rowCol(rooks[i]);
      const [r2, c2] = rowCol(rooks[j]);
      if (r1 !== r2) continue;
      let clear = true;
      for (let c = Math.min(c1, c2) + 1; c < Math.max(c1, c2); c++) {
        if (position.board[r1 * 8 + c]) { clear = false; break; }
      }
      if (clear) return 1;
    }
  }
  return 0;
}

function centralInfluence(position, color) {
  const center = [27, 28, 35, 36];
  let hits = 0;
  for (let from = 0; from < 64; from++) {
    const p = position.board[from];
    if (!p || colorOf(p) !== color) continue;
    for (const target of center) if (attacksSquare(position, from, target)) hits++;
  }
  return clamp(hits / 7, 0, 1);
}

function attackerParticipation(position, color) {
  const enemy = opposite(color);
  const zone = kingZone(position, enemy);
  if (!zone.length) return { attackers: 0, heavyAttackers: 0, ratio: 0 };

  let attackers = 0;
  let heavyAttackers = 0;
  let available = 0;
  for (let from = 0; from < 64; from++) {
    const p = position.board[from];
    if (!p || colorOf(p) !== color) continue;
    const type = typeOf(p);
    if (!['q', 'r', 'b', 'n'].includes(type)) continue;
    available++;
    if (zone.some(target => attacksSquare(position, from, target))) {
      attackers++;
      if (type === 'q' || type === 'r') heavyAttackers++;
    }
  }

  return {
    attackers,
    heavyAttackers,
    ratio: clamp(attackers / Math.max(3, available), 0, 1),
  };
}

function kingReadiness(position, color) {
  const h = HOME[color];
  const king = position.kingSquare(color);
  if (h.castles.includes(king)) return 1;
  if (king !== h.king) return 0.55;

  const rights = color === WHITE ? ['K', 'Q'] : ['k', 'q'];
  const hasRights = rights.some(right => position.castling.includes(right));
  if (!hasRights) return 0.2;

  const kingsideClear = color === WHITE
    ? !position.board[61] && !position.board[62]
    : !position.board[5] && !position.board[6];
  const queensideClear = color === WHITE
    ? !position.board[57] && !position.board[58] && !position.board[59]
    : !position.board[1] && !position.board[2] && !position.board[3];
  return kingsideClear || queensideClear ? 0.78 : 0.45;
}

function queenParticipation(position, color) {
  const h = HOME[color];
  if (position.board[h.queen] === h.queenPiece) return 0;
  if (position.board.includes(h.queenPiece)) return 1;
  return 0.35;
}

/**
 * Army readiness, not tactical danger. The question is whether enough pieces
 * are developed and coordinated for Vanta to switch from mobilization into a
 * full assault without confusing a lone-piece adventure for an attack.
 */
export function attackReadiness(position, color = position.turn) {
  const minors = developedMinorStats(position, color);
  const king = kingReadiness(position, color);
  const rooks = rookConnection(position, color);
  const center = centralInfluence(position, color);
  const participation = attackerParticipation(position, color);
  const queen = queenParticipation(position, color);

  let score = minors.ratio * 36
    + king * 22
    + rooks * 10
    + center * 12
    + queen * 6
    + participation.ratio * 14;

  // Casualties can never unlock assault mode. The material evaluator already
  // prices the lost piece, so this is only an anti-inflation guard for style.
  if (minors.casualties) score -= Math.min(14, minors.casualties * 7);
  if (minors.active < 3) score = Math.min(score, 64);
  if (king < 0.45) score = Math.min(score, 68);

  score = Math.round(clamp(score, 0, 100));
  const phase = score >= 78 ? 'assault' : score >= 62 ? 'pressure' : 'mobilize';

  // This multiplier is deliberately bounded. Hyper-aggression should mean
  // "prefer the sharpest objectively competitive line after mobilization",
  // not "erase the evaluation because the army looks exciting". Search and
  // the root tactical-risk seatbelt remain authoritative.
  const assaultMultiplier = phase === 'assault'
    ? 1.0 + ((score - 78) / 22) * 0.35
    : phase === 'pressure'
      ? 0.8 + ((score - 62) / 16) * 0.2
      : 0.5 + (score / 62) * 0.25;

  return {
    score,
    phase,
    assaultMultiplier: Number(assaultMultiplier.toFixed(3)),
    developedMinors: minors.active,
    survivingMinors: minors.surviving,
    minorCasualties: minors.casualties,
    unmobilizedMinorSlots: minors.unmobilized,
    minorDevelopmentRatio: Number(minors.ratio.toFixed(3)),
    kingReadiness: Number(king.toFixed(3)),
    rooksConnected: Boolean(rooks),
    centralInfluence: Number(center.toFixed(3)),
    queenParticipating: queen >= 0.99,
    attackers: participation.attackers,
    heavyAttackers: participation.heavyAttackers,
    attackerRatio: Number(participation.ratio.toFixed(3)),
  };
}

/**
 * Readiness is a root style signal rather than a second positional evaluator.
 * Development, activity and king safety already live in evaluate(). Returning
 * zero here prevents double-counting them at every leaf and ensures sacrifices
 * still need search-demonstrated compensation.
 */
export function coordinatedAssaultValue(_position, _color) {
  return 0;
}

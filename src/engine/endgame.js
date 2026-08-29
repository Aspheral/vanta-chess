import {
  WHITE, BLACK, PIECE_VALUES, colorOf, typeOf, rowCol, opposite, pieceFor,
} from '../chess/constants.js';
import { FLAGS } from '../chess/position.js';

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function chebyshev(a, b) {
  const [ar, ac] = rowCol(a), [br, bc] = rowCol(b);
  return Math.max(Math.abs(ar - br), Math.abs(ac - bc));
}

function pawnProgress(square, color) {
  const [row] = rowCol(square);
  return color === WHITE ? 6 - row : row - 1;
}

function promotionSquare(square, color) {
  const [, file] = rowCol(square);
  return (color === WHITE ? 0 : 56) + file;
}

function frontSquare(square, color) {
  const [row, file] = rowCol(square);
  const nextRow = row + (color === WHITE ? -1 : 1);
  if (nextRow < 0 || nextRow > 7) return null;
  return nextRow * 8 + file;
}

export function isPassedPawn(position, square, color = colorOf(position.board[square])) {
  const piece = position.board[square];
  if (!piece || typeOf(piece) !== 'p' || colorOf(piece) !== color) return false;
  const [row, file] = rowCol(square);
  const dir = color === WHITE ? -1 : 1;
  const enemyPawn = pieceFor(opposite(color), 'p');
  for (const f of [file - 1, file, file + 1]) {
    if (f < 0 || f > 7) continue;
    for (let r = row + dir; r >= 0 && r < 8; r += dir) {
      if (position.board[r * 8 + f] === enemyPawn) return false;
    }
  }
  return true;
}

function materialProfile(position) {
  let nonPawnMaterial = 0;
  let queens = 0;
  let rooks = 0;
  let minors = 0;
  let pawns = 0;
  for (const piece of position.board) {
    if (!piece) continue;
    const type = typeOf(piece);
    if (type === 'p') { pawns++; continue; }
    if (type === 'k') continue;
    nonPawnMaterial += PIECE_VALUES[type] || 0;
    if (type === 'q') queens++;
    else if (type === 'r') rooks++;
    else if (type === 'n' || type === 'b') minors++;
  }
  return { nonPawnMaterial, queens, rooks, minors, pawns };
}

const OPENING_PHASE = Object.freeze({
  nonPawnMaterial: 6400,
  queens: 2,
  rooks: 4,
  minors: 8,
  pawns: 16,
  weight: 0,
  active: false,
  deep: false,
});

/**
 * The specialist begins where the opening-development model ends. This is both
 * conceptually cleaner and important for speed: scanning material and passer
 * geometry at every shallow opening node was costing practical depth without
 * providing any endgame information.
 */
export function endgamePhase(position) {
  if (position.fullmove <= 14) return OPENING_PHASE;

  const profile = materialProfile(position);
  let weight;
  if (profile.queens === 0) {
    weight = clamp((4000 - profile.nonPawnMaterial) / 2600, 0, 1);
    if (profile.rooks + profile.minors <= 4) weight = Math.max(weight, 0.68);
    if (profile.rooks + profile.minors <= 2) weight = Math.max(weight, 0.88);
  } else {
    weight = clamp((2350 - profile.nonPawnMaterial) / 1650, 0, 1);
  }
  return {
    ...profile,
    weight: Number(weight.toFixed(3)),
    active: weight >= 0.34,
    deep: weight >= 0.72,
  };
}

function kingCentrality(square) {
  if (square < 0) return 0;
  const centers = [27, 28, 35, 36];
  const distance = Math.min(...centers.map(center => chebyshev(square, center)));
  return 3 - Math.min(3, distance);
}

function kingActivityFor(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return -500;
  const [row] = rowCol(king);
  const penetration = color === WHITE ? Math.max(0, 4 - row) : Math.max(0, row - 3);
  return kingCentrality(king) * 13 + penetration * 4;
}

function kingPawnCohesionFor(position, color) {
  const king = position.kingSquare(color);
  if (king < 0) return 0;
  let score = 0;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) !== 'p') continue;
    const distance = chebyshev(king, sq);
    if (distance === 1) score += 9;
    else if (distance === 2) score += 3;
  }
  return score;
}

function rooksBehindPasser(position, color, pawnSquare) {
  const [, file] = rowCol(pawnSquare);
  const [pawnRow] = rowCol(pawnSquare);
  let count = 0;
  for (let row = 0; row < 8; row++) {
    const sq = row * 8 + file;
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) !== 'r') continue;
    const behind = color === WHITE ? row > pawnRow : row < pawnRow;
    if (behind) count++;
  }
  return count;
}

function passerValueFor(position, color) {
  const ownKing = position.kingSquare(color);
  const enemy = opposite(color);
  const enemyKing = position.kingSquare(enemy);
  let score = 0;

  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== color || typeOf(piece) !== 'p' || !isPassedPawn(position, sq, color)) continue;
    const progress = clamp(pawnProgress(sq, color), 0, 6);
    if (progress < 1) continue;

    const ownDistance = ownKing >= 0 ? chebyshev(ownKing, sq) : 7;
    const enemyDistance = enemyKing >= 0 ? chebyshev(enemyKing, sq) : 7;
    const supportScale = 0.55 + progress / 8;
    score += Math.round(clamp(enemyDistance - ownDistance, -4, 4) * 6 * supportScale);

    const front = frontSquare(sq, color);
    if (front != null) {
      const blocker = position.board[front];
      if (blocker && colorOf(blocker) === enemy) {
        const blockType = typeOf(blocker);
        score -= 12 + progress * 5 + (blockType === 'k' ? 18 : 0);
      }
    }

    const rookBehind = rooksBehindPasser(position, color, sq);
    if (rookBehind) score += Math.min(36, rookBehind * (15 + progress * 3));

    if (progress >= 4) {
      const remaining = Math.max(1, 6 - progress);
      const promo = promotionSquare(sq, color);
      const enemyPromoDistance = enemyKing >= 0 ? chebyshev(enemyKing, promo) : 8;
      const tempoAllowance = position.turn === enemy ? 0 : 1;
      if (enemyPromoDistance > remaining + tempoAllowance) {
        score += 24 + (progress - 3) * 18;
      }
      score += (progress - 3) * 13;
    }
  }
  return score;
}

function directOpposition(position) {
  const wk = position.kingSquare(WHITE), bk = position.kingSquare(BLACK);
  if (wk < 0 || bk < 0) return 0;
  const [wr, wc] = rowCol(wk), [br, bc] = rowCol(bk);
  const direct = (wr === br && Math.abs(wc - bc) === 2) || (wc === bc && Math.abs(wr - br) === 2);
  if (!direct) return 0;
  return position.turn === WHITE ? -16 : 16;
}

export function endgameBreakdown(position, perspective = position.turn) {
  const phase = endgamePhase(position);
  if (!phase.active) {
    return { active: false, weight: phase.weight, kingActivity: 0, passers: 0, cohesion: 0, opposition: 0, total: 0 };
  }

  const kingWhite = kingActivityFor(position, WHITE);
  const kingBlack = kingActivityFor(position, BLACK);
  const cohesionWhite = kingPawnCohesionFor(position, WHITE);
  const cohesionBlack = kingPawnCohesionFor(position, BLACK);
  const passerWhite = passerValueFor(position, WHITE);
  const passerBlack = passerValueFor(position, BLACK);
  const oppositionWhite = phase.nonPawnMaterial === 0 ? directOpposition(position) : 0;

  const rawWhite = (kingWhite - kingBlack)
    + (cohesionWhite - cohesionBlack)
    + (passerWhite - passerBlack)
    + oppositionWhite;
  const whiteScore = Math.round(rawWhite * phase.weight);
  const total = perspective === WHITE ? whiteScore : -whiteScore;
  return {
    active: true,
    weight: phase.weight,
    kingActivity: Math.round((perspective === WHITE ? kingWhite - kingBlack : kingBlack - kingWhite) * phase.weight),
    cohesion: Math.round((perspective === WHITE ? cohesionWhite - cohesionBlack : cohesionBlack - cohesionWhite) * phase.weight),
    passers: Math.round((perspective === WHITE ? passerWhite - passerBlack : passerBlack - passerWhite) * phase.weight),
    opposition: Math.round((perspective === WHITE ? oppositionWhite : -oppositionWhite) * phase.weight),
    total,
  };
}

export function endgameEvaluation(position, perspective = position.turn) {
  return endgameBreakdown(position, perspective).total;
}

function advancedPassedPush(position, move) {
  if (!move || typeOf(move.piece) !== 'p' || move.promotion) return false;
  const color = colorOf(move.piece);
  const next = position.makeMove(move);
  return pawnProgress(move.to, color) >= 3 && isPassedPawn(next, move.to, color);
}

function blocksAdvancedPasser(position, move) {
  const mover = colorOf(move.piece);
  const enemy = opposite(mover);
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== enemy || typeOf(piece) !== 'p') continue;
    const progress = pawnProgress(sq, enemy);
    if (progress < 3 || !isPassedPawn(position, sq, enemy)) continue;
    if (frontSquare(sq, enemy) === move.to) return true;
  }
  return false;
}

function kingApproachesAdvancedPasser(position, move) {
  if (typeOf(move.piece) !== 'k') return false;
  const mover = colorOf(move.piece);
  const enemy = opposite(mover);
  let before = 8, after = 8;
  for (let sq = 0; sq < 64; sq++) {
    const piece = position.board[sq];
    if (!piece || colorOf(piece) !== enemy || typeOf(piece) !== 'p') continue;
    if (pawnProgress(sq, enemy) < 3 || !isPassedPawn(position, sq, enemy)) continue;
    before = Math.min(before, chebyshev(move.from, sq));
    after = Math.min(after, chebyshev(move.to, sq));
  }
  return after < before;
}

export function endgameSearchMove(position, move) {
  const phase = endgamePhase(position);
  if (!phase.active || !move) {
    return { active: false, reductionExempt: false, extension: 0, qsearch: false };
  }
  const passedPush = advancedPassedPush(position, move);
  const blockade = blocksAdvancedPasser(position, move);
  const kingApproach = kingApproachesAdvancedPasser(position, move);
  const kingMove = typeOf(move.piece) === 'k';
  const progress = passedPush ? pawnProgress(move.to, colorOf(move.piece)) : 0;
  const extension = (passedPush && progress >= 4) || blockade ? 1 : 0;
  return {
    active: true,
    reductionExempt: passedPush || blockade || kingApproach || (phase.deep && kingMove),
    extension,
    qsearch: (passedPush && progress >= 4) || blockade,
  };
}

export function isEndgameQMove(position, move) {
  if (!move || (move.flags & FLAGS.CAPTURE) || move.promotion) return false;
  return endgameSearchMove(position, move).qsearch;
}

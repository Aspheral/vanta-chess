const NAMES={k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};

// Vanta's board set is drawn as layered SVG rather than font glyphs.  The
// silhouettes stay very traditional so pieces remain instantly readable on a
// phone, while the extra bevels, highlights and cut-lines give them a more
// premium game-piece feel at larger sizes.
const ART={
  p:`
    <ellipse class="piece-shadow" cx="50" cy="84" rx="27" ry="5"/>
    <circle class="piece-body" cx="50" cy="23" r="12.5"/>
    <path class="piece-highlight" d="M43 18c3-5 10-7 15-2"/>
    <path class="piece-body" d="M38 40c3-5 7-7 12-7s9 2 12 7l-4 9H42z"/>
    <path class="piece-body" d="M42 48h16l6 20H36z"/>
    <path class="piece-shadow" d="M51 49h7l6 19H48z"/>
    <path class="piece-body" d="M31 66h38l5 9H26z"/>
    <path class="piece-body" d="M24 75h52l6 11H18z"/>
    <path class="piece-detail" d="M36 48h28M32 66h36M27 75h46"/>
    <path class="piece-highlight" d="M36 70h24"/>
  `,
  r:`
    <ellipse class="piece-shadow" cx="50" cy="86" rx="31" ry="4.5"/>
    <path class="piece-body" d="M22 16h13v10h9V16h12v10h9V16h13v24H22z"/>
    <path class="piece-shadow" d="M56 18h8v10h9v10H56z"/>
    <path class="piece-detail" d="M23 39h54M29 45h42"/>
    <path class="piece-body" d="M30 40h40l-5 28H35z"/>
    <path class="piece-shadow" d="M54 42h14l-5 24H51z"/>
    <path class="piece-highlight" d="M36 45l-3 19"/>
    <path class="piece-body" d="M28 66h44l5 10H23z"/>
    <path class="piece-body" d="M20 76h60l5 10H15z"/>
    <path class="piece-detail" d="M28 66h44M24 76h52"/>
  `,
  n:`
    <ellipse class="piece-shadow" cx="50" cy="86" rx="32" ry="4.5"/>
    <path class="piece-body" d="M26 75c2-17 8-31 22-42l-7-8 16-14 6 16c11 5 17 15 17 28-7-6-15-9-24-8l-10 8c10 2 17 9 20 20z"/>
    <path class="piece-shadow" d="M56 27c11 6 16 15 16 25-6-3-12-5-18-4l-8 7c9 3 15 9 17 19H51c-1-11-5-19-11-24 7-9 13-16 16-23z"/>
    <path class="piece-detail mane" d="M43 25c5 3 9 7 12 12M37 32c5 3 9 6 12 10M48 55c7-3 14-3 20 0"/>
    <path class="piece-highlight" d="M50 19c5 3 8 7 10 12M31 68c2-8 5-15 10-21"/>
    <circle class="piece-eye" cx="62" cy="31" r="2.7"/>
    <path class="piece-nostril" d="M72 42l3 1"/>
    <path class="piece-body" d="M22 74h54l7 12H15z"/>
    <path class="piece-detail" d="M24 75h50"/>
  `,
  b:`
    <ellipse class="piece-shadow" cx="50" cy="86" rx="31" ry="4.5"/>
    <path class="piece-body" d="M50 11c10 8 17 18 17 28 0 8-5 15-13 20l6 9H40l6-9c-8-5-13-12-13-20 0-10 7-20 17-28z"/>
    <path class="piece-shadow" d="M52 14c8 8 12 16 12 24 0 9-5 15-13 20l5 9h-8V50c6-6 8-12 7-20-1-6-2-11-3-16z"/>
    <path class="piece-cut" d="M44 27l15 18"/>
    <path class="piece-highlight" d="M42 22c-4 5-6 10-6 15"/>
    <path class="piece-body" d="M31 66h38l6 10H25z"/>
    <path class="piece-body" d="M20 76h60l5 10H15z"/>
    <path class="piece-detail" d="M31 66h38M24 76h52"/>
  `,
  q:`
    <ellipse class="piece-shadow" cx="50" cy="86" rx="33" ry="4.5"/>
    <circle class="piece-jewel" cx="22" cy="20" r="4.5"/>
    <circle class="piece-jewel" cx="36" cy="14" r="4.5"/>
    <circle class="piece-jewel crown" cx="50" cy="11" r="5"/>
    <circle class="piece-jewel" cx="64" cy="14" r="4.5"/>
    <circle class="piece-jewel" cx="78" cy="20" r="4.5"/>
    <path class="piece-body" d="M22 25l13 17 2-22 13 22 13-22 2 22 13-17-8 38H30z"/>
    <path class="piece-shadow" d="M51 42l12-20 2 20 12-15-8 34H51z"/>
    <path class="piece-highlight" d="M28 30l8 25M43 25l5 30"/>
    <path class="piece-body" d="M29 61h42l6 14H23z"/>
    <path class="piece-body" d="M19 75h62l5 11H14z"/>
    <path class="piece-detail" d="M30 61h40M24 75h52"/>
  `,
  k:`
    <ellipse class="piece-shadow" cx="50" cy="86" rx="33" ry="4.5"/>
    <path class="piece-detail cross" d="M50 6v22M40 16h20"/>
    <path class="piece-body" d="M50 27c12 0 20 7 20 17 0 7-5 13-12 17l7 8H35l7-8c-7-4-12-10-12-17 0-10 8-17 20-17z"/>
    <path class="piece-shadow" d="M52 29c9 1 15 7 15 15 0 7-5 12-11 16l6 8H50V29z"/>
    <path class="piece-highlight" d="M37 37c3-5 7-7 12-8"/>
    <path class="piece-body" d="M29 67h42l6 9H23z"/>
    <path class="piece-body" d="M19 76h62l5 10H14z"/>
    <path class="piece-detail" d="M30 67h40M24 76h52"/>
  `
};

export function pieceName(piece){
  const type=NAMES[String(piece||'').toLowerCase()]||'piece';
  return `${piece===piece?.toUpperCase()?'White':'Black'} ${type}`;
}

export function pieceSvg(piece,{decorative=true}={}){
  if(!piece)return '';
  const type=String(piece).toLowerCase();
  const color=piece===piece.toUpperCase()?'white':'black';
  const label=pieceName(piece);
  return `<svg class="piece-svg piece-svg-${color} piece-svg-${type}" viewBox="0 0 100 100" ${decorative?'aria-hidden="true"':'role="img" aria-label="'+label+'"'} focusable="false" xmlns="http://www.w3.org/2000/svg">${ART[type]||''}</svg>`;
}

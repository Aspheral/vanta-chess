const NAMES={k:'king',q:'queen',r:'rook',b:'bishop',n:'knight',p:'pawn'};

const ART={
  p:`
    <circle class="piece-body" cx="50" cy="25" r="12"/>
    <path class="piece-body" d="M39 42c2-5 7-8 11-8s9 3 11 8l-4 22h10l4 10H29l4-10h10z"/>
    <path class="piece-body" d="M26 75h48l5 10H21z"/>
    <path class="piece-detail" d="M34 64h32M29 75h42"/>
  `,
  r:`
    <path class="piece-body" d="M25 18h12v10h9V18h8v10h9V18h12v21H25z"/>
    <path class="piece-body" d="M31 39h38l-4 28h8v10H27V67h8z"/>
    <path class="piece-body" d="M23 77h54l5 9H18z"/>
    <path class="piece-detail" d="M31 39h38M35 67h30M27 77h46"/>
  `,
  n:`
    <path class="piece-body" d="M29 76c2-18 7-30 19-40l-8-9 17-14 5 15c10 5 15 14 16 26-8-5-15-7-24-5l-8 7c10 2 16 8 18 20z"/>
    <path class="piece-body" d="M24 76h50l6 10H18z"/>
    <circle class="piece-eye" cx="59" cy="31" r="2.5"/>
    <path class="piece-detail" d="M43 29l11 8M46 56c7-2 13-2 19 1M27 76h47"/>
  `,
  b:`
    <path class="piece-body" d="M50 13c9 8 15 16 15 25 0 8-4 14-11 18l7 12h8l5 9H26l5-9h8l7-12c-7-4-11-10-11-18 0-9 6-17 15-25z"/>
    <path class="piece-body" d="M23 77h54l5 9H18z"/>
    <path class="piece-detail" d="M42 29l16 17M32 68h36M27 77h46"/>
  `,
  q:`
    <circle class="piece-jewel" cx="25" cy="22" r="4"/>
    <circle class="piece-jewel" cx="38" cy="17" r="4"/>
    <circle class="piece-jewel" cx="50" cy="14" r="4"/>
    <circle class="piece-jewel" cx="62" cy="17" r="4"/>
    <circle class="piece-jewel" cx="75" cy="22" r="4"/>
    <path class="piece-body" d="M25 27l12 12 1-17 12 17 12-17 1 17 12-12-8 37H33z"/>
    <path class="piece-body" d="M29 64h42l5 12H24z"/>
    <path class="piece-body" d="M21 76h58l4 10H17z"/>
    <path class="piece-detail" d="M32 64h36M25 76h50"/>
  `,
  k:`
    <path class="piece-detail cross" d="M50 9v20M42 18h16"/>
    <path class="piece-body" d="M50 28c10 0 17 7 17 15 0 6-4 11-9 15l7 10h7l5 9H23l5-9h7l7-10c-5-4-9-9-9-15 0-8 7-15 17-15z"/>
    <path class="piece-body" d="M20 77h60l4 9H16z"/>
    <path class="piece-detail" d="M31 68h38M24 77h52"/>
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
  return `<svg class="piece-svg piece-svg-${color}" viewBox="0 0 100 100" ${decorative?'aria-hidden="true"':'role="img" aria-label="'+label+'"'} focusable="false" xmlns="http://www.w3.org/2000/svg">${ART[type]||''}</svg>`;
}

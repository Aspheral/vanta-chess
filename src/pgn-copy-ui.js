function resultFromUi() {
  const result = document.querySelector('.game-result')?.textContent || '';
  if (/White wins/i.test(result)) return '1-0';
  if (/Black wins/i.test(result)) return '0-1';
  if (/Draw/i.test(result)) return '1/2-1/2';
  return '*';
}

function playerNames() {
  const white = document.querySelector('#playWhite')?.classList.contains('primary');
  const black = document.querySelector('#playBlack')?.classList.contains('primary');
  if (white) return { White: 'Player', Black: 'Vanta' };
  if (black) return { White: 'Vanta', Black: 'Player' };
  return { White: 'Player', Black: 'Vanta' };
}

function collectMoveText() {
  const rows = [...document.querySelectorAll('.move-row')];
  const tokens = [];
  for (const row of rows) {
    const moveNo = row.querySelector('.move-no')?.textContent?.trim() || '';
    const cells = [...row.querySelectorAll('.move-cell')].map(el => el.textContent.trim()).filter(Boolean);
    if (!moveNo || !cells.length) continue;
    tokens.push(moveNo, ...cells);
  }
  return tokens.join(' ').replace(/\s+/g, ' ').trim();
}

export function buildCurrentPgn() {
  const result = resultFromUi();
  const names = playerNames();
  const date = new Date().toISOString().slice(0, 10).replaceAll('-', '.');
  const headers = [
    ['Event', 'Vanta Chess'],
    ['Site', location.href],
    ['Date', date],
    ['Round', '-'],
    ['White', names.White],
    ['Black', names.Black],
    ['Result', result],
  ];
  const tagText = headers.map(([key, value]) => `[${key} "${String(value).replaceAll('"', '\\"')}"]`).join('\n');
  const moves = collectMoveText();
  return `${tagText}\n\n${moves}${moves ? ' ' : ''}${result}`;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.select();
    const copied = document.execCommand('copy');
    textarea.remove();
    return copied;
  }
}

function showToast(text) {
  const toast = document.querySelector('#toast');
  if (!toast) return;
  toast.textContent = text;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 2200);
}

function installButton() {
  const controls = document.querySelector('.controls');
  if (!controls || controls.querySelector('#copyPgn')) return;
  const fenButton = controls.querySelector('#copyFen');
  if (!fenButton) return;

  const button = document.createElement('button');
  button.className = 'btn';
  button.id = 'copyPgn';
  button.type = 'button';
  button.textContent = 'Copy PGN';
  button.title = 'Copy the current game as a standard PGN';
  button.addEventListener('click', async () => {
    const pgn = buildCurrentPgn();
    const copied = await copyText(pgn);
    showToast(copied ? 'PGN copied.' : 'Could not copy PGN.');
  });
  fenButton.insertAdjacentElement('afterend', button);
}

const observer = new MutationObserver(() => installButton());
observer.observe(document.documentElement, { childList: true, subtree: true });
installButton();

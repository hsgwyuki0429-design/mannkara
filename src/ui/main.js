import { Game } from '../core/game.js';
import { Board } from '../core/board.js';
import { resolveChains, columnMoves } from '../core/mancala.js';
import { COLUMN_COUNT, ROW_COUNT, screenXToColIndex, ANIM } from '../core/constants.js';
import { Renderer, delay } from './renderer.js';
import { Sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const sfx = new Sfx();
const renderer = new Renderer(sfx);

let originX = 3;
let active = -1;        // ゴースト表示中の候補（-1 = なし）
let dragging = false;   // 指でつかんでいる最中か
let overBoard = false;

const game = new Game({
  hooks: {
    async onPlaced() {
      sfx.land();
      renderer.syncBoard(game.board, ANIM.drop, 'cubic-bezier(.3,1.4,.5,1)');
      await delay(ANIM.drop + 60);
    },
    async onColumnResolve(step) {
      await renderer.conveyColumn(step.column, step.stack, game.board, step.chain);
    },
    async onChainStep(step, gained) {
      renderer.showChain(step.chain, gained);
      updateHud();
      updateDebug();
      await delay(ANIM.betweenChains);
    },
    async onChainEnd() {
      renderer.syncBoard(game.board, ANIM.drop);
      updateDebug();
    },
    async onGameOver() {
      sfx.over();
      $('finalScore').textContent = game.score.score;
      $('gameOver').classList.remove('hidden');
    },
  },
});

/* ---------- HUD / 候補 ---------- */
function updateHud() {
  $('score').textContent = game.score.score;
  $('chain').textContent = game.score.lastChain;
  $('best').textContent = game.score.bestChain;
}

function renderCandidates() {
  const wrap = $('candidates');
  wrap.innerHTML = '';
  game.candidates.forEach((piece, idx) => {
    const box = document.createElement('div');
    box.className = 'cand';
    box.dataset.idx = idx;
    const tag = document.createElement('span');
    tag.className = 'idx';
    tag.textContent = idx + 1;
    box.appendChild(tag);
    const cells = piece.normalizedCells();
    const w = Math.max(...cells.map((c) => c.x)) + 1;
    const h = Math.max(...cells.map((c) => c.y)) + 1;
    const s = 13;
    for (const c of cells) {
      const d = document.createElement('div');
      d.className = `mini b-${piece.color}`;
      d.style.width = d.style.height = s - 2 + 'px';
      d.style.left = `calc(50% + ${(c.x - w / 2) * s}px)`;
      d.style.top = `calc(50% + ${(c.y - h / 2) * s}px)`;
      box.appendChild(d);
    }
    wrap.appendChild(box);
  });
}

/* ---------- ゴースト / 落下位置 ---------- */
function currentPiece() { return active >= 0 ? game.candidates[active] : null; }

function clampOrigin() {
  const p = currentPiece();
  if (!p) return;
  originX = Math.max(0, Math.min(COLUMN_COUNT - p.width, originX));
}
function landingInfo() {
  const p = currentPiece();
  if (!p) return { cells: [], landing: [] };
  const cells = p.cellsAt(originX);
  const add = new Array(COLUMN_COUNT).fill(0);
  const landing = [];
  for (const c of [...cells].sort((a, b) => b.y - a.y)) {
    const i = screenXToColIndex(c.x);
    landing.push({ colIndex: i, stackIndex: game.board.height(i) + add[i] });
    add[i]++;
  }
  return { cells, landing };
}
function updateGhost(pointerY) {
  const p = currentPiece();
  if (!p || game.busy || game.gameOver) { renderer.clearGhost(); return; }
  const { cells, landing } = landingInfo();
  renderer.showGhost(cells, landing);
  const topLanding = Math.min(...landing.map((l) => renderer.blockPos(l.colIndex, l.stackIndex).y));
  const h = Math.max(...p.normalizedCells().map((c) => c.y)) + 1;
  const maxY = topLanding - (h - 1) * renderer.cell - renderer.cell * 0.6;
  const y = Math.max(0, Math.min(maxY, (pointerY ?? 0) - renderer.cell * 1.6));
  renderer.showFloating(p, originX, y);
}

/* ---------- 入力：候補をつかんで盤面へ運ぶ ---------- */
const pf = $('playfield');

function pointerToOrigin(e) {
  const p = currentPiece();
  if (!p) return;
  const rect = pf.getBoundingClientRect();
  const x = Math.round((e.clientX - rect.left) / renderer.cell - p.width / 2);
  originX = Math.max(0, Math.min(COLUMN_COUNT - p.width, x));
  const y = e.clientY - rect.top;
  overBoard = e.clientY < rect.bottom;
  updateGhost(y);
}

$('candidates').addEventListener('pointerdown', (e) => {
  const box = e.target.closest('.cand');
  if (!box || game.busy || game.gameOver) return;
  sfx.unlock();
  active = Number(box.dataset.idx);
  dragging = true;
  overBoard = false;
  sfx.pick();
  markCandidates();
  clampOrigin();
  pointerToOrigin(e);
  e.preventDefault();
});

window.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  pointerToOrigin(e);
  e.preventDefault();
}, { passive: false });

window.addEventListener('pointerup', async () => {
  if (!dragging) return;
  const idx = active;
  const x = originX;
  const canDrop = overBoard;
  dragging = false;
  active = -1;
  renderer.clearGhost();
  markCandidates();
  if (canDrop) await drop(idx, x);
});
window.addEventListener('pointercancel', () => {
  dragging = false;
  active = -1;
  renderer.clearGhost();
  markCandidates();
});

function markCandidates() {
  document.querySelectorAll('.cand').forEach((el, i) => {
    el.classList.toggle('active', i === active);
    el.classList.toggle('taken', dragging && i === active);
  });
}

async function drop(idx, x) {
  if (game.busy || game.gameOver) return;
  const ok = await game.placePiece(idx, x);
  if (!ok) return;
  renderCandidates();
  updateHud();
  updateDebug();
}

// PC 用のキーボード補助（1/2/3 選択 + ←→ + Enter/Space で落とす）
window.addEventListener('keydown', (e) => {
  if (game.busy || game.gameOver) return;
  if (['1','2','3'].includes(e.key)) active = Number(e.key) - 1;
  else if (e.key === 'ArrowLeft') { if (active < 0) active = 0; originX--; }
  else if (e.key === 'ArrowRight') { if (active < 0) active = 0; originX++; }
  else if (e.key === ' ' || e.key === 'Enter' || e.key === 'ArrowDown') {
    e.preventDefault();
    if (active < 0) return;
    const idx = active;
    active = -1; renderer.clearGhost(); markCandidates();
    drop(idx, originX);
    return;
  } else return;
  sfx.unlock();
  clampOrigin();
  markCandidates();
  updateGhost(0);
});

/* ---------- サウンド切替 ---------- */
$('btnSound').addEventListener('click', () => {
  sfx.unlock();
  sfx.enabled = !sfx.enabled;
  $('btnSound').classList.toggle('off', !sfx.enabled);
});

/* ---------- デバッグ ---------- */
$('btnDebug').addEventListener('click', () => {
  $('debugPanel').classList.toggle('hidden');
  updateDebug();
});
function updateDebug() {
  if ($('debugPanel').classList.contains('hidden')) return;
  $('debugText').textContent =
    game.debugStatus().join('\n') +
    `\nheights(列1→列8) = [${game.board.heights.join(', ')}]`;
}
$('btnApplyHeights').addEventListener('click', () => {
  const hs = $('debugHeights').value.split(',').map((v) => Number(v.trim()) || 0);
  game.board = Board.fromHeights(hs.slice(0, COLUMN_COUNT));
  renderer.reset();
  renderer.bindBoard(game.board);
  updateDebug();
});
$('btnRunChain').addEventListener('click', async () => {
  if (game.busy) return;
  game.busy = true;
  const trace = resolveChains(game.board.clone()).map((s) => s.column);
  for (;;) {
    const c = game.board.findExactColumns();
    if (!c.length) break;
    const column = Math.min(...c);
    let stack = [];
    for (const ev of columnMoves(game.board, column)) if (ev.type === 'suck') stack = ev.blocks;
    await renderer.conveyColumn(column, stack, game.board, 1);
    await delay(ANIM.betweenChains);
  }
  game.busy = false;
  updateDebug();
  $('debugText').textContent += `\nchain order: ${trace.join(' -> ')}`;
});

/* ---------- 初期化 ---------- */
function restart() {
  game.reset();
  active = -1; dragging = false; originX = 3;
  renderer.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  renderCandidates();
  updateHud();
  updateDebug();
}
$('btnRestart').addEventListener('click', restart);
$('btnRetry').addEventListener('click', () => { sfx.unlock(); restart(); });
restart();
window.__game = game;

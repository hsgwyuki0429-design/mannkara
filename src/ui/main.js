import { Game } from '../core/game.js';
import { Board } from '../core/board.js';
import { resolveChains } from '../core/mancala.js';
import { SIZE, ANIM } from '../core/constants.js';
import { Renderer, delay } from './renderer.js';
import { Sfx } from './sfx.js';

const $ = (id) => document.getElementById(id);
const sfx = new Sfx();
const renderer = new Renderer(sfx);

/* ---------- ベストスコア（端末ごと） ---------- */
const BEST_KEY = 'stair-mancala-best';
let best = 0;
try { best = Number(localStorage.getItem(BEST_KEY)) || 0; } catch {}
function saveBest() {
  if (game.score.score <= best) return false;
  best = game.score.score;
  try { localStorage.setItem(BEST_KEY, String(best)); } catch {}
  return true;
}

/* ---------- ゲーム ---------- */
const PRAISE = [[8, 'Unbelievable!'], [5, 'Excellent!'], [3, 'Great!']];

const game = new Game({
  hooks: {
    async onPlaced(placed) {
      sfx.place();
      renderer.popIn(placed);
      renderTray();
      updateHud();
      await delay(ANIM.place);
    },
    async onRows(step) { await renderer.clearRows(step); },
    async onColumn(step) { await renderer.conveyColumn(step, game.board); },
    async onStep(step, gained) {
      const praise = PRAISE.find(([n]) => step.chain >= n)?.[1];
      if (step.chain >= 2) renderer.showText(`${step.chain} CHAIN<small>${praise ?? ''} +${gained}</small>`, step.chain >= 5 ? 'big' : '');
      else renderer.showText(`<small>+${gained}</small>`);
      updateHud(true);
      updateDebug();
      await delay(ANIM.betweenChains);
    },
    async onTurnEnd(steps) {
      renderer.syncBoard(game.board, 120);
      const st = game.score.streak;
      if (steps.length && st >= 2) {
        await delay(200);
        renderer.showText(`COMBO ×${st}`, 'big');
        sfx.combo(st);
      }
      updateHud();
      updateDebug();
    },
    async onTrayRefill() { sfx.refill(); renderTray(true); },
    async onGameOver() {
      await delay(350);
      sfx.over();
      const isBest = saveBest();
      $('finalScore').textContent = game.score.score;
      $('finalBest').textContent = isBest ? '👑 NEW BEST!' : `👑 ${best}`;
      $('gameOver').classList.remove('hidden');
    },
  },
});

/* ---------- HUD ---------- */
function updateHud(bump = false) {
  const s = $('score');
  s.textContent = game.score.score;
  if (bump) { s.classList.remove('bump'); void s.offsetWidth; s.classList.add('bump'); }
  $('best').textContent = Math.max(best, game.score.score);
  const st = game.score.streak;
  $('streak').textContent = st >= 2 ? `COMBO ×${st}` : '';
}

/* ---------- トレイ ---------- */
function trayCellSize() {
  return Math.min(Math.floor(renderer.cell * 0.52), 22);
}
function renderTray(enter = false) {
  const wrap = $('tray');
  wrap.innerHTML = '';
  const s = trayCellSize();
  game.tray.forEach((piece, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (enter ? ' enter' : '');
    slot.dataset.slot = i;
    if (enter) slot.style.setProperty('animation-delay', `${i * 50}ms`);
    if (piece) {
      if (!game.board.fits(piece)) slot.classList.add('nofit');
      const box = document.createElement('div');
      box.className = 'piece';
      box.style.width = piece.width * s + 'px';
      box.style.height = piece.height * s + 'px';
      if (enter) box.style.animationDelay = `${i * 60}ms`;
      for (const c of piece.cells) {
        const d = document.createElement('div');
        d.className = `tray-cell c-${piece.color}`;
        Object.assign(d.style, { width: s - 2 + 'px', height: s - 2 + 'px', left: c.x * s + 'px', top: c.y * s + 'px' });
        box.appendChild(d);
      }
      slot.appendChild(box);
    }
    wrap.appendChild(slot);
  });
}

/* ---------- ドラッグ ---------- */
let drag = null; // { slot, piece, lift, ox, oy, valid }

function previewInfo(piece, ox, oy) {
  const b = game.board.clone();
  b.place(piece, ox, oy);
  const cells = [];
  for (const r of b.fullRows()) cells.push(...b.rowCells(r));
  for (const n of b.fullColumns()) {
    const x = SIZE - n;
    for (let r = 0; r < n; r++) cells.push({ x, r });
  }
  const chain = resolveChains(b).length;
  return { cells, chain };
}

function renderDragPiece(fx, fy) {
  const { piece, lift } = drag;
  const c = renderer.cell;
  const left = fx - (piece.width * c) / 2;
  const top = fy - lift - piece.height * c;
  const layer = $('dragLayer');
  if (!layer.childElementCount) {
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `drag-cell c-${piece.color}`;
      d.style.left = cc.x * c + 'px';
      d.style.top = cc.y * c + 'px';
      layer.appendChild(d);
    }
  }
  layer.style.transform = `translate(${left}px,${top}px)`;
  return { left, top };
}

function updateDrag(e) {
  const { left, top } = renderDragPiece(e.clientX, e.clientY);
  const rect = renderer.pf.getBoundingClientRect();
  const c = renderer.cell;
  const ox = Math.round((left - rect.left) / c);
  const oy = Math.round((top - rect.top) / c);
  if (ox === drag.ox && oy === drag.oy) return;
  drag.ox = ox; drag.oy = oy;
  drag.valid = game.canPlace(drag.slot, ox, oy);
  if (drag.valid) {
    const { cells, chain } = previewInfo(drag.piece, ox, oy);
    renderer.showPreview(drag.piece, ox, oy, cells, chain);
  } else {
    renderer.clearPreview();
  }
}

function endDrag() {
  $('dragLayer').innerHTML = '';
  renderer.clearPreview();
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('dragging'));
  drag = null;
}

$('tray').addEventListener('pointerdown', (e) => {
  const slotEl = e.target.closest('.slot');
  if (!slotEl || game.busy || game.gameOver || drag) return;
  const slot = Number(slotEl.dataset.slot);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock();
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? -(piece.height * renderer.cell) / 2 : renderer.cell * 1.3;
  drag = { slot, piece, lift, ox: null, oy: null, valid: false };
  slotEl.classList.add('dragging');
  $('dragLayer').innerHTML = '';
  updateDrag(e);
  e.preventDefault();
});
window.addEventListener('pointermove', (e) => { if (drag) { updateDrag(e); e.preventDefault(); } }, { passive: false });
window.addEventListener('pointerup', async () => {
  if (!drag) return;
  const { slot, ox, oy, valid } = drag;
  const overBoard = ox !== null && ox > -3 && oy > -3 && ox < SIZE + 1 && oy < SIZE + 1;
  endDrag();
  if (valid) await game.placePiece(slot, ox, oy);
  else { if (overBoard) sfx.invalid(); renderTray(); }
});
window.addEventListener('pointercancel', () => { if (drag) { endDrag(); renderTray(); } });

/* ---------- サウンド ---------- */
$('btnSound').addEventListener('click', () => {
  sfx.unlock();
  sfx.enabled = !sfx.enabled;
  $('btnSound').classList.toggle('off', !sfx.enabled);
});

/* ---------- デバッグ ---------- */
$('btnDebug').addEventListener('click', () => { $('debugPanel').classList.toggle('hidden'); updateDebug(); });
function updateDebug() {
  if ($('debugPanel').classList.contains('hidden')) return;
  $('debugText').textContent = game.debugStatus().join('\n') +
    `\nheights(列1→列8) = [${game.board.heights.join(', ')}]  (■=埋まり □=空き, 左が一番下)`;
}
$('btnApplyHeights').addEventListener('click', () => {
  if (game.busy) return;
  const hs = $('debugHeights').value.split(',').map((v) => Number(v.trim()) || 0);
  game.board = Board.fromHeights(hs.slice(0, SIZE));
  renderer.reset();
  renderer.bindBoard(game.board);
  renderTray();
  updateDebug();
});
$('btnRunChain').addEventListener('click', async () => {
  if (game.busy) return;
  game.busy = true;
  const trace = resolveChains(game.board.clone()).map((s) => (s.type === 'rows' ? `row${s.rows.join('+')}` : s.column));
  await game.resolve();
  game.busy = false;
  renderer.syncBoard(game.board, 120);
  updateHud();
  updateDebug();
  renderTray();
  $('debugText').textContent += `\norder: ${trace.join(' -> ') || '(none)'}`;
});

/* ---------- 開始 ---------- */
function restart() {
  saveBest();
  game.reset();
  endDrag();
  renderer.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  renderTray(true);
  updateHud();
  updateDebug();
}
$('btnRestart').addEventListener('click', restart);
$('btnRetry').addEventListener('click', () => { sfx.unlock(); restart(); });
window.addEventListener('resize', () => renderTray());
restart();
window.__game = game;
window.__renderer = renderer;

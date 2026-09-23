import { Game } from '../core/game.js?v=202609230425';
import { Board } from '../core/board.js?v=202609230425';
import { resolveChains } from '../core/mancala.js?v=202609230425';
import { SIZE, ANIM, lineCells, CHAIN_SPEED_UP, CHAIN_SPEED_MAX } from '../core/constants.js?v=202609230425';
import { Renderer, delay } from './renderer.js?v=202609230425';
import { Sfx } from './sfx.js?v=202609230425';

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

/**
 * 描画キュー。ルールは placePiece の時点で即確定しているので、ここでは記録を順番に再生するだけ。
 * 再生中もプレイヤーは次のピースを置ける（置いたピースはすぐ表示し、その連鎖は後ろに並ぶ）。
 */
let queue = Promise.resolve();
let shownScore = 0;
let generation = 0;           // restart で古い再生を打ち切るため
const enqueue = (fn) => {
  const gen = generation;
  queue = queue.then(() => (gen === generation ? fn() : null)).catch((e) => console.error(e));
  return queue;
};
/** 連鎖が進むほど速く（1連鎖目 1.0倍 → 最大 CHAIN_SPEED_MAX 倍） */
const speedFor = (chain) => Math.min(CHAIN_SPEED_MAX, 1 + (chain - 1) * CHAIN_SPEED_UP);

const game = new Game({
  hooks: {
    onTurn(turn) {
      // 置いたピースは即表示・トレイも即更新（すぐ次を置けるように）
      sfx.place();
      renderer.popIn(turn.placed);
      renderTray(turn.refilled);
      if (turn.refilled) sfx.refill();
      updateDebug();
      enqueue(async () => {
        showScore(turn.scoreAfterPlace);
        for (const step of turn.steps) {
          await renderer.playStep(step, speedFor(step.chain));
          const praise = PRAISE.find(([n]) => step.chain >= n)?.[1];
          if (step.chain >= 2) renderer.showText(`${step.chain} CHAIN<small>${praise ?? ''} +${step.gained}</small>`, step.chain >= 5 ? 'big' : '');
          else renderer.showText(`<small>+${step.gained}</small>`);
          showScore(step.score, true);
          await delay(ANIM.betweenChains / speedFor(step.chain));
        }
        if (turn.steps.length && turn.streak >= 2) {
          renderer.showText(`COMBO ×${turn.streak}`, 'big');
          sfx.combo(turn.streak);
        }
        $('streak').textContent = turn.streak >= 2 ? `COMBO ×${turn.streak}` : '';
        showScore(turn.score);
        if (turn.gameOver) {
          await delay(350);
          sfx.over();
          const isBest = saveBest();
          $('finalScore').textContent = game.score.score;
          $('finalBest').textContent = isBest ? '👑 NEW BEST!' : `👑 ${best}`;
          $('gameOver').classList.remove('hidden');
        }
      });
    },
  },
});

/* ---------- HUD ---------- */
/** 表示上のスコア（描画の再生に合わせて増える） */
function showScore(v, bump = false) {
  shownScore = v;
  const s = $('score');
  s.textContent = v;
  if (bump) { s.classList.remove('bump'); void s.offsetWidth; s.classList.add('bump'); }
  $('best').textContent = Math.max(best, v);
}
function updateHud() { showScore(game.score.score); $('streak').textContent = ''; }

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
  const cells = b.fullLines().flatMap(({ kind, n }) => lineCells(kind, n));
  const chain = resolveChains(b).length;
  return { cells, chain };
}

/**
 * 指の少し上にピースを浮かせて表示し、その中心がどの盤面マスに当たるかを返す。
 * 盤面は回転して表示しているので、画面座標 -> 盤面ローカル座標へ逆回転して判定する。
 */
function renderDragPiece(fx, fy) {
  const { piece, lift } = drag;
  const c = renderer.cell;
  const layer = $('dragLayer');
  if (!layer.childElementCount) {
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `drag-cell c-${piece.color}`;
      d.style.left = (cc.x - piece.width / 2) * c + 'px';
      d.style.top = (cc.y - piece.height / 2) * c + 'px';
      layer.appendChild(d);
    }
  }
  const cx = fx, cy = fy - lift;
  layer.style.left = cx + 'px';
  layer.style.top = cy + 'px';
  return renderer.clientToLocal(cx, cy);
}

function updateDrag(e) {
  const center = renderDragPiece(e.clientX, e.clientY);
  const c = renderer.cell;
  const ox = Math.round(center.x / c - drag.piece.width / 2);
  const oy = Math.round(center.y / c - drag.piece.height / 2);
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
  if (!slotEl || game.gameOver || drag) return;
  const slot = Number(slotEl.dataset.slot);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock();
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? 0 : renderer.cell * (1.2 + Math.max(piece.width, piece.height) * 0.5);
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
  if (valid) game.placePiece(slot, ox, oy);
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
    `\n(■=埋まり □=空き, 左が斜辺側の端)`;
}
$('btnApplyHeights').addEventListener('click', () => {
  generation++; queue = Promise.resolve();
  const hs = $('debugHeights').value.split(',').map((v) => Number(v.trim()) || 0);
  game.board = Board.fromHeights(hs.slice(0, SIZE));
  renderer.reset();
  renderer.bindBoard(game.board);
  renderTray();
  updateDebug();
});
$('btnRunChain').addEventListener('click', () => {
  const steps = game.resolve();
  const trace = steps.map((s) => (s.kind === 'col' ? '縦' : '横') + s.n);
  enqueue(async () => {
    for (const step of steps) {
      await renderer.playStep(step, speedFor(step.chain));
      showScore(step.score, true);
      await delay(ANIM.betweenChains / speedFor(step.chain));
    }
  });
  updateDebug();
  renderTray();
  $('debugText').textContent += `\norder: ${trace.join(' -> ') || '(none)'}`;
});

/* ---------- 開始 ---------- */
function restart() {
  saveBest();
  generation++; queue = Promise.resolve();
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
window.__booted = true;
window.__game = game;
window.__renderer = renderer;

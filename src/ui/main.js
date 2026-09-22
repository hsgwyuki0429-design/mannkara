import { Game } from '../core/game.js';
import { Board } from '../core/board.js';
import { Piece } from '../core/pieces.js';
import { resolveChains, columnMoves } from '../core/mancala.js';
import { COLUMN_COUNT, screenXToColIndex, ANIM } from '../core/constants.js';
import { Renderer, delay } from './renderer.js';

const $ = (id) => document.getElementById(id);
const renderer = new Renderer();

let originX = 3;
let rotation = 0;
let selected = 0;

const game = new Game({
  hooks: {
    async onPlaced() {
      renderer.syncBoard(game.board, ANIM.drop);
      await delay(ANIM.drop + 40);
    },
    async onSuck(column, blocks) {
      await renderer.suck(column, blocks);
    },
    async onMove(ev) {
      if (ev.to === 'goal') await renderer.toGoal(ev.block, ev.from);
      else await renderer.deal(ev.block, ev.from, ev.to, game.board);
    },
    async onChainStep(step, gained) {
      renderer.showChain(step.chain, gained);
      updateHud();
      updateDebug();
      await delay(ANIM.betweenChains);
    },
    async onChainEnd() {
      renderer.syncBoard(game.board, ANIM.insert);
      updateDebug();
    },
    async onGameOver() {
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
    box.className = 'cand' + (idx === selected ? ' selected' : '');
    const tag = document.createElement('span');
    tag.className = 'idx';
    tag.textContent = idx + 1;
    box.appendChild(tag);
    const cells = piece.normalizedCells();
    const w = Math.max(...cells.map((c) => c.x)) + 1;
    const h = Math.max(...cells.map((c) => c.y)) + 1;
    const s = 12;
    for (const c of cells) {
      const d = document.createElement('div');
      d.className = `mini b-${piece.color}`;
      d.style.width = d.style.height = s - 1 + 'px';
      d.style.left = `calc(50% + ${(c.x - w / 2) * s}px)`;
      d.style.top = `calc(50% + ${(c.y - h / 2) * s}px)`;
      box.appendChild(d);
    }
    box.addEventListener('pointerdown', () => selectCandidate(idx));
    wrap.appendChild(box);
  });
}

function selectCandidate(idx) {
  if (game.busy || game.gameOver) return;
  selected = idx;
  rotation = 0;
  clampOrigin();
  renderCandidates();
  updateGhost();
}

/* ---------- ゴースト ---------- */
function currentPiece() {
  const p = game.candidates[selected];
  return p ? new Piece(p.type, rotation) : null;
}
function clampOrigin() {
  const p = currentPiece();
  if (!p) return;
  originX = Math.max(0, Math.min(COLUMN_COUNT - p.width, originX));
}
function landingCells() {
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
function updateGhost() {
  if (game.busy || game.gameOver) { renderer.clearGhost(); return; }
  const { cells, landing } = landingCells();
  renderer.showGhost(cells, landing);
}

/* ---------- 操作 ---------- */
function move(d) { originX += d; clampOrigin(); updateGhost(); }
function rotate() {
  const p = currentPiece();
  if (!p) return;
  rotation = p.rotated(1).rotation;
  clampOrigin();
  updateGhost();
}
async function drop() {
  if (game.busy || game.gameOver) return;
  const ok = await game.placePiece(selected, originX, rotation);
  if (!ok) return;
  selected = 0;
  rotation = 0;
  clampOrigin();
  renderCandidates();
  updateHud();
  updateDebug();
  updateGhost();
}

$('btnLeft').addEventListener('click', () => move(-1));
$('btnRight').addEventListener('click', () => move(1));
$('btnRotate').addEventListener('click', rotate);
$('btnDrop').addEventListener('click', drop);
$('btnRestart').addEventListener('click', restart);
$('btnRetry').addEventListener('click', restart);

// 盤面を指でなぞって横位置指定（タップでもその位置へ）
const pf = $('playfield');
let dragging = false;
function pointerToOrigin(e) {
  const rect = pf.getBoundingClientRect();
  const x = Math.floor((e.clientX - rect.left) / renderer.cell);
  const p = currentPiece();
  if (!p) return;
  originX = Math.max(0, Math.min(COLUMN_COUNT - p.width, x - Math.floor((p.width - 1) / 2)));
  updateGhost();
}
pf.addEventListener('pointerdown', (e) => {
  if (game.busy || game.gameOver) return;
  dragging = true; pf.setPointerCapture(e.pointerId); pointerToOrigin(e);
});
pf.addEventListener('pointermove', (e) => { if (dragging) pointerToOrigin(e); });
pf.addEventListener('pointerup', () => { dragging = false; });
pf.addEventListener('pointercancel', () => { dragging = false; });

window.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft') move(-1);
  else if (e.key === 'ArrowRight') move(1);
  else if (e.key === 'ArrowUp' || e.key === 'z' || e.key === 'x') rotate();
  else if (e.key === ' ' || e.key === 'ArrowDown') { e.preventDefault(); drop(); }
  else if (['1', '2', '3'].includes(e.key)) selectCandidate(Number(e.key) - 1);
});

/* ---------- デバッグ ---------- */
$('btnDebug').addEventListener('click', () => {
  $('debugPanel').classList.toggle('hidden');
  updateDebug();
});
function updateDebug() {
  const panel = $('debugPanel');
  if (panel.classList.contains('hidden')) return;
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
  updateGhost();
});
$('btnRunChain').addEventListener('click', async () => {
  if (game.busy) return;
  game.busy = true;
  const trace = resolveChains(game.board.clone()).map((s) => s.column);
  // 実盤面はアニメーション付きで解決
  const hooks = game.hooks;
  for (;;) {
    const c = game.board.findExactColumns();
    if (!c.length) break;
    const column = Math.min(...c);
    for (const ev of columnMoves(game.board, column)) {
      if (ev.type === 'suck') await hooks.onSuck(column, ev.blocks);
      else await hooks.onMove(ev);
    }
  }
  game.busy = false;
  updateDebug();
  $('debugText').textContent += `\nchain order: ${trace.join(' -> ')}`;
});

/* ---------- 初期化 ---------- */
function restart() {
  game.reset();
  selected = 0; rotation = 0; originX = 3;
  renderer.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  renderCandidates();
  updateHud();
  updateDebug();
  updateGhost();
}
restart();
window.__game = game; // デバッグ用

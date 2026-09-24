import { Game } from '../core/game.js?v=202609240056';
import { Board } from '../core/board.js?v=202609240056';
import { resolveChains } from '../core/mancala.js?v=202609240056';
import { SIZE, ANIM, lineCells, CHAIN_SPEED_GROWTH, CHAIN_SPEED_MAX, TURN_PLAY_BUDGET, BACKLOG_SPEED } from '../core/constants.js?v=202609240056';
import { Renderer, delay } from './renderer.js?v=202609240056';
import { Sfx } from './sfx.js?v=202609240056';

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
/** 連鎖数ごとの褒め言葉（段階が上がるほど派手な色） */
const PRAISE = [[8, 'Unbelievable!', 5], [6, 'Amazing!', 4], [4, 'Excellent!', 3], [3, 'Great!', 2], [2, 'Good!', 1]];

/**
 * 描画キュー。ルールは placePiece の時点で即確定しているので、ここでは記録を順番に再生するだけ。
 * 再生中もプレイヤーは次のピースを置ける（置いたピースはすぐ表示し、その連鎖は後ろに並ぶ）。
 */
let queue = Promise.resolve();
let shownScore = 0;
let pending = 0;              // 再生待ち・再生中のターン数
let generation = 0;           // restart で古い再生を打ち切るため
let bestCelebrated = false;   // このゲームで新記録の演出をしたか
const enqueue = (fn) => {
  const gen = generation;
  queue = queue.then(() => (gen === generation ? fn() : null)).catch((e) => console.error(e));
  return queue;
};

/**
 * 1ターンぶんの各連鎖の再生速度。連鎖が進むほど指数的に速くし、
 * それでも合計が TURN_PLAY_BUDGET を超えるなら全体をまとめて速めて収める。
 */
function planSpeeds(steps) {
  const base = steps.map((s) => Math.min(CHAIN_SPEED_MAX, Math.pow(CHAIN_SPEED_GROWTH, s.chain - 1)));
  const cost = (s) => (9 + s.stack.length) * ANIM.step + ANIM.betweenChains;
  const total = steps.reduce((a, s, i) => a + cost(s) / base[i], 0);
  const k = Math.max(1, total / TURN_PLAY_BUDGET);
  return base.map((v) => v * k);
}
/** 再生中に次のピースが置かれて待ちが溜まっていたら、さらに速める */
const backlog = () => (pending > 1 ? BACKLOG_SPEED : 1);

const game = new Game({
  hooks: {
    onTurn(turn) {
      // 置いたピースは即表示・トレイも即更新（すぐ次を置けるように）
      sfx.place();
      renderer.popIn(turn.placed);
      renderTray(turn.refilled);
      if (turn.refilled) sfx.refill();
      updateDebug();
      pending++;
      const gen = generation;
      enqueue(() => playTurn(turn)).finally(() => { if (gen === generation) pending = Math.max(0, pending - 1); });
    },
  },
});

async function playTurn(turn) {
  showScore(turn.scoreAfterPlace);
  const speeds = planSpeeds(turn.steps);
  if (turn.steps.length) {
    renderer.setFever((turn.streak - 1) / 5);
    if (turn.streak >= 2) { renderer.showCombo(turn.streak); sfx.combo(turn.streak); }
  } else renderer.setFever(0);
  for (const [i, step] of turn.steps.entries()) {
    const sp = speeds[i] * backlog();
    if (i === 0) await renderer.charge(step.kind, step.n, step.stack[0]?.color, 70 / backlog());
    await renderer.playStep(step, sp);
    const [, praise, tier] = PRAISE.find(([n]) => step.chain >= n) ?? [];
    if (step.chain >= 2) {
      renderer.showText(`${step.chain} CHAIN<small>${praise}</small>`, `t${tier}`);
      sfx.praise(tier);
    }
    if (step.gained) renderer.floatScore(step.gained, step.chain);
    showScore(step.score, true);
    await delay(ANIM.betweenChains / sp);
  }
  if (turn.allClear) {
    renderer.confetti();
    renderer.showText('ALL CLEAR!', 't5');
    sfx.fanfare();
  }
  showScore(turn.score);
  updateDanger();
  if (turn.gameOver) {
    await delay(350);
    renderer.setFever(0);
    sfx.over();
    const isBest = saveBest();
    $('finalScore').textContent = game.score.score.toLocaleString('en-US');
    $('finalBest').textContent = isBest ? '👑 NEW BEST!' : `👑 ${best}`;
    $('gameOver').classList.remove('hidden');
  }
}

/**
 * ピンチ度: 盤面の埋まり具合と、残りの手駒のうち置けないものの割合から。
 * 発動で盤面が空くとスッと消える（緊張→解放）。
 */
function updateDanger() {
  if (game.gameOver) { renderer.setDanger(0); return; }
  const fill = game.board.totalBlocks() / 36;                // 盤面は 36 マス
  const rest = game.tray.filter(Boolean);
  const stuck = rest.length ? rest.filter((p) => !game.board.fits(p)).length / rest.length : 0;
  renderer.setDanger(Math.max(0, (fill - 0.55) / 0.3) * 0.6 + stuck * 0.6);
}

/* ---------- HUD ---------- */
/** 表示上のスコア（描画の再生に合わせて増える） */
let rollRaf = 0;
function showScore(v, bump = false) {
  const from = shownScore;
  shownScore = v;
  const s = $('score');
  // 数字がくるくる増えていく
  cancelAnimationFrame(rollRaf);
  const t0 = performance.now(), dur = v - from > 0 ? Math.min(420, 120 + (v - from) * 0.8) : 0;
  const frame = (now) => {
    const p = dur ? Math.min(1, (now - t0) / dur) : 1;
    const cur = Math.round(from + (v - from) * (1 - Math.pow(1 - p, 3)));
    s.textContent = cur.toLocaleString('en-US');
    $('best').textContent = Math.max(best, cur);
    if (p < 1) rollRaf = requestAnimationFrame(frame);
  };
  frame(t0);
  if (bump) {
    // クラスの付け外し + offsetWidth は強制レイアウトになるので Web Animations で弾ませる
    const base = '0 3px 3px rgba(0,0,0,.18),0 0 0 rgba(255,230,120,0)';
    s.__bump?.cancel();
    s.__bump = s.animate([
      { transform: 'none', textShadow: base, easing: 'cubic-bezier(.3,1.6,.5,1)' },
      { transform: 'scale(1.14)', textShadow: '0 3px 3px rgba(0,0,0,.18),0 0 22px rgba(255,230,120,.9)', offset: 0.35, easing: 'cubic-bezier(.3,1.6,.5,1)' },
      { transform: 'none', textShadow: base },
    ], { duration: 300 });
  }
  // ベストスコアを超えた瞬間（ゲーム中に1回だけ）
  if (!bestCelebrated && best > 0 && v > best) {
    bestCelebrated = true;
    renderer.confetti();
    renderer.showText('NEW BEST!', 't5');
    sfx.fanfare();
    document.querySelector('.best-pill')?.classList.add('beat');
  }
}
function updateHud() { cancelAnimationFrame(rollRaf); shownScore = game.score.score; showScore(game.score.score); }

/* ---------- トレイ ---------- */
/**
 * トレイでの1マスの大きさ。基本は盤面と同じ大きさで、枠に収まらない形だけ縮める。
 * 225° 回転して表示するので、w×h の形は画面上で (w+h)/√2 マス四方になる。
 */
function trayCellSize(piece, box) {
  const room = Math.min(box.width, box.height) - 18;
  return Math.max(10, Math.min(renderer.cell, Math.floor((room * Math.SQRT2) / (piece.width + piece.height))));
}
/** 225° 回転した形の、画面上でマスが占める範囲の中心（形の外接四角の中心からのずれ, px） */
function pieceScreenCenter(piece, s) {
  const k = Math.SQRT1_2;
  const xs = [], ys = [];
  for (const c of piece.cells) {
    const u = (c.x + 0.5 - piece.width / 2) * s, v = (c.y + 0.5 - piece.height / 2) * s;
    xs.push(k * (v - u)); ys.push(-k * (u + v));
  }
  return { x: (Math.min(...xs) + Math.max(...xs)) / 2, y: (Math.min(...ys) + Math.max(...ys)) / 2 };
}
function renderTray(enter = false) {
  const wrap = $('tray');
  wrap.innerHTML = '';
  const cols = wrap.clientWidth ? getComputedStyle(wrap) : null;
  const gap = cols ? parseFloat(cols.columnGap) || 0 : 0;
  const pad = cols ? parseFloat(cols.paddingLeft) + parseFloat(cols.paddingRight) : 0;
  const slotBox = { width: (wrap.clientWidth - pad - gap * 2) / 3, height: wrap.clientHeight };
  game.tray.forEach((piece, i) => {
    const slot = document.createElement('div');
    slot.className = 'slot' + (enter ? ' enter' : '');
    slot.dataset.slot = i;
    if (enter) slot.style.setProperty('animation-delay', `${i * 50}ms`);
    if (piece) {
      const s = trayCellSize(piece, slotBox);
      if (!game.board.fits(piece)) slot.classList.add('nofit');
      const box = document.createElement('div');
      box.className = 'piece';
      box.style.width = piece.width * s + 'px';
      box.style.height = piece.height * s + 'px';
      // 形の外接四角ではなく、実際のマスが見えている範囲の中心を枠の中心に合わせる
      const mid = pieceScreenCenter(piece, s);
      box.style.translate = `${-mid.x}px ${-mid.y}px`;
      if (enter) box.style.animationDelay = `${i * 60}ms`;
      for (const c of piece.cells) {
        const d = document.createElement('div');
        d.className = `tray-cell c-${piece.color}`;
        Object.assign(d.style, { width: s + 'px', height: s + 'px', left: c.x * s + 'px', top: c.y * s + 'px' });
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
  const lines = b.fullLines();
  const cells = lines.flatMap(({ kind, n }) => lineCells(kind, n));
  const chain = resolveChains(b).length;
  return { cells, chain, lines };
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
    layer.style.transform = renderer.boardTransform();
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

/**
 * 指の位置に一番近い「置ける場所」を探す。ぴったりでなくても、ずれが SNAP_RANGE マス以内なら吸い付く。
 */
const SNAP_RANGE = 1.6;
function nearestPlacement(slot, piece, fx, fy) {
  let best = null;
  for (let oy = Math.floor(fy) - 2; oy <= Math.ceil(fy) + 2; oy++) {
    for (let ox = Math.floor(fx) - 2; ox <= Math.ceil(fx) + 2; ox++) {
      const d = Math.hypot(ox - fx, oy - fy);
      if (d > SNAP_RANGE || (best && d >= best.d)) continue;
      if (game.canPlace(slot, ox, oy)) best = { ox, oy, d };
    }
  }
  return best;
}

function updateDrag(e) {
  const center = renderDragPiece(e.clientX, e.clientY);
  const c = renderer.cell;
  const fx = center.x / c - drag.piece.width / 2;
  const fy = center.y / c - drag.piece.height / 2;
  const hit = nearestPlacement(drag.slot, drag.piece, fx, fy);
  const ox = hit ? hit.ox : Math.round(fx), oy = hit ? hit.oy : Math.round(fy);
  const valid = !!hit;
  if (ox === drag.ox && oy === drag.oy && valid === drag.valid) return;
  drag.ox = ox; drag.oy = oy; drag.valid = valid;
  if (valid) {
    const { cells, chain, lines } = previewInfo(drag.piece, ox, oy);
    renderer.showPreview(drag.piece, ox, oy, cells, chain, lines);
    // 消える場所に入った瞬間だけ、期待をあおる上昇音と軽い振動
    if (chain > 0 && chain !== drag.chain) sfx.anticipate(chain);
    else if (!chain) sfx.hover();
    drag.chain = chain;
  } else {
    renderer.clearPreview();
    drag.chain = 0;
  }
  $('dragLayer').classList.toggle('will-clear', valid && drag.chain > 0);
}

function endDrag() {
  $('dragLayer').innerHTML = '';
  $('dragLayer').classList.remove('will-clear');
  renderer.clearPreview();
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('dragging'));
  drag = null;
}

$('tray').addEventListener('pointerdown', (e) => {
  const slotEl = e.target.closest('.slot');
  if (!slotEl || game.gameOver || drag || paused) return;
  const slot = Number(slotEl.dataset.slot);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock();
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? 0 : renderer.cell * (1.2 + Math.max(piece.width, piece.height) * 0.5);
  drag = { slot, piece, lift, ox: null, oy: null, valid: false, chain: 0 };
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

/* ---------- 一時停止 ---------- */
let paused = false;
function setPaused(v) {
  paused = v;
  $('pauseOverlay').classList.toggle('hidden', !v);
}
$('btnPause').addEventListener('click', () => { sfx.unlock(); if (!game.gameOver) setPaused(true); });
$('btnResume').addEventListener('click', () => setPaused(false));

/* ---------- デバッグ（URL に ?debug を付けた時だけボタンを出す） ---------- */
if (new URLSearchParams(location.search).has('debug')) $('btnDebug').classList.remove('hidden');
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
    const speeds = planSpeeds(steps);
    for (const [i, step] of steps.entries()) {
      await renderer.playStep(step, speeds[i]);
      showScore(step.score, true);
      await delay(ANIM.betweenChains / speeds[i]);
    }
  });
  updateDebug();
  renderTray();
  $('debugText').textContent += `\norder: ${trace.join(' -> ') || '(none)'}`;
});

/* ---------- 開始 ---------- */
function restart() {
  saveBest();
  generation++; queue = Promise.resolve(); pending = 0;
  bestCelebrated = false;
  document.querySelector('.best-pill')?.classList.remove('beat');
  game.reset();
  endDrag();
  renderer.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  setPaused(false);
  renderTray(true);
  updateHud();
  updateDanger();
  updateDebug();
}
$('btnRestart').addEventListener('click', restart);
$('btnRetry').addEventListener('click', () => { sfx.unlock(); restart(); });
window.addEventListener('resize', () => renderTray());
restart();
window.__booted = true;
window.__game = game;
window.__renderer = renderer;
window.__ui = { showScore, renderTray, setBest(v) { best = v; } };

import { Game } from '../core/game.js?v=202609260806';
import { Board } from '../core/board.js?v=202609260806';
import { resolveChains } from '../core/mancala.js?v=202609260806';
import * as Sim from '../core/sim.js?v=202609260806';
import { SIZE, ANIM, lineCells, CHAIN_SPEED_GROWTH, CHAIN_SPEED_MAX, TURN_PLAY_BUDGET, BACKLOG_SPEED } from '../core/constants.js?v=202609260806';
import { Renderer, delay } from './renderer.js?v=202609260806';
import { Sfx } from './sfx.js?v=202609260806';
import { Scenes } from './scenes.js?v=202609260806';
import { colorOf } from './palette.js?v=202609260806';

const $ = (id) => document.getElementById(id);
const sfx = new Sfx();
const renderer = new Renderer(sfx);
/** 画面全体の演出（新記録の風船・大連鎖やコンボの色の変化など。画面を覆う演出は使わない） */
const scenes = new Scenes({ sfx, colorOf });
scenes.warm();

/* ---------- モード（通常 / 学習）とベストスコア（端末ごと・モードごとに別） ---------- */
const MODE_KEY = 'stair-mancala-mode';
let mode = 'normal';
try { mode = localStorage.getItem(MODE_KEY) === 'learn' ? 'learn' : 'normal'; } catch {}
const bestKey = () => (mode === 'learn' ? 'stair-mancala-best-learn' : 'stair-mancala-best');
let best = 0;
function loadBest() {
  best = 0;
  try { best = Number(localStorage.getItem(bestKey())) || 0; } catch {}
}
loadBest();
function saveBest() {
  if (game.score.score <= best) return false;
  best = game.score.score;
  try { localStorage.setItem(bestKey(), String(best)); } catch {}
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
/** 再生中にピースを持ち上げたときの再生の速さ（置くまでに表示を盤面に追いつかせる）。長く持っているほど速める */
const CATCH_UP = 4, CATCH_UP_MAX = 12;
const catchUpSpeed = () => Math.min(CATCH_UP_MAX, CATCH_UP + (performance.now() - drag.t0) / 150);
let turnSeq = 0;              // 置いた順の番号
let rushBefore = 0;           // この番号より前のターンの再生は早送りする

const game = new Game({
  hooks: {
    onTurn(turn) {
      // 置いたピースは即表示・トレイも即更新（すぐ次を置けるように）
      sfx.place();
      turn.seq = ++turnSeq;
      // 穴にぴったり・凹みを埋めて長方形: 置いた瞬間に手応え（連鎖の文字が出ればそちらで上書き）
      if (turn.fit === 'perfect' || turn.rect) {
        sfx.fit();
        if (turn.rect) renderer.rectDone(turn.rect);
        renderer.showText(`${turn.fit === 'perfect' ? 'PERFECT FIT!' : 'NICE FIT!'}<small>+${turn.fitBonus.toLocaleString('en-US')}</small>`, 't2');
      }
      // 前のターンの再生がまだ終わっていなければ、残りを一気に最後まで進める（表示を盤面に追いつかせる）。
      // ルールは置いた瞬間に確定しているので、遅れた表示のまま新しいピースを出すと古いブロックに重なって見える
      if (pending > 0) { rushBefore = turn.seq; renderer.setRush(true); }
      renderer.popIn(turn.placed);
      renderer.clearHint();
      renderTray(turn.refilled);
      if (turn.refilled) sfx.refill();
      updateDebug();
      pending++;
      const gen = generation;
      enqueue(() => playTurn(turn)).finally(() => {
        if (gen !== generation) return;
        pending = Math.max(0, pending - 1);
        if (!pending) caughtUp();
      });
    },
  },
});

const allClearText = (turn) => `ALL CLEAR!<small>BONUS +${turn.allClearBonus.toLocaleString('en-US')}</small>`;

async function playTurn(turn) {
  // 途中でリスタート（モードの切り替えなど）したら、古いゲームの続き（点数・ゲームオーバー）は出さない
  const gen = generation, stale = () => gen !== generation;
  const rush = turn.seq < rushBefore;
  renderer.setRush(rush);
  showScore(turn.scoreAfterPlace);
  if (rush) {                                            // 早送り: 演出なしで盤面と点数だけ最後まで進める
    for (const step of turn.steps) { await renderer.playStep(step, 1); if (stale()) return; }
    if (turn.allClear) { renderer.showText(allClearText(turn), 't5'); sfx.fanfare(); }   // 全消しは見せ場なので早送りでも出す
    showScore(turn.score);
    return;
  }
  const speeds = planSpeeds(turn.steps);
  if (turn.steps.length) {
    renderer.setFever((turn.streak - 1) / 5);
    if (turn.streak >= 2) { renderer.showCombo(turn.streak); sfx.combo(turn.streak); }
    if (turn.streak >= 5 && turn.streak % 5 === 0) scenes.comboWave();       // コンボ 5・10・15… で画面の下から桃色に染まる
  } else renderer.setFever(0);
  let shownTier = 0;                                       // このターンで画面の色を変えた褒め言葉の段階
  for (const [i, step] of turn.steps.entries()) {
    const sp = speeds[i] * backlog();
    // 再生中に次のピースが置かれたら、残りの発動は演出なしで一気に進める
    if (renderer.rush) { await renderer.playStep(step, 1); if (stale()) return; continue; }
    if (i === 0) await renderer.charge(step.kind, step.n, step.stack, ANIM.charge / backlog());
    if (stale()) return;
    await renderer.playStep(step, sp);
    if (stale()) return;
    if (renderer.rush) continue;
    const [, praise, tier] = PRAISE.find(([n]) => step.chain >= n) ?? [];
    if (step.chain >= 2) {
      renderer.showText(`${step.chain} CHAIN<small>${praise}</small>`, `t${tier}`);
      if (tier > shownTier) {                                  // 段階が上がった時だけ（毎回だと染まりっぱなしになる）
        shownTier = tier;
        if (tier >= 4) scenes.bigChain(tier);    // Amazing 以上で画面全体の色が変わる
      } else if (step.chain >= 12 && step.chain % 4 === 0) scenes.bigChain(5);   // 12・16・20…連鎖でもう一度
      sfx.praise(tier);
    }
    if (step.gained) renderer.floatScore(step.gained, step.chain);
    showScore(step.score, true);
    await renderer.wait(ANIM.betweenChains / sp);
    if (stale()) return;
  }
  if (turn.allClear) {
    renderer.showText(allClearText(turn), 't5');
    renderer.floatScore(turn.allClearBonus, 5);
    renderer.allClearBlast();
    sfx.fanfare();
  }
  showScore(turn.score);
  updateDanger();
  if (pending <= 1) updateHint();                  // 再生待ちが無くなったら、次のおすすめを出す
  if (turn.gameOver) {
    await renderer.wait(350);
    if (stale()) return;
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
    // クラスの付け外し + offsetWidth は強制レイアウトになるので Web Animations で弾ませる（光らせず、大きさだけ）
    s.__bump?.cancel();
    s.__bump = s.animate([
      { transform: 'none', easing: 'cubic-bezier(.3,1.6,.5,1)' },
      { transform: 'scale(1.12)', offset: 0.35, easing: 'cubic-bezier(.3,1.6,.5,1)' },
      { transform: 'none' },
    ], { duration: 300 });
  }
  // ベストスコアを超えた瞬間（ゲーム中に1回だけ）
  if (!bestCelebrated && best > 0 && v > best) {
    bestCelebrated = true;
    scenes.newBest();
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
  const room = Math.min(box.width, box.height) - 10;
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
    slot.className = 'slot' + (enter ? ' enter' : '') + (drag?.slot === i ? ' dragging' : '');
    slot.dataset.slot = i;
    if (enter) slot.style.setProperty('animation-delay', `${i * 50}ms`);
    if (piece) {
      const s = trayCellSize(piece, slotBox);
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
let drag = null; // { slot, piece, lift, ox, oy, valid, chain, pointerId, x, y }

function previewInfo(piece, ox, oy) {
  const fit = Sim.fitOf(Sim.fromBoard(game.board), piece.cells, ox, oy);
  const b = game.board.clone();
  b.place(piece, ox, oy);
  const lines = b.fullLines();
  const cells = lines.flatMap(({ kind, n }) => lineCells(kind, n));
  const chain = resolveChains(b).length;
  return { cells, chain, lines, fit };
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
/** 仮置きが見えていない間（連鎖の再生中）は、見えていない場所へ吸い付かないよう、ほぼ真下だけにする */
const SNAP_RANGE_BLIND = 0.75;
function nearestPlacement(slot, piece, fx, fy, range = SNAP_RANGE) {
  let best = null;
  for (let oy = Math.floor(fy) - 2; oy <= Math.ceil(fy) + 2; oy++) {
    for (let ox = Math.floor(fx) - 2; ox <= Math.ceil(fx) + 2; ox++) {
      const d = Math.hypot(ox - fx, oy - fy);
      if (d > range || (best && d >= best.d)) continue;
      if (game.canPlace(slot, ox, oy)) best = { ox, oy, d };
    }
  }
  return best;
}

function updateDrag(e) {
  drag.x = e.clientX; drag.y = e.clientY;
  if (pending > 0 && !paused) renderer.timeScale = catchUpSpeed();
  const center = renderDragPiece(e.clientX, e.clientY);
  const c = renderer.cell;
  const fx = center.x / c - drag.piece.width / 2;
  const fy = center.y / c - drag.piece.height / 2;
  const hit = nearestPlacement(drag.slot, drag.piece, fx, fy, pending > 0 ? SNAP_RANGE_BLIND : SNAP_RANGE);
  const ox = hit ? hit.ox : Math.round(fx), oy = hit ? hit.oy : Math.round(fy);
  const valid = !!hit;
  const lag = pending > 0;       // 連鎖の再生中は、表示が盤面（連鎖の最後まで進んだ状態）に追いついていない
  if (ox === drag.ox && oy === drag.oy && valid === drag.valid && lag === drag.lag) return;
  drag.ox = ox; drag.oy = oy; drag.valid = valid; drag.lag = lag;
  // 追いつくまでは仮置きを出さない（見えているブロックと合わない場所に出てしまうので）。追いついたら caughtUp で出す
  if (valid && !lag) {
    const { cells, chain, lines, fit } = previewInfo(drag.piece, ox, oy);
    renderer.showPreview(drag.piece, ox, oy, cells, chain, lines, fit);
    // 消える場所に入った瞬間だけ、期待をあおる上昇音と軽い振動。穴にぴったりの場所はカチッ
    if (chain > 0 && chain !== drag.chain) sfx.anticipate(chain);
    else if (!chain && (fit.kind === 'perfect' || fit.rect)) sfx.fitHover();
    else if (!chain) sfx.hover();
    drag.chain = chain;
  } else {
    renderer.clearPreview();
    drag.chain = 0;
  }
}

function endDrag() {
  $('dragLayer').innerHTML = '';
  renderer.clearPreview();
  document.querySelectorAll('.slot').forEach((s) => s.classList.remove('dragging'));
  drag = null;
  renderer.timeScale = paused ? 0 : 1;
}
/** 持っているピースを置かずに戻す（指が離れたのを取りこぼしたとき・一時停止・画面の切り替えなど） */
function cancelDrag() {
  if (!drag) return;
  endDrag();
  renderTray();
  updateHint();
}
/** 再生が全部終わって表示が盤面に追いついた: ピースを持っていれば仮置きを出し直す */
function caughtUp() {
  if (!drag) return;
  renderer.timeScale = paused ? 0 : 1;
  drag.ox = null;
  updateDrag({ clientX: drag.x, clientY: drag.y });
}

$('tray').addEventListener('pointerdown', (e) => {
  const hitSlot = e.target.closest('.slot');
  // 最初の指（isPrimary）が下りたのにまだ持っている = 前の指が離れたのを取りこぼした。持っていたピースは戻す
  // （戻すとトレイを描き直すので、触った枠は番号で探し直す）
  if (drag && e.isPrimary) cancelDrag();
  if (!hitSlot || game.gameOver || drag || paused) return;
  const slot = Number(hitSlot.dataset.slot);
  const slotEl = document.querySelector(`.slot[data-slot="${slot}"]`);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock();
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? 0 : renderer.cell * (1.2 + Math.max(piece.width, piece.height) * 0.5);
  drag = { slot, piece, lift, ox: null, oy: null, valid: false, chain: 0, pointerId: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now() };
  renderer.clearHint();
  slotEl.classList.add('dragging');
  $('dragLayer').innerHTML = '';
  updateDrag(e);
  e.preventDefault();
});
// 持ち上げた指の動きだけを見る（ほかの指で触っても、持っているピースは動かない・落ちない）
const mine = (e) => drag && e.pointerId === drag.pointerId;
window.addEventListener('pointermove', (e) => { if (mine(e)) { updateDrag(e); e.preventDefault(); } }, { passive: false });
window.addEventListener('pointerup', (e) => {
  if (!mine(e)) return;
  const { slot, ox, oy, valid } = drag;
  const overBoard = ox !== null && ox > -3 && oy > -3 && ox < SIZE + 1 && oy < SIZE + 1;
  endDrag();
  if (valid) game.placePiece(slot, ox, oy);
  else { if (overBoard) sfx.invalid(); renderTray(); updateHint(); }
});
window.addEventListener('pointercancel', (e) => { if (mine(e)) cancelDrag(); });
// アプリの切り替え・通知などで指が離れたのが届かないことがある。そのときは持っているピースを戻す
window.addEventListener('blur', cancelDrag);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelDrag(); saveBest(); }            // 途中でアプリを閉じてもベストスコアが残るように
});
window.addEventListener('pagehide', () => saveBest());

/* ---------- 学習モード ---------- */
/**
 * 学習モードでは、次に置くとよいピースと場所を光らせる（Game.hint: 全消しの手順中はその手順、
 * それ以外は今の盤面での総当たり）。スコアとベストスコアは通常モードとは別
 */
function updateHint() {
  document.querySelectorAll('.slot.hinted').forEach((el) => el.classList.remove('hinted'));
  if (mode !== 'learn' || game.gameOver || drag || pending > 1) { renderer.clearHint(); return; }
  const h = game.hint();
  if (!h) { renderer.clearHint(); return; }
  renderer.showHint(game.tray[h.slot], h.ox, h.oy, h.plan);
  document.querySelector(`.slot[data-slot="${h.slot}"]`)?.classList.add('hinted');
}
function applyMode() {
  const learn = mode === 'learn';
  document.body.classList.toggle('learn', learn);
  $('btnLearn').classList.toggle('on', learn);
  $('btnLearn').setAttribute('aria-pressed', String(learn));
  $('modeBadge').classList.toggle('hidden', !learn);
}
$('btnLearn').addEventListener('click', () => {
  sfx.unlock();
  saveBest();                                      // 切り替える前のモードのベストを残してから
  mode = mode === 'learn' ? 'normal' : 'learn';
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  loadBest();
  applyMode();
  restart();
  renderer.showText(mode === 'learn' ? 'LEARN MODE' : 'NORMAL MODE', 't2');
});

/* ---------- サウンド ---------- */
$('btnSound').addEventListener('click', () => {
  sfx.unlock();
  sfx.enabled = !sfx.enabled;
  $('btnSound').classList.toggle('off', !sfx.enabled);
});

/* ---------- 一時停止 ---------- */
let paused = false;
/** 一時停止: 連鎖の再生も止める（持っているピースは戻す） */
function setPaused(v) {
  paused = v;
  if (v) cancelDrag();
  renderer.timeScale = v ? 0 : 1;
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
  // ベストスコアは呼ぶ側で残しておく（ここで残すと、モードを切り替えたときに前のモードの点数が新しいモードのベストになる）
  generation++; queue = Promise.resolve(); pending = 0; rushBefore = 0;
  bestCelebrated = false;
  document.querySelector('.best-pill')?.classList.remove('beat');
  game.reset();
  endDrag();
  renderer.reset();
  scenes.clear();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  setPaused(false);
  renderTray(true);
  updateHud();
  updateDanger();
  updateDebug();
  updateHint();
}
applyMode();
$('btnRetry').addEventListener('click', () => { sfx.unlock(); saveBest(); restart(); });
window.addEventListener('resize', () => {
  renderTray();
  // 持っているピースはマスの大きさが変わったので作り直す（盤面は renderer が先に合わせ直している）
  if (drag) { $('dragLayer').innerHTML = ''; drag.ox = null; updateDrag({ clientX: drag.x, clientY: drag.y }); }
});
restart();
window.__booted = true;
window.__game = game;
window.__renderer = renderer;
window.__scenes = scenes;
window.__ui = { showScore, renderTray, setBest(v) { best = v; }, pending: () => pending };

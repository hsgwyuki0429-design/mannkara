import { Game } from '../core/game.js?v=202609271537';
import { Board, createBlock } from '../core/board.js?v=202609271537';
import { Piece } from '../core/pieces.js?v=202609271537';
import * as Sim from '../core/sim.js?v=202609271537';
import { SIZE, ANIM, lineCells, CHAIN_SPEED_GROWTH, CHAIN_SPEED_MAX, TURN_PLAY_BUDGET, BACKLOG_SPEED } from '../core/constants.js?v=202609271537';
import { Renderer, delay } from './renderer.js?v=202609271537';
import { Sfx } from './sfx.js?v=202609271537';
import { Scenes } from './scenes.js?v=202609271537';
import { colorOf } from './palette.js?v=202609271537';
import { TrayDealer } from './tray-dealer.js?v=202609271537';
import { TUTORIAL_STEPS, TUTORIAL_END } from './tutorial-steps.js?v=202609271537';

const $ = (id) => document.getElementById(id);
const sfx = new Sfx();
const renderer = new Renderer(sfx);
/** 画面全体の演出（新記録の風船・大連鎖やコンボの色の変化など。画面を覆う演出は使わない） */
const scenes = new Scenes({ sfx, colorOf });

/* ---------- モード（通常 / 学習）とベストスコア（端末ごと・モードごとに別） ---------- */
const MODE_KEY = 'stair-mancala-mode';
let mode = 'normal';
try { mode = localStorage.getItem(MODE_KEY) === 'learn' ? 'learn' : 'normal'; } catch {}
const bestKey = () => (mode === 'learn' ? 'stair-mancala-best-learn' : 'stair-mancala-best');
let best = 0;
/** 最大連鎖・最大コンボの記録（端末ごと・モードごとに別） */
const recordsKey = () => (mode === 'learn' ? 'stair-mancala-records-learn' : 'stair-mancala-records');
let records = { chain: 0, combo: 0 };
function loadBest() {
  best = 0;
  records = { chain: 0, combo: 0 };
  try { best = Number(localStorage.getItem(bestKey())) || 0; } catch {}
  try { records = { ...records, ...JSON.parse(localStorage.getItem(recordsKey()) || '{}') }; } catch {}
}
loadBest();
/** チュートリアル中なら { i: ステップ, placed: 置いた（次のステップを待っている） }。チュートリアルの点数・盤面は残さない */
let tutorial = null;
function saveBest() {
  saveRecords();
  if (tutorial || game.score.score <= best) return false;
  best = game.score.score;
  try { localStorage.setItem(bestKey(), String(best)); } catch {}
  return true;
}

/** このゲームの最大連鎖・最大コンボを記録に残す。更新した方を返す（チュートリアルでは残さない） */
function saveRecords() {
  const { bestChain, bestStreak } = game.score;
  const up = { chain: !tutorial && bestChain > records.chain, combo: !tutorial && bestStreak > records.combo };
  if (!up.chain && !up.combo) return up;
  if (up.chain) records.chain = bestChain;
  if (up.combo) records.combo = bestStreak;
  try { localStorage.setItem(recordsKey(), JSON.stringify(records)); } catch {}
  return up;
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
/**
 * 詰み（Game.gameOver）は置いた瞬間に確定するが、連鎖の再生中はまだプレイヤーに見えていないので、
 * 「置ける場所がない！」画面が出るまではトレイのピースを掴んで動かせるようにする（実際には置ける場所が無いので、
 * 離すとトレイへ戻る）。この間の掴めるかどうかは game.gameOver ではなく、画面に出したかどうかで判定する
 */
let gameOverShown = false;
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
  const cost = (s) => Renderer.stepCells(s) * ANIM.step + ANIM.betweenChains;
  const total = steps.reduce((a, s, i) => a + cost(s) / base[i], 0);
  const k = Math.max(1, total / TURN_PLAY_BUDGET);
  return base.map((v) => v * k);
}
/** 再生中に次のピースが置かれて待ちが溜まっていたら、さらに速める */
const backlog = () => (pending > 1 ? BACKLOG_SPEED : 1);
/**
 * 再生中にピースを持ち上げたときの再生の速さ（置くまでに表示を盤面に追いつかせる）:
 *  - 持っているだけ（盤面へ近づけていない）なら速めない
 *  - 盤面へ近づけているときは、今の近づく速さで盤面に届くまでの時間を見積もり、それまでに再生が終わらない分だけ速める
 *    （間に合うなら速めない。盤面の上にあるときは、もうすぐ置くものとして CATCH_UP_ETA ms で終わる速さ）。最大 CATCH_UP_MAX 倍
 */
const CATCH_UP_MAX = 2, CATCH_UP_ETA = 200;
/** 近づいているとみなす速さ（px/ms）と、指が止まってから「持っているだけ」とみなすまでの時間 */
const APPROACH_MIN = 0.05, STILL_MS = 120;
/** 見積もりより再生が長引いても（全消しの演出など）、再生中は速められるように残りをこれより少なく見ない（ms） */
const PLAY_LEFT_MIN = 300;
function catchUpSpeed(now) {
  if (!drag || !pending) return 1;
  const left = Math.max(playLeft, PLAY_LEFT_MIN);
  const d = distToBoard(drag.x, drag.y - drag.lift);
  if (d > 0) drag.overAt = null;
  let eta;
  // 盤面の上: 着いた時から CATCH_UP_ETA 後に終わる速さ（毎回「今から ETA 後」にすると、残りが減るほど遅くなってしまう）
  if (d <= 0) { drag.overAt ??= now; eta = Math.max(16, drag.overAt + CATCH_UP_ETA - now); }
  else if (drag.approach > APPROACH_MIN && now - drag.movedAt < STILL_MS) eta = d / drag.approach;
  else return 1;
  return Math.max(1, Math.min(CATCH_UP_MAX, left / eta));
}
/** 画面の点から盤面（の外接四角）までの距離 px（中なら 0） */
function distToBoard(x, y) {
  const r = drag.boardRect;
  const dx = Math.max(r.left - x, 0, x - r.right), dy = Math.max(r.top - y, 0, y - r.bottom);
  return Math.hypot(dx, dy);
}
/**
 * 再生の残り時間のおおよそ（再生の時間で ms）。置いたターンの分を足し、再生が進んだ分（速めた分も含む）を引く
 */
let playLeft = 0, playRaf = 0, playLast = 0;
function turnPlayCost(turn) {
  const sp = planSpeeds(turn.steps);
  return turn.steps.reduce((a, s, i) => a + (Renderer.stepCells(s) * ANIM.step + ANIM.betweenChains) / sp[i], turn.steps.length ? ANIM.charge : 0);
}
function playTick(now) {
  playRaf = 0;
  if (!pending) { playLeft = 0; return; }
  if (playLast) playLeft = Math.max(0, playLeft - Math.max(0, now - playLast) * renderer.timeScale);
  playLast = now;
  if (drag && !paused) renderer.timeScale = catchUpSpeed(now);    // 持っている間は、毎フレーム速さを見直す（止まっている指はイベントが来ない）
  playRaf = requestAnimationFrame(playTick);
}
function startPlayTick() { if (!playRaf) { playLast = 0; playRaf = requestAnimationFrame(playTick); } }
let turnSeq = 0;              // 置いた順の番号
let rushBefore = 0;           // この番号より前のターンの再生は早送りする

/** 手駒の決め方は別スレッド（Web Worker）で動かす（ui/tray-dealer.js。置いた瞬間に画面が止まらないように） */
const dealer = new TrayDealer(new URL('../core/dealer-worker.js?v=202609271537', import.meta.url));
const game = new Game({
  dealer,
  hooks: {
    /** 別スレッドで決めた手駒が届いた（initial = ゲームの最初の手駒） */
    onTray({ initial }) {
      renderTray(true);
      saveGame();
      if (initial) { updateDanger(); updateHint(); }
      else sfx.refill();
    },
    onTurn(turn) {
      // 置いたピースは即表示・トレイも即更新（すぐ次を置けるように。補充の手駒は届いたら onTray で出す）
      sfx.place();
      turn.seq = ++turnSeq;
      // 穴にぴったり・凹みを埋めて長方形: 置いた瞬間に手応え（連鎖の文字が出ればそちらで上書き）
      if (turn.fit === 'perfect' || turn.rect) {
        sfx.fit();
        renderer.showText(`${turn.fit === 'perfect' ? 'PERFECT FIT!' : 'NICE FIT!'}<small>+${turn.fitBonus.toLocaleString('en-US')}</small>`, 't2');
      }
      // 前のターンの再生がまだ終わっていなければ、残りを一気に最後まで進める（表示を盤面に追いつかせる）。
      // ルールは置いた瞬間に確定しているので、遅れた表示のまま新しいピースを出すと古いブロックに重なって見える
      if (pending > 0) { rushBefore = turn.seq; renderer.setRush(true); }
      renderer.popIn(turn.placed);
      dropHint();
      const refilledNow = turn.refilled && !turn.trayReady;
      renderTray(refilledNow);
      if (refilledNow) sfx.refill();
      updateDebug();
      pending++;
      playLeft += turnPlayCost(turn);
      startPlayTick();
      const gen = generation;
      enqueue(() => playTurn(turn)).finally(() => {
        if (gen !== generation) return;
        pending = Math.max(0, pending - 1);
        if (!pending) caughtUp();
      });
      if (tutorial) tutorialPlaced();
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
    const sp = speeds[i] * backlog() * tutorialSlow();
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
    renderer.allClearBlast();
    sfx.fanfare();
  }
  showScore(turn.score);
  // 補充の手駒を別スレッドで決めているときは、届いてから（詰みの判定・ピンチ・おすすめは手駒で決まる）
  if (turn.trayReady) { await turn.trayReady; if (stale()) return; }
  updateDanger();
  if (pending <= 1) updateHint();                  // 再生待ちが無くなったら、次のおすすめを出す
  if (turn.gameOver) {
    await renderer.wait(350);
    if (stale()) return;
    renderer.setFever(0);
    sfx.over();
    gameOverShown = true;
    const prev = { ...records };
    const isBest = saveBest();
    $('finalScore').textContent = game.score.score.toLocaleString('en-US');
    showOverStats(prev);
    $('finalBest').textContent = isBest ? '👑 NEW BEST!' : `👑 ${best.toLocaleString('en-US')}`;
    clearSave();
    $('gameOver').classList.remove('hidden');
  }
}

/** ゲームオーバー画面: このゲームの最大連鎖・最大コンボと、これまでの記録（超えたら NEW RECORD!） */
function showOverStats(prev) {
  const { bestChain, bestStreak } = game.score;
  for (const [val, rec, mine, before] of [['statChain', 'recChain', bestChain, prev.chain], ['statCombo', 'recCombo', bestStreak, prev.combo]]) {
    $(val).textContent = mine;
    const isNew = before > 0 && mine > before;
    $(rec).textContent = isNew ? 'NEW RECORD!' : `記録 ${Math.max(before, mine)}`;
    $(rec).classList.toggle('new', isNew);
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
    // 同じ文字の書き込みでも文字の置き換え（レイアウトと描き直し）になるので、変わったときだけ書く
    const txt = cur.toLocaleString('en-US'), bestTxt = Math.max(best, cur).toLocaleString('en-US'), bestEl = $('best');
    if (s.textContent !== txt) s.textContent = txt;
    if (bestEl.textContent !== bestTxt) bestEl.textContent = bestTxt;
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
    const pill = document.querySelector('.best-pill');
    scenes.newBest(pill?.getBoundingClientRect());
    renderer.showText('NEW BEST!', 't5');
    sfx.fanfare();
    pill?.classList.add('beat');
    pill?.animate([{ scale: '1' }, { scale: '1.25', offset: 0.3 }, { scale: '.96', offset: 0.6 }, { scale: '1' }],
      { duration: 520, easing: 'cubic-bezier(.3,1.4,.5,1)' });
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
/**
 * トレイの1枠の大きさ。測るとレイアウトの計算し直しになるので、トレイの大きさが変わったとき（画面の回転・リサイズ）だけ測り直す
 */
let slotBoxCache = null;
function measureSlotBox(wrap) {
  if (slotBoxCache) return slotBoxCache;
  const cols = wrap.clientWidth ? getComputedStyle(wrap) : null;
  const gap = cols ? parseFloat(cols.columnGap) || 0 : 0;
  const pad = cols ? parseFloat(cols.paddingLeft) + parseFloat(cols.paddingRight) : 0;
  const box = { width: (wrap.clientWidth - pad - gap * 2) / 3, height: wrap.clientHeight };
  if (wrap.clientWidth) slotBoxCache = box;                 // まだ並んでいない（幅 0）ときは覚えない
  return box;
}
try { new ResizeObserver(() => { slotBoxCache = null; }).observe($('tray')); } catch {}
function renderTray(enter = false) {
  const wrap = $('tray');
  const slotBox = measureSlotBox(wrap);                     // 中身を消す前に測る（消した後だと、その場でレイアウトの計算になる）
  wrap.innerHTML = '';
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

/**
 * 仮置きの情報: 消えるラインとそのマス・連鎖数・穴へのはまり方。
 * 盤面の複製（ブロックごとの複製と連鎖のシミュレーション）は重いので、探索用の軽い盤面（sim.js）で計算する
 * （満杯のライン・連鎖数は本体の盤面と同じになる。テストで確認している）
 */
function previewInfo(piece, ox, oy) {
  const s = Sim.fromBoard(game.board);
  const fit = Sim.fitOf(s, piece.cells, ox, oy);
  Sim.place(s, piece.cells, ox, oy);
  const lines = Sim.fullLines(s);
  const cells = lines.flatMap(({ kind, n }) => lineCells(kind, n));
  const chain = Sim.resolveAll(s);
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
  const cx = fx, cy = fy - lift;
  // 盤面の位置は、ピースを動かす（書き込む）前に読む。書いた後に読むと、そのたびにレイアウトの計算し直しになる
  // （ドラッグ中のピースは盤面の外の層なので、動かしても盤面の位置は変わらない）
  const local = renderer.clientToLocal(cx, cy);
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
  layer.style.left = cx + 'px';
  layer.style.top = cy + 'px';
  return local;
}

/**
 * 指の位置に一番近い「置ける場所」を探す。ぴったりでなくても、ずれが SNAP_RANGE マス以内なら吸い付く。
 */
const SNAP_RANGE = 1.6;
/** 仮置きが見えていない間（連鎖の再生中）は、見えていない場所へ吸い付かないよう、ほぼ真下だけにする */
const SNAP_RANGE_BLIND = 0.75;
function nearestPlacement(slot, piece, fx, fy, range = SNAP_RANGE) {
  let best = null;
  const target = tutorialTarget();
  if (target) range = TUTORIAL_SNAP;
  for (let oy = Math.floor(fy) - 3; oy <= Math.ceil(fy) + 3; oy++) {
    for (let ox = Math.floor(fx) - 3; ox <= Math.ceil(fx) + 3; ox++) {
      const d = Math.hypot(ox - fx, oy - fy);
      if (d > range || (best && d >= best.d)) continue;
      if (target && (ox !== target.ox || oy !== target.oy)) continue;     // チュートリアルでは決めた場所にだけ置ける
      if (game.canPlace(slot, ox, oy)) best = { ox, oy, d };
    }
  }
  return best;
}

function updateDrag(e) {
  // 盤面へ近づく速さ（px/ms。なめらかに平均）
  const now = performance.now();
  const d = distToBoard(e.clientX, e.clientY - drag.lift);
  if (drag.lastD != null && now > drag.lastT) {
    const v = (drag.lastD - d) / (now - drag.lastT);
    drag.approach = drag.approach * 0.5 + v * 0.5;
    if (e.clientX !== drag.x || e.clientY !== drag.y) drag.movedAt = now;
  }
  drag.lastD = d; drag.lastT = now;
  drag.x = e.clientX; drag.y = e.clientY;
  if (pending > 0 && !paused) renderer.timeScale = catchUpSpeed(now);
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
  if (!hitSlot || gameOverShown || drag || paused) return;
  const slot = Number(hitSlot.dataset.slot);
  const slotEl = document.querySelector(`.slot[data-slot="${slot}"]`);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock();
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? 0 : renderer.cell * (1.2 + Math.max(piece.width, piece.height) * 0.5);
  drag = { slot, piece, lift, ox: null, oy: null, valid: false, chain: 0, pointerId: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now(),
    boardRect: renderer.pf.getBoundingClientRect(), approach: 0, movedAt: 0, lastD: null, lastT: 0 };
  dropHint();
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
  if (valid) {
    game.placePiece(slot, ox, oy);
    saveGame();
  }
  else { if (overBoard) sfx.invalid(); renderTray(); updateHint(); }
});
window.addEventListener('pointercancel', (e) => { if (mine(e)) cancelDrag(); });
// アプリの切り替え・通知などで指が離れたのが届かないことがある。そのときは持っているピースを戻す
window.addEventListener('blur', cancelDrag);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { cancelDrag(); saveBest(); saveGame(); }  // 途中でアプリを閉じてもベストスコアと盤面が残るように
});
window.addEventListener('pagehide', () => { saveBest(); saveGame(); });

/* ---------- 学習モード ---------- */
/**
 * 学習モードでは、次に置くとよいピースと場所を光らせる（Game.hint: 全消しの手順中はその手順、
 * それ以外は今の盤面での総当たり）。スコアとベストスコアは通常モードとは別
 */
let hintSeq = 0;               // おすすめを頼んだ回数（答えが届くまでに状況が変わったら、その答えは出さない）
function updateHint() {
  const seq = ++hintSeq;
  if (tutorial) { showTutorialTarget(); return; }
  if (mode !== 'learn' || game.gameOver || drag || pending > 1) {
    document.querySelectorAll('.slot.hinted').forEach((el) => el.classList.remove('hinted'));
    renderer.clearHint();
    return;
  }
  // 総当たりは別スレッドで（Game.hintAsync。答えは Game.hint と同じ）
  game.hintAsync().then((h) => {
    if (seq !== hintSeq || drag || game.gameOver) return;
    document.querySelectorAll('.slot.hinted').forEach((el) => el.classList.remove('hinted'));
    if (!h) { renderer.clearHint(); return; }
    renderer.showHint(game.tray[h.slot], h.ox, h.oy, h.plan);
    document.querySelector(`.slot[data-slot="${h.slot}"]`)?.classList.add('hinted');
  });
}
/** おすすめを消す（頼んでいる途中の答えも出さない） */
function dropHint() {
  hintSeq++;
  if (tutorial) { showTutorialTarget(); return; }     // チュートリアルでは置く場所を見せたまま、指の絵だけ消す
  renderer.clearHint();
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
  if (!pending) saveGame();                        // 切り替える前のモードの続きも残す（再生の途中なら、置いた時に残した分）
  mode = mode === 'learn' ? 'normal' : 'learn';
  try { localStorage.setItem(MODE_KEY, mode); } catch {}
  loadBest();
  applyMode();
  startOrResume();
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
  if (v) {
    const chain = Math.max(records.chain, tutorial ? 0 : game.score.bestChain), combo = Math.max(records.combo, tutorial ? 0 : game.score.bestStreak);
    $('pauseRecords').innerHTML = `記録　最大連鎖 ${chain}・最大コンボ ${combo}`;
  }
  $('pauseOverlay').classList.toggle('hidden', !v);
}
$('btnPause').addEventListener('click', () => { sfx.unlock(); if (!gameOverShown) setPaused(true); });
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

/* ---------- 途中から再開 ---------- */
/**
 * ゲームの途中の状態を端末に残し、次に開いたときはその盤面から続ける（説明などは出さない。モードごとに別）
 */
const saveKey = () => (mode === 'learn' ? 'stair-mancala-save-learn' : 'stair-mancala-save');
function saveGame() {
  if (tutorial) return;
  try {
    if (game.gameOver) { localStorage.removeItem(saveKey()); return; }
    localStorage.setItem(saveKey(), JSON.stringify({ state: game.exportState() }));
  } catch {}
}
function clearSave() { try { localStorage.removeItem(saveKey()); } catch {} }
function readSave() {
  try { const d = JSON.parse(localStorage.getItem(saveKey()) || 'null'); return d?.state?.v === 1 && !d.state.gameOver ? d : null; } catch { return null; }
}
/** 状態 st の盤面・トレイ・スコアをそのまま画面に出す（再生の途中のものは打ち切る） */
function showState(st) {
  generation++; queue = Promise.resolve(); pending = 0; rushBefore = 0; playLeft = 0;
  endDrag();
  game.importState(st);
  renderer.reset();
  scenes.clear();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  gameOverShown = false;
  renderTray(true);
  updateHud();
  bestCelebrated = best > 0 && game.score.score >= best;     // もう超えた記録で、もう一度お祝いしない
  updateDanger();
  updateDebug();
  updateHint();
}

/* ---------- 開始 ---------- */
function restart() {
  // ベストスコアは呼ぶ側で残しておく（ここで残すと、モードを切り替えたときに前のモードの点数が新しいモードのベストになる）
  stopTutorial();
  generation++; queue = Promise.resolve(); pending = 0; rushBefore = 0; playLeft = 0;
  bestCelebrated = false;
  clearSave();
  document.querySelector('.best-pill')?.classList.remove('beat');
  game.reset();
  endDrag();
  renderer.reset();
  scenes.clear();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  gameOverShown = false;
  setPaused(false);
  renderTray(true);
  updateHud();
  updateDanger();
  updateDebug();
  updateHint();
}
/** 保存があればその盤面から、無ければ新しいゲーム */
function startOrResume() {
  const saved = readSave();
  restart();
  if (saved) { showState(saved.state); saveGame(); }
}

/* ---------- チュートリアル（はじめて遊ぶ人向け。遊びながらルールを覚える） ---------- */
/**
 * 決めた盤面・手駒で1手ずつ置かせる（src/ui/tutorial-steps.js）。置く場所は金色の枠で示し、指の絵がトレイから運んで見せる。
 * 決めた場所にしか置けない（近くで離せば吸い付く）。補充・詰み・点数の記録・途中の保存は無し。
 * 最初に開いたとき（ベストスコアも途中の保存も無い）に出て、一時停止の「遊び方」からもう一度見られる。
 * 遊んでいる途中に見たときは、終わったらそのゲームの続きから
 */
const TUTORIAL_KEY = 'stair-mancala-tutorial';
const TUTORIAL_SNAP = 2.6;                       // 決めた場所へ吸い付く距離（マス）。慣れていない人でも置けるように広め
const TUTORIAL_SLOT = 1;                         // 手駒はまん中の枠に出す
function isFirstRun() {
  try {
    return ![TUTORIAL_KEY, 'stair-mancala-best', 'stair-mancala-best-learn', 'stair-mancala-save', 'stair-mancala-save-learn']
      .some((k) => localStorage.getItem(k));
  } catch { return false; }
}
/** 今置かせたい手（置いた後・最後の説明の間は null） */
function tutorialTarget() {
  const st = tutorial && !tutorial.placed && TUTORIAL_STEPS[tutorial.i];
  return st ? { slot: TUTORIAL_SLOT, ox: st.ox, oy: st.oy, piece: game.tray[TUTORIAL_SLOT] } : null;
}
function startTutorial() {
  saveBest();
  if (!pending) saveGame();                      // 遊んでいる途中のゲームは残しておき、終わったら続きから
  const first = TUTORIAL_STEPS[0];
  tutorial = { i: 0, placed: false };
  // トレイを空にすると手駒を決め始めてしまうので、最初の手駒を入れた状態から始める
  showState({ v: 1, board: [], tray: [null, first.piece, null], planTray: null, score: {}, gameOver: false, dealing: null });
  game.scripted = true;
  bestCelebrated = true;                         // チュートリアルの点数で新記録のお祝いはしない
  tutorialStep(0);
}
/** 連鎖の再生の速さ（チュートリアルで動きを見せたいステップはゆっくり） */
function tutorialSlow() { return (tutorial && TUTORIAL_STEPS[tutorial.i]?.slow) || 1; }
function tutorialStep(i) {
  tutorial.i = i; tutorial.placed = false;
  const st = TUTORIAL_STEPS[i];
  if (!st) { showTutorialText(TUTORIAL_END, true); showTutorialTarget(); return; }
  // 前のステップで残ったブロックはそのまま、足りないブロックだけ足す
  const added = [];
  for (const [x, r, color = 'blue'] of st.board) {
    if (game.board.get(x, r)) continue;
    const block = createBlock(color);
    game.board.set(x, r, block);
    added.push({ block, x, r });
  }
  if (added.length) { renderer.syncBoard(game.board); renderer.popIn(added); }
  game.tray = [null, null, null];
  game.tray[TUTORIAL_SLOT] = new Piece(st.piece);
  renderTray(true);
  if (i > 0) sfx.refill();
  showTutorialText(st.text, false);
  updateDanger();
  updateHint();
}
/** 置いた: 連鎖の再生中は「置いた後」の説明を出し、再生が終わったら次のステップへ */
function tutorialPlaced() {
  tutorial.placed = true;
  showTutorialTarget();
  const i = tutorial.i, st = TUTORIAL_STEPS[i];
  if (st.after) showTutorialText(st.after, false);
  enqueue(async () => {
    await renderer.wait(st.expectChain ? 1400 : 700);
    if (tutorial && tutorial.i === i) tutorialStep(i + 1);
  });
}
function showTutorialText(html, end) {
  const card = $('tutorial');
  $('tutText').innerHTML = html;
  $('tutStart').classList.toggle('hidden', !end);
  $('tutSkip').classList.toggle('hidden', end);
  document.body.classList.add('tutorial-on');
  card.classList.remove('hidden');
  card.animate([{ scale: '.94' }, { scale: '1.03', offset: 0.5 }, { scale: '1' }], { duration: 260, easing: 'ease-out' });
  placeTutorialText();
}
/**
 * 説明はスコアの場所（上のボタンと GOAL の間）に出す。盤面とトレイの間は狭い画面だと入らない。
 * 最後の説明（「はじめる」つき）は、もう置く物が無いので盤面の上に重ねる
 */
function placeTutorialText() {
  const card = $('tutorial');
  if (card.classList.contains('hidden')) return;
  const h = card.offsetHeight, headerBottom = document.querySelector('.top').getBoundingClientRect().bottom;
  const goalTop = $('goal').getBoundingClientRect().top;
  let top;
  if (!$('tutStart').classList.contains('hidden')) {
    const W = SIZE * renderer.cell;
    const boardBottom = Math.max(...[[0, 0], [W, 0], [0, W]].map(([x, y]) => renderer.localToClient(x, y).y));
    top = (goalTop + boardBottom) / 2 - h / 2;
  } else top = Math.max(headerBottom + 6, Math.min($('score').getBoundingClientRect().top, goalTop - h - 6));
  card.style.top = Math.round(top) + 'px';
}
/** 置く場所（金色の枠）・トレイの手駒の弾み・指の絵を出す（持っている間・置いた後は消す） */
function showTutorialTarget() {
  document.querySelectorAll('.slot.hinted').forEach((el) => el.classList.remove('hinted'));
  const t = tutorialTarget();
  if (!t || !t.piece || game.gameOver) { renderer.clearHint(); hideHand(); return; }
  renderer.showHint(t.piece, t.ox, t.oy, true);                     // 持っている間も置く場所は見せたまま
  if (drag) { hideHand(); return; }
  renderer.litLines((TUTORIAL_STEPS[tutorial.i].lit ?? []).map(([kind, n]) => ({ kind, n })), 'yellow');   // 見てほしいラインの番号
  document.querySelector(`.slot[data-slot="${t.slot}"]`)?.classList.add('hinted');
  moveHand();
}
/** 指の絵: トレイの手駒をつまんで、置く場所まで運んで離す（を繰り返す）。指で持つとピースは指より上に浮くので、そのぶん下を通る */
function moveHand() {
  const hand = $('tutHand');
  hand.__anim?.cancel();
  const t = tutorialTarget();
  const slotEl = t && document.querySelector(`.slot[data-slot="${t.slot}"]`);
  if (!slotEl || drag) { hand.classList.add('hidden'); return; }
  const a = slotEl.getBoundingClientRect();
  const from = { x: a.left + a.width / 2, y: a.top + a.height / 2 };
  const c = renderer.cell;
  const to = renderer.localToClient((t.ox + t.piece.width / 2) * c, (t.oy + t.piece.height / 2) * c);
  if (matchMedia('(pointer: coarse)').matches) to.y += c * (1.2 + Math.max(t.piece.width, t.piece.height) * 0.5);
  const at = (p, s) => `translate(${p.x - 20}px,${p.y - 1}px) scale(${s})`;   // 指先（絵の左上から 20px, 1px）を点に合わせる
  hand.classList.remove('hidden');
  hand.__anim = hand.animate([
    { transform: at(from, 0) },
    { transform: at(from, 1), offset: 0.1 },
    { transform: at(from, 0.86), offset: 0.2 },
    { transform: at(to, 0.86), offset: 0.62, easing: 'ease-out' },
    { transform: at(to, 1), offset: 0.74 },
    { transform: at(to, 1), offset: 0.88 },
    { transform: at(to, 0) },
  ], { duration: 2400, easing: 'ease-in-out' });
  hand.__anim.onfinish = () => { if (tutorialTarget()) moveHand(); else hideHand(); };
}
function hideHand() { const hand = $('tutHand'); hand.__anim?.cancel(); hand.classList.add('hidden'); }
function stopTutorial() {
  if (!tutorial) return;
  tutorial = null;
  try { localStorage.setItem(TUTORIAL_KEY, '1'); } catch {}
  $('tutorial').classList.add('hidden');
  $('tutSkip').classList.add('hidden');
  document.body.classList.remove('tutorial-on');
  hideHand();
  renderer.clearHint();
}
/** 「はじめる」「スキップ」: 本番のゲームへ（途中のゲームがあればその続き） */
function endTutorial() { sfx.unlock(); stopTutorial(); startOrResume(); }
$('tutStart').addEventListener('click', endTutorial);
$('tutSkip').addEventListener('click', endTutorial);
$('btnHowto').addEventListener('click', () => { sfx.unlock(); setPaused(false); startTutorial(); });

applyMode();
$('btnRetry').addEventListener('click', () => { sfx.unlock(); saveBest(); restart(); });
window.addEventListener('resize', () => {
  slotBoxCache = null;
  renderTray();
  // 持っているピースはマスの大きさが変わったので作り直す（盤面は renderer が先に合わせ直している）
  if (drag) { $('dragLayer').innerHTML = ''; drag.ox = null; updateDrag({ clientX: drag.x, clientY: drag.y }); }
  if (tutorial) { placeTutorialText(); showTutorialTarget(); }
});
const firstRun = isFirstRun();                   // 始める前に見る（始めると途中の保存ができる）
startOrResume();
if (firstRun) startTutorial();
// 宝石のかけらの絵（7色）と虹色の絵は、最初に使う瞬間に作ると一瞬止まるので、起動後の空き時間に作っておく（見た目は同じ）。
// まとめて作ると、それはそれで一瞬止まるので、1つずつ間をあけて
{
  const jobs = [...renderer.shardLayer.warmJobs(), ...scenes.warmJobs()];
  const idle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 120);
  const next = () => { const job = jobs.shift(); if (!job) return; job(); idle(next); };
  setTimeout(() => idle(next), 300);
}
window.__booted = true;
window.__game = game;
window.__renderer = renderer;
window.__scenes = scenes;
window.__ui = { showScore, renderTray, setBest(v) { best = v; }, pending: () => pending };

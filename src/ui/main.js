import { Game } from '../core/game.js?v=202610091551';
import { Board, createBlock } from '../core/board.js?v=202610091551';
import { Piece } from '../core/pieces.js?v=202610091551';
import * as Sim from '../core/sim.js?v=202610091551';
import { SIZE, ANIM, lineCells } from '../core/constants.js?v=202610091551';
import { Renderer, delay, markJoins, planSpeeds, turnPlayCost, PRAISE } from './renderer.js?v=202610091551';
import { Sfx, kitForScore } from './sfx.js?v=202610091551';
import { Scenes } from './scenes.js?v=202610091551';
import { Ambient } from './ambient.js?v=202610091551';
import { colorOf } from './palette.js?v=202610091551';
import { TrayDealer } from './tray-dealer.js?v=202610091551';
import { TUTORIAL_STEPS, TUTORIAL_END } from './tutorial-steps.js?v=202610091551';
import { GAME_NAME, gameUrl, displayUrl, migrateStorage, LOGO_PATH, LOGO_BG, LOGO_FG } from './brand.js?v=202610091551';
import { drawResultCard, cardBlob, CARD_W, CARD_H, CARD_BOARD } from './share-card.js?v=202610091551';
import { World, SEASON } from './world.js?v=202610091551';
import { topRuns, addRun, parseRanking, legacyRuns } from '../core/ranking.js?v=202610091551';
import { RECENT_GAMES } from '../core/difficulty.js?v=202610091551';
import { BOARD_THEMES, CUBE_BACKGROUND, WHITE_BACKGROUND, readBoardTheme, saveBoardTheme } from './board-themes.js?v=202610091551';
import { glassElement, GLASS_BACKGROUND } from './glass.js?v=202610091551';
import { softwareRendering } from './fx2d.js?v=202610091551';
import { useSprites } from './shards.js?v=202610091551';
import { chainTouchesPlacement } from './chain-overlap.js?v=202610091551';
import { BATTLE_SPEED } from '../core/battle.js?v=202610091551';
import { Versus, BATTLE_RATES, CPU_LEVELS, readRecords } from './versus.js?v=202610091551';
import { makeQr, drawQr } from './qr.js?v=202610091551';
import { BattleNet } from './net.js?v=202610091551';

const $ = (id) => document.getElementById(id);
/** 対戦（versus.js。下の「対戦」で作る）と、手駒を触れなくするとき（対戦のカウントダウン・結果） */
let versus = null;
let inputLocked = false;
let boardTheme = readBoardTheme();
document.documentElement.dataset.boardTheme = boardTheme;
const themeColor = (t) => (t === 'glass' ? GLASS_BACKGROUND : t === '3d' ? CUBE_BACKGROUND : t === 'white' ? WHITE_BACKGROUND : '#3a6adf');
document.querySelector('meta[name="theme-color"]').content = themeColor(boardTheme);
const sfx = new Sfx();
sfx.setBoardTheme(boardTheme);
sfx.bindGestures();
const renderer = new Renderer(sfx);
/** 画面全体の演出（新記録の風船・大連鎖やコンボの色の変化など。画面を覆う演出は使わない） */
const scenes = new Scenes({ sfx, colorOf });
/** 背景の色（今の青と同じ明るさのまま色相を回す。コンボ・連鎖・全消し・新記録で変わる。チュートリアル中は変えない） */
const ambient = new Ambient();
ambient.onChange = (look, ms) => renderer.view3d?.setBackground(look, ms);
ambient.bindBoard(renderer.plateSets);                     // 盤面の土台の色も、背景と一緒に変わる

/* ---------- ベストスコア・記録（端末ごと・シーズンごとに別。SEASON は world.js） ---------- */
// 端末に残す記録の名前はゲーム名（blockmancala-）で始める。前の名前で残っている記録は、読む前にここで移す
try { migrateStorage(localStorage); } catch {}
/** シーズンごとの記録の名前（シーズン 1 は -s の付かない名前のまま残っている） */
const seasonKey = (base, season = SEASON) => (season === 1 ? base : `${base}-s${season}`);
const bestKey = () => seasonKey('blockmancala-best');
let best = 0;
/** 最大連鎖・最大コンボの記録 */
const recordsKey = () => seasonKey('blockmancala-records');
let records = { chain: 0, combo: 0 };
/** 最近のゲームのスコア（新しい順、RECENT_GAMES 件まで）。ひっかけの確率を出来に合わせるのに使う（core/difficulty.js） */
const recentKey = () => seasonKey('blockmancala-recent');
let recent = [];
/** このゲームを始めたときのベストスコア（途中でベストを残しても変えない。超えたかどうかを見るため） */
let skillBest = 0;
function loadBest() {
  best = 0;
  recent = [];
  try { recent = (JSON.parse(localStorage.getItem(recentKey()) || '[]') || []).filter((n) => Number.isFinite(n)).slice(0, RECENT_GAMES); } catch {}
  records = { chain: 0, combo: 0 };
  try { best = Number(localStorage.getItem(bestKey())) || 0; } catch {}
  try { records = { ...records, ...JSON.parse(localStorage.getItem(recordsKey()) || '{}') }; } catch {}
  loadRanking();
  skillBest = best;
}
/** この端末のランキング（スコア。シーズンごとに別）。1ゲームずつ、終わったときに入れる */
const rankingKey = (season = SEASON) => seasonKey('blockmancala-ranking', season);
let ranking = [];
let lastRun = null;          // いちばん最近入れたゲーム（ランキングの中で色を付ける）
function loadRanking() {
  ranking = [];
  lastRun = null;
  try { ranking = parseRanking(localStorage.getItem(rankingKey())); } catch {}
}
/** シーズン 1 のこの端末のランキング（見るだけ。ランキングができる前のベストスコアも 1 件として入れる） */
function season1Local() {
  let text = null;
  try { text = localStorage.getItem(rankingKey(1)); } catch {}
  if (text != null) return parseRanking(text);
  let list = [];
  try { for (const run of legacyRuns(Number(localStorage.getItem('blockmancala-best')) || 0)) list = addRun(list, run).list; } catch {}
  return list;
}
loadBest();
/** チュートリアル中なら { i: ステップ, placed: 置いた（次のステップを待っている） }。チュートリアルの点数・盤面は残さない */
let tutorial = null;
/** 対戦中か（対戦ではベストスコア・記録・ランキング・途中の保存・学習モードのおすすめを使わない） */
const inBattle = () => !!versus?.active;
function saveBest() {
  if (inBattle()) return false;
  saveRecords();
  if (tutorial || game.score.score <= best) return false;
  best = game.score.score;
  try { localStorage.setItem(bestKey(), String(best)); } catch {}
  return true;
}

/** このゲームをランキングに入れる（1ゲームにつき1回。チュートリアルと 0 点は入れない）。この端末で何位に入ったかを返す（入らなければ 0） */
let runRecorded = false;
const world = new World();
world.flush();                                     // 前に送れなかった記録があれば送る
function recordRun() {
  if (runRecorded || tutorial || inBattle() || game.score.score <= 0) return null;
  runRecorded = true;
  const run = { score: game.score.score, at: Date.now() };
  recent = [run.score, ...recent].slice(0, RECENT_GAMES);
  try { localStorage.setItem(recentKey(), JSON.stringify(recent)); } catch {}
  const res = addRun(ranking, run);
  ranking = res.list;
  if (res.rank) lastRun = run;
  try { localStorage.setItem(rankingKey(), JSON.stringify(ranking)); } catch {}
  world.addRun(run.score); world.flush();          // 世界ランキング（今のシーズンのベスト・累計）
  return res.rank;
}

/** このゲームの最大連鎖・最大コンボを記録に残す。更新した方を返す（チュートリアルでは残さない） */
function saveRecords() {
  if (inBattle()) return { chain: false, combo: false };
  const { bestChain, bestStreak } = game.score;
  const up = { chain: !tutorial && bestChain > records.chain, combo: !tutorial && bestStreak > records.combo };
  if (!up.chain && !up.combo) return up;
  if (up.chain) records.chain = bestChain;
  if (up.combo) records.combo = bestStreak;
  try { localStorage.setItem(recordsKey(), JSON.stringify(records)); } catch {}
  return up;
}

/* ---------- ゲーム ---------- */

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

/** 連鎖の通り道に次のピースを置いたときだけ、音と動きを残して追いつく。 */
const OVERLAP_SPEED = 8;
const playingSpeed = () => (playingSeq && playingSeq < fastBefore ? OVERLAP_SPEED : 1);
const desiredSpeed = () => (paused ? 0 : battleLock() ? BATTLE_SPEED : Math.max(playingSpeed(), drag ? catchUpSpeed(performance.now()) : 1));
/**
 * 対戦のルール（CPU・オンラインとも）: 連鎖の再生はいつも、ピースを持っているときと同じ速さ（BATTLE_SPEED）で、再生が終わるまで次のピースは置けない。
 * どちらの画面でも連鎖の長さが同じになり、送ったおじゃま・届いたおじゃまが、順番どおりにきれいに並ぶ
 */
const battleLock = () => !!versus?.active;
/** 対戦で、再生中は手駒を薄くして「まだ置けない」と分かるように */
const syncLock = () => document.body.classList.toggle('vs-busy', battleLock() && pending > 0);
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
const HELD_SPEED = 3;
function catchUpSpeed(now) {
  if (!drag || !pending) return 1;
  return HELD_SPEED;                                    // ブロックを持っている間は、連鎖の再生をいつも 3 倍の速さにする（以下は使わない）
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
function playTick(now) {
  playRaf = 0;
  if (!pending) { playLeft = 0; return; }
  if (playLast) playLeft = Math.max(0, playLeft - Math.max(0, now - playLast) * renderer.timeScale);
  playLast = now;
  if (!paused) renderer.timeScale = desiredSpeed();
  playRaf = requestAnimationFrame(playTick);
}
function startPlayTick() { if (!playRaf) { playLast = 0; playRaf = requestAnimationFrame(playTick); } }
let turnSeq = 0;              // 置いた順の番号
let fastBefore = 0;           // この番号より前の干渉するターンを早送りする
let playingSeq = 0;
const playback = new Map();   // 再生待ち・再生中の各ターンと次のステップ
let kitScore = 0;             // 前のターンが終わったときのスコア。音のセット（ガラス → 木琴 → オルゴール）は、ターンの始まりのスコアで決める

/** 手駒の決め方は別スレッド（Web Worker）で動かす（ui/tray-dealer.js。置いた瞬間に画面が止まらないように） */
const dealer = new TrayDealer(new URL('../core/dealer-worker.js?v=202610091551', import.meta.url));
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
      // 音のセット: ターンの始まりのスコアで決める（連鎖の途中で楽器が替わらない）。スコアが KIT_EVERY 点進むごとに次のセットへ。チュートリアルは常にガラス
      turn.kit = tutorial ? 0 : kitForScore(kitScore);
      kitScore = turn.score;
      if (!pending) sfx.setKit(turn.kit);                    // 前のターンの再生が残っていれば、このターンの再生の始まり（playTurn）で替える
      // 置いたピースは即表示・トレイも即更新（すぐ次を置けるように。補充の手駒は届いたら onTray で出す）
      sfx.place(turn.placed.length, turn.kit);
      turn.seq = ++turnSeq;
      // 穴にぴったり・凹みを埋めて長方形: 置いた瞬間に手応え（連鎖の文字が出ればそちらで上書き）
      if (turn.fit === 'perfect' || turn.rect) {
        sfx.fit();
        renderer.showText(`${turn.fit === 'perfect' ? 'PERFECT FIT!' : 'NICE FIT!'}${inBattle() ? '' : `<small>+${turn.fitBonus.toLocaleString('en-US')}</small>`}`, 't2');
      }
      const overlaps = [...playback.values()].some(({ turn: prior, next }) => chainTouchesPlacement(prior.steps.slice(next), turn.placed));
      if (overlaps) { fastBefore = turn.seq; renderer.timeScale = desiredSpeed(); }
      // 干渉するブロックは、先の連鎖が通過するまで表示を待つ。そうしないと重なって見える。
      if (!overlaps) renderer.popIn(turn.placed, turn.fit === 'perfect' || !!turn.rect);
      else turn.deferPlace = true;
      dropHint();
      const refilledNow = turn.refilled && !turn.trayReady;
      renderTray(refilledNow && (turn.refillSlot ?? true));          // 対戦は、使った枠にだけ次の手駒が出てくる
      if (refilledNow) sfx.refill();
      updateDebug();
      pending++;
      playback.set(turn.seq, { turn, next: 0 });
      playLeft += turnPlayCost(turn);
      startPlayTick();
      if (inBattle()) versus.onLocalTurn(turn, playLeft / BATTLE_SPEED);
      syncLock();   // 対戦: 連鎖していれば相手へおじゃまを送る（届くのは、この再生が終わるころ）
      const gen = generation;
      enqueue(() => playTurn(turn)).finally(() => {
        if (gen !== generation) return;
        playback.delete(turn.seq);
        pending = Math.max(0, pending - 1);
        if (!pending) { playingSeq = 0; renderer.timeScale = paused ? 0 : 1; caughtUp(); }
        syncLock();
      });
      if (tutorial) tutorialPlaced();
    },
  },
});
/** ひっかけの確率を出来に合わせる（core/difficulty.js）。チュートリアル中はふつう */
Object.defineProperty(game, 'skill', { get: () => (tutorial ? null : { best: skillBest, recent, games: ranking.length }) });

const allClearText = (turn) => (inBattle() ? 'ALL CLEAR!' : `ALL CLEAR!<small>BONUS +${turn.allClearBonus.toLocaleString('en-US')}</small>`);   // 対戦では得点の数字は出さない

async function playTurn(turn) {
  // 途中でリスタート（モードの切り替えなど）したら、古いゲームの続き（点数・ゲームオーバー）は出さない
  const gen = generation, stale = () => gen !== generation;
  playingSeq = turn.seq;
  sfx.setKit(turn.kit ?? 0);                             // このターンの音のセット（前のターンの再生が終わってから替わる）
  renderer.timeScale = desiredSpeed();
  if (turn.deferPlace) renderer.popIn(turn.placed, turn.fit === 'perfect' || !!turn.rect);
  showScore(turn.scoreAfterPlace);
  if (!tutorial) ambient.turn(turn);                     // 背景の色（コンボが続くと色相が進む。早送りでも色は合わせる）
  const speeds = planSpeeds(turn.steps);
  if (turn.steps.length) {
    renderer.setFever((turn.streak - 1) / 5);
    if (turn.streak >= 2) { renderer.showCombo(turn.streak); sfx.combo(turn.streak); }
    if (turn.streak >= 5 && turn.streak % 5 === 0) scenes.comboWave();       // コンボ 5・10・15… で画面の下から桃色に染まる
  } else renderer.setFever(0);
  let shownTier = 0;                                       // このターンで画面の色を変えた褒め言葉の段階
  const explain = tutorial ? TUTORIAL_STEPS[tutorial.i]?.explain : null;   // チュートリアルで動きを1つずつ説明する
  for (const [i, step] of turn.steps.entries()) {
    const sp = speeds[i] * tutorialSlow();
    const ex = explain?.[i];
    if (ex?.full) { await explainFull(step, ex.full); if (stale()) return; }
    if (i === 0) await renderer.charge(step.kind, step.n, step.stack, ANIM.charge);
    if (stale()) return;
    await renderer.playStep(step, sp, ex && (ex.out || ex.enter) ? () => explainEnter(step, ex) : null);
    if (ex) { renderer.clearAnnotations(); renderer.litLines([]); }
    if (stale()) return;
    playback.get(turn.seq).next = i + 1;
    for (const h of turn.chip?.hits ?? []) if (h.step === i + 1) renderer.garbageHit(h);   // 対戦: 連鎖の 1 段ごとに、おじゃま 1 個を「−1」「−2」…
    const [, praise, tier] = PRAISE.find(([n]) => step.chain >= n) ?? [];
    if (step.chain >= 2) {
      renderer.showText(`${step.chain} CHAIN<small>${praise}</small>`, `t${tier}`);
      if (tier > shownTier) {                                  // 段階が上がった時だけ（毎回だと染まりっぱなしになる）
        shownTier = tier;
        sfx.praise(tier);                                      // 毎連鎖に和音を重ねず、段階の変化を聴かせる
        if (tier >= 4) { scenes.bigChain(tier); if (!tutorial) ambient.chain(tier); }    // Amazing 以上で画面全体の色が変わる
      } else if (step.chain >= 12 && step.chain % 4 === 0) { scenes.bigChain(5); if (!tutorial) ambient.chain(5); }   // 12・16・20…連鎖でもう一度
    }
    if (step.gained && !inBattle()) renderer.floatScore(step.gained, step.chain);        // 対戦では得点の数字は出さない
    showScore(step.score, true);
    await renderer.wait(ANIM.betweenChains / sp);
    if (stale()) return;
  }
  // 対戦: 連鎖の数だけ、盤面のおじゃまの数字が減る（ルールは置いた瞬間に確定している。ここで見せる）
  if (turn.allClear) {
    renderer.showText(allClearText(turn), 't5');
    renderer.allClearBlast();
    if (!tutorial) ambient.celebrate('clear');
  }
  showScore(turn.score);
  // 補充の手駒を別スレッドで決めているときは、届いてから（詰みの判定・ピンチ・おすすめは手駒で決まる）
  if (turn.trayReady) { await turn.trayReady; if (stale()) return; }
  updateDanger();
  if (pending <= 1) updateHint();                  // 再生待ちが無くなったら、次のおすすめを出す
  if (turn.gameOver && inBattle()) { await battleLost(); return; }
  if (turn.gameOver) {
    await renderer.wait(350);
    if (stale()) return;
    renderer.setFever(0);
    ambient.settle();
    sfx.over();
    gameOverShown = true;
    const prev = { ...records };
    const isBest = saveBest();
    const rank = recordRun();
    $('btnOverRank').textContent = rank ? 'ランクイン！ ランキングを見る' : 'ランキングを見る';
    $('btnOverRank').classList.toggle('ranked', !!rank);
    $('finalScore').textContent = game.score.score.toLocaleString('en-US');
    showOverStats(prev);
    $('finalBest').textContent = isBest ? '👑 NEW BEST!' : `👑 ${best.toLocaleString('en-US')}`;
    clearSave();
    $('gameOver').classList.remove('hidden');
    prepareShare({ score: game.score.score, chain: game.score.bestChain, combo: game.score.bestStreak, best: isBest, theme: boardTheme,
      board: [...game.board.entries()].map(({ block, x, r }) => [x, r, block.color]) });
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
    ambient.celebrate('best');
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
  const vertical = cols?.gridTemplateColumns.split(' ').length === 1;
  const rowGap = cols ? parseFloat(cols.rowGap) || 0 : 0;
  const padY = cols ? parseFloat(cols.paddingTop) + parseFloat(cols.paddingBottom) : 0;
  const box = vertical
    ? { width: wrap.clientWidth - pad, height: (wrap.clientHeight - padY - rowGap * 2) / 3 }
    : { width: (wrap.clientWidth - pad - gap * 2) / 3, height: wrap.clientHeight - padY };
  if (wrap.clientWidth) slotBoxCache = box;                 // まだ並んでいない（幅 0）ときは覚えない
  return box;
}
try { new ResizeObserver(() => { slotBoxCache = null; slotCenterCache = null; }).observe($('tray')); } catch {}
/** enter = true（全部の枠）/ 枠の番号（その枠だけ）: 手駒が出てくる動き */
function renderTray(enter = false) {
  const wrap = $('tray');
  const slotBox = measureSlotBox(wrap);                     // 中身を消す前に測る（消した後だと、その場でレイアウトの計算になる）
  wrap.innerHTML = '';
  game.tray.forEach((piece, i) => {
    const slot = document.createElement('div');
    const anim = enter === true || enter === i;
    slot.className = 'slot' + (anim ? ' enter' : '') + (drag?.slot === i ? ' dragging' : '');
    slot.dataset.slot = i;
    if (anim && enter === true) slot.style.setProperty('animation-delay', `${i * 50}ms`);
    if (piece) {
      const s = trayCellSize(piece, slotBox);
      const box = document.createElement('div');
      box.className = 'piece';
      box.style.width = piece.width * s + 'px';
      box.style.height = piece.height * s + 'px';
      // 形の外接四角ではなく、実際のマスが見えている範囲の中心を枠の中心に合わせる
      const mid = pieceScreenCenter(piece, s);
      box.style.translate = `${-mid.x}px ${-mid.y}px`;
      if (anim && enter === true) box.style.animationDelay = `${i * 60}ms`;
      const joinEls = [];
      for (const c of piece.cells) {
        const d = document.createElement('div');
        d.className = `tray-cell c-${piece.color}`;
        Object.assign(d.style, { width: s + 'px', height: s + 'px', left: c.x * s + 'px', top: c.y * s + 'px' });
        box.appendChild(d); joinEls.push({ x: c.x, y: c.y, color: piece.color, el: d });
      }
      markJoins(joinEls);
      if (boardTheme === 'glass') box.appendChild(glassElement(piece.cells, piece.color, s));
      slot.appendChild(box);
    }
    wrap.appendChild(slot);
  });
  if (renderer.view3d) tray3d(enter === true);
}
/** 手駒の枠の中心（画面座標）。測るとレイアウトの計算し直しになるので、トレイの大きさが変わったときだけ測り直す */
let slotCenterCache = null;
function slotCenters() {
  if (slotCenterCache) return slotCenterCache;
  const list = [...document.querySelectorAll('#tray .slot')].map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
  });
  if (list.length === 3 && list.every((p) => p.x || p.y)) slotCenterCache = list;
  return list;
}
/** 3D の手駒: 2D と同じ大きさ・同じ場所・同じ向きに、ガラスの立方体で描く（cube3d.js） */
function tray3d(enter = false) {
  const view = renderer.view3d;
  if (!view) return;
  const box = measureSlotBox($('tray')), centers = slotCenters();
  view.setTray(game.tray.map((piece, i) => {
    if (!piece || !centers[i]) return null;
    const s = trayCellSize(piece, box), mid = pieceScreenCenter(piece, s);
    return { cells: piece.cells, color: piece.color, s, width: piece.width, height: piece.height, center: { x: centers[i].x - mid.x, y: centers[i].y - mid.y } };
  }), enter);
  view.setTrayState({ dragging: drag ? drag.slot : -1, hint: hintedSlot });
}
/** 学習モード・チュートリアルで弾ませる手駒（-1 = なし） */
let hintedSlot = -1;
function setHintedSlot(i) {
  hintedSlot = i;
  document.querySelectorAll('.slot.hinted').forEach((el) => el.classList.remove('hinted'));
  if (i >= 0) document.querySelector(`.slot[data-slot="${i}"]`)?.classList.add('hinted');
  renderer.view3d?.setTrayState({ hint: i });
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
  // 本番と同じく、縦横の両方が満杯のときは残りの手駒で詰まない向きを選ぶ
  const rest = game.tray.filter((p, i) => p && i !== drag?.slot).map((p) => p.cells);
  const chain = Sim.resolveAll(s, Sim.restOf(rest));
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
    const joinEls = [];
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `drag-cell c-${piece.color}`;
      d.style.left = (cc.x - piece.width / 2) * c + 'px';
      d.style.top = (cc.y - piece.height / 2) * c + 'px';
      layer.appendChild(d); joinEls.push({ x: cc.x, y: cc.y, color: piece.color, el: d });
    }
    markJoins(joinEls);
    if (boardTheme === 'glass') {
      const surface = glassElement(piece.cells, piece.color, c);
      surface.style.marginLeft = -piece.width * c / 2 + 'px';
      surface.style.marginTop = -piece.height * c / 2 + 'px';
      layer.appendChild(surface);
    }
  }
  // 動かすのは transform だけ（left / top を書くと、そのたびにレイアウトと描き直しになる。合成だけで動く）
  layer.style.transform = `translate(${cx}px,${cy}px) ${renderer.boardTransform()}`;
  renderer.view3d?.drag({ piece, x: cx, y: cy });      // 3D: ガラスのピースが盤面から少し浮いて付いてくる
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
  if (pending > 0 && !paused) renderer.timeScale = desiredSpeed();
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
  renderer.view3d?.drag(null);
  renderer.view3d?.setTrayState({ dragging: -1 });
  drag = null;
  renderer.timeScale = desiredSpeed();
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
  if (!hitSlot || gameOverShown || drag || paused || inputLocked || (battleLock() && (pending > 0 || game.gameOver))) return;   // 対戦では、連鎖の再生中は置けない（おじゃまの演出中は置ける）
  const slot = Number(hitSlot.dataset.slot);
  const slotEl = document.querySelector(`.slot[data-slot="${slot}"]`);
  const piece = game.tray[slot];
  if (!piece) return;
  sfx.unlock(true);
  sfx.pick();
  const lift = e.pointerType === 'mouse' ? 0 : renderer.cell * (1.2 + Math.max(piece.width, piece.height) * 0.5);
  drag = { slot, piece, lift, ox: null, oy: null, valid: false, chain: 0, pointerId: e.pointerId, x: e.clientX, y: e.clientY, t0: performance.now(),
    boardRect: renderer.pf.getBoundingClientRect(), approach: 0, movedAt: 0, lastD: null, lastT: 0 };
  dropHint();
  slotEl.classList.add('dragging');
  renderer.view3d?.setTrayState({ dragging: slot });
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
  if (document.hidden) {
    cancelDrag(); saveBest(); saveGame(); sfx.markStale();   // 途中でアプリを閉じてもベストスコアと盤面が残るように
    // CPU との対戦は、裏にいる間も CPU だけ進んでしまうので一時停止にする（オンラインは止められない）
    if (inBattle() && versus.kind === 'cpu' && !versus.ended && !paused && !gameOverShown) setPaused(true);
  }
  else sfx.unlock();   // 画面に戻ってきたとき: まず再開を試す（iOS はこの後の最初の操作で音を作り直す）
});
window.addEventListener('pagehide', () => { saveBest(); saveGame(); });

/* ---------- チュートリアルの置く場所の印 ---------- */
let hintSeq = 0;
function updateHint() {
  hintSeq++;
  if (tutorial) { showTutorialTarget(); return; }
  setHintedSlot(-1);
  renderer.clearHint();
}
/** おすすめを消す（頼んでいる途中の答えも出さない） */
function dropHint() {
  hintSeq++;
  if (tutorial) { showTutorialTarget(); return; }     // チュートリアルでは置く場所を見せたまま、指の絵だけ消す
  renderer.clearHint();
}
/** 左上のリセットボタン: 今のゲームを打ち切って最初からにする（ゲームオーバーの「もう一度」と同じ） */
$('btnReset').addEventListener('click', () => { sfx.unlock(); if (inBattle()) return; saveBest(); recordRun(); restart(); });
/* ---------- サウンド ---------- */
function updateSoundButton() {
  $('btnSound').classList.toggle('off', !sfx.enabled);
  $('btnSound').setAttribute('aria-pressed', String(sfx.enabled));
}
updateSoundButton();
$('btnSound').addEventListener('click', () => {
  sfx.unlock();
  sfx.enabled = !sfx.enabled;
  updateSoundButton();
});

/* ---------- 一時停止 ---------- */
let paused = false;
/** 一時停止: 連鎖の再生も止める（持っているピースは戻す） */
function setPaused(v) {
  paused = v;
  versus?.setPaused(v);
  if (v) cancelDrag();
  renderer.timeScale = desiredSpeed();
  renderer.setPaused(v);
  sfx.setPaused(v);
  if (v) {
    const chain = Math.max(records.chain, tutorial ? 0 : game.score.bestChain), combo = Math.max(records.combo, tutorial ? 0 : game.score.bestStreak);
    $('pauseRecords').innerHTML = `記録　最大連鎖 ${chain}・最大コンボ ${combo}`;
  }
  $('pauseOverlay').classList.toggle('hidden', !v);
  if (v) render3dPreview();
}
$('btnPause').addEventListener('click', () => { sfx.unlock(); if (!gameOverShown) setPaused(true); });
$('btnResume').addEventListener('click', () => setPaused(false));

/* ---------- 盤面の種類 ---------- */
function applyBoardTheme(value) {
  cancelDrag();
  boardTheme = saveBoardTheme(value);
  sfx.setBoardTheme(boardTheme);
  document.documentElement.dataset.boardTheme = boardTheme;
  document.querySelector('meta[name="theme-color"]').content = themeColor(boardTheme);
  if (boardTheme === '3d') enable3d(); else disable3d();
  renderer.layout();
  renderer.refreshGlass();
  versus?.view.r.layout();                         // 対戦の相手の盤面も同じ見た目に
  versus?.view.r.refreshGlass();
  renderTray();
  for (const radio of $('boardThemeList').querySelectorAll('input')) radio.checked = radio.value === boardTheme;
}

/* ---------- 3D の盤面（ガラスの立方体。cube3d.js と three.js は、3D を選んだときだけ読み込む） ---------- */
/**
 * 読み込んでいる間は盤面を隠し（html の data-gl が無い）、描けるようになったら data-gl="on"（2D のブロック・手駒・持っているピースは隠れ、
 * WebGL の canvas が描く）。WebGL2 が無い・読み込めない・途中で描けなくなったときは data-gl="off"（宝石の見た目で遊べる）
 */
let cube3dLoad = null;
function load3d() {
  cube3dLoad ??= import('./cube3d.js?v=202610091551').then((m) => {
    if (!m.supported()) throw Object.assign(new Error('WebGL2 is not available'), { unsupported: true });
    const view = new m.Cube3D(renderer, { software: softwareRendering() });
    // 描けなくなったら（WebGL を取り上げられた・シェーダーが動かない）、2D の見た目（宝石）でそのまま遊べるようにする。戻ってきたら 3D に戻す
    view.onLost = () => {
      if (renderer.view3d !== view) return;
      renderer.view3d = null;
      view.detach();
      document.documentElement.dataset.gl = 'off';          // 2D のブロック・手駒は位置を保ったまま隠していただけなので、そのまま見える
      useSprites(null);
    };
    view.onRestored = () => { if (boardTheme === '3d' && !renderer.view3d) enable3d(); };
    return view.prepare().then(() => view);
  }).catch((e) => { if (!e.unsupported) cube3dLoad = null; throw e; });   // 通信の失敗なら、次はもう一度読み込む
  return cube3dLoad;
}
function enable3d() {
  if (renderer.view3d) return;
  delete document.documentElement.dataset.gl;
  load3d().then((view) => {
    if (boardTheme !== '3d' || renderer.view3d) return;
    if (view.lost || view.failed) { document.documentElement.dataset.gl = 'off'; return; }
    renderer.view3d = view;
    view.attach();
    view.setBackground(ambient.currentLook);
    view.setPaused(paused);
    document.documentElement.dataset.gl = 'on';
    renderTray();
    // かけら・紙吹雪も、ガラスの立方体の絵にする（色ごとに 1 回だけ描く）
    try { glassSprites ??= view.sprites(64); useSprites(glassSprites); } catch (e) { console.error(e); }
  }).catch((e) => {
    console.error(e);
    if (boardTheme === '3d') document.documentElement.dataset.gl = 'off';
  });
}
let glassSprites = null;
function disable3d() {
  delete document.documentElement.dataset.gl;
  useSprites(null);
  const view = renderer.view3d;
  if (!view) return;
  renderer.view3d = null;
  view.detach();
}
function renderBoardThemeList() {
  const miniCells = [];
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4 - y; x++) miniCells.push({ x, y });
  const pieces = [
    { color: 'green', cells: [{ x: 0, y: 1 }, { x: 0, y: 2 }, { x: 1, y: 1 }] },
    { color: 'purple', cells: [{ x: 1, y: 0 }, { x: 2, y: 0 }] },
    { color: 'yellow', cells: [{ x: 1, y: 2 }] },
  ];
  for (const theme of BOARD_THEMES) {
    const label = document.createElement('label');
    label.className = `board-theme-option preview-${theme.id}`;
    const radio = document.createElement('input');
    radio.type = 'radio'; radio.name = 'board-theme'; radio.value = theme.id; radio.checked = theme.id === boardTheme;
    radio.setAttribute('aria-label', theme.name);
    radio.addEventListener('change', () => { if (radio.checked) applyBoardTheme(theme.id); });
    const card = document.createElement('span'); card.className = 'board-theme-card';
    const preview = document.createElement('span'); preview.className = 'board-theme-preview'; preview.setAttribute('aria-hidden', 'true');
    const board = document.createElement('span'); board.className = 'board-theme-mini';
    if (theme.id === 'glass') {
      board.appendChild(glassElement(miniCells, 'purple', 19, { plate: true }));
      for (const piece of pieces) board.appendChild(glassElement(piece.cells, piece.color, 19));
    } else {
      for (const c of miniCells) {
        const well = document.createElement('i'); well.className = 'cell well';
        well.style.transform = `translate(${c.x * 19}px,${c.y * 19}px)`;
        board.appendChild(well);
      }
      for (const piece of pieces) {
        const joinEls = [];
        for (const c of piece.cells) {
        const block = document.createElement('i'); block.className = `cell block c-${piece.color}`;
        joinEls.push({ x: c.x, y: c.y, color: piece.color, el: block });
        block.style.transform = `translate(${c.x * 19}px,${c.y * 19}px)`;
        board.appendChild(block);
        }
        markJoins(joinEls);
      }
    }
    preview.appendChild(board);
    if (theme.id === '3d') {
      // 3D の見本は、選んだときと同じ描き方（cube3d.js）で描いた絵。一時停止の画面を開いたときに作る（render3dPreview）
      const shot = document.createElement('img'); shot.className = 'board-theme-shot'; shot.alt = ''; shot.hidden = true;
      preview.appendChild(shot);
    }
    const name = document.createElement('span'); name.className = 'board-theme-name'; name.textContent = theme.name;
    const status = document.createElement('span'); status.className = 'board-theme-status'; status.textContent = '選択中';
    card.append(preview, name, status); label.append(radio, card); $('boardThemeList').appendChild(label);
    radio.title = theme.description;
  }
}
renderBoardThemeList();
if (boardTheme === '3d') enable3d();
/** 一時停止の画面の 3D の見本（ガラスの立方体を並べた小さな盤面）を、実物と同じ描き方で 1 回だけ作る */
let preview3d = null;
const PREVIEW_3D = [[0, 0, 'blue'], [1, 0, 'blue'], [0, 1, 'cyan'], [2, 0, 'yellow'], [3, 0, 'red'], [3, 1, 'red'],
  [1, 1, 'green'], [1, 2, 'green'], [0, 3, 'purple'], [0, 2, 'orange']];
function render3dPreview() {
  if (preview3d) return;
  const box = document.querySelector('.preview-3d .board-theme-preview');
  if (!box) return;
  preview3d = 'pending';
  load3d().then((view) => new Promise((resolve, reject) => requestAnimationFrame(() => {
    if (view.failed) { reject(Object.assign(new Error('3D shaders failed'), { unsupported: true })); return; }
    if (view.lost) { preview3d = null; resolve(); return; }
    const w = box.clientWidth, h = box.clientHeight;
    if (!w || !h) { preview3d = null; resolve(); return; }
    const k = Math.min(2, window.devicePixelRatio || 1), cell = Math.min(w / 8.4, h / 5.1) * k;
    const cv = view.snapshot({ width: Math.round(w * k), height: Math.round(h * k), cx: w * k / 2, cy: h * k * 0.2, cell, size: 5, blocks: PREVIEW_3D });
    const img = box.querySelector('.board-theme-shot');
    img.src = cv.toDataURL('image/png');
    img.hidden = false;
    preview3d = 'done';
    resolve();
  }))).catch((e) => {
    console.error(e);
    preview3d = null;                              // 通信の失敗なら、次に開いたときにもう一度
    if (!e.unsupported) return;
    // この端末では 3D を選べない（WebGL2 が無いなど）
    preview3d = 'unsupported';
    const radio = $('boardThemeList').querySelector('input[value="3d"]');
    if (radio && boardTheme !== '3d') { radio.disabled = true; radio.closest('.board-theme-option')?.classList.add('unavailable'); }
  });
}

/* ---------- ランキング（シーズンごと。世界: ベスト・累計・レート / この端末） ---------- */
let rankScope = 'world';
let rankKind = 'best';                             // 世界ランキングの種類: best = ベストスコア / total = 累計スコア / rate = オンライン対戦のレート
let rankSeason = SEASON;                           // 見ているシーズン（前のシーズンは「シーズン1の結果」から）
let rankToken = 0;                                 // 読み込み中に切り替えたら、前の結果は捨てる
let pausedBeforeRank = false;
const fmtNum = (v) => v.toLocaleString('en-US');
function fmtDate(at) {
  if (!at) return '以前の記録';
  const d = new Date(at);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}
const esc = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
/** 1行: 順位・値・名前（世界）か日付（この端末）・小さな説明（ゲーム数・勝ち負け） */
function rankRow(rank, value, { name = null, date = null, sub = null, cls = '', dim = false } = {}) {
  const li = document.createElement('li');
  li.className = 'rank-row' + (rank <= 3 ? ` top${rank}` : '') + cls;
  li.innerHTML = `<span class="rank-no">${rank}</span>`
    + `<span class="rank-main"><b>${fmtNum(value)}</b>`
    + (sub != null ? `<span class="rank-sub">${esc(sub)}</span>` : '')
    + (name != null ? `<span class="rank-player${dim ? ' rank-hidden' : ''}">${esc(name)}</span>` : '')
    + (date != null ? `<span class="rank-date">${date}</span>` : '') + `</span>`;
  return li;
}
function rankMessage(text) {
  const li = document.createElement('li');
  li.className = 'rank-empty';
  li.textContent = text;
  $('rankList').replaceChildren(li);
}
function renderRanking() {
  const past = rankSeason !== SEASON;
  if (past) rankKind = 'best';                     // シーズン 1 はベストスコアだけ
  $('rankSeason').textContent = `シーズン${rankSeason}`;
  $('rankSeason').classList.toggle('past', past);
  $('rankSeasonBtn').textContent = past ? `シーズン${SEASON}（いま）にもどる` : 'シーズン1の結果を見る';
  for (const b of document.querySelectorAll('.rank-scope-btn')) b.classList.toggle('on', b.dataset.scope === rankScope);
  const isWorld = rankScope === 'world';
  $('rankKinds').classList.toggle('hidden', !isWorld || past);
  for (const b of document.querySelectorAll('.rank-kind-btn')) b.classList.toggle('on', b.dataset.kind === rankKind);
  const needsName = isWorld && !past && !world.named;   // 世界ランキングは、なまえを決めるまで参加できない
  $('rankName').classList.toggle('hidden', !isWorld || needsName || past);
  $('rankNameText').textContent = world.name || '';
  $('rankNamePrompt').classList.toggle('hidden', !needsName);
  const note = past ? 'シーズン1の結果です（もう記録は増えません）'
    : isWorld && rankKind === 'total' ? 'このシーズンに遊んだゲームのスコアの合計'
    : isWorld && rankKind === 'rate' ? 'オンライン対戦の「レート戦」のレート（1000 から）' : '';
  $('rankNote').textContent = note;
  $('rankNote').classList.toggle('hidden', !note || needsName);
  $('rankMe').classList.add('hidden');
  $('rankList').classList.toggle('hidden', needsName);
  $('rankList').scrollTop = 0;
  if (needsName) { rankToken++; $('rankNamePromptInput').value = ''; $('rankNamePromptInput').focus(); return; }
  if (isWorld) renderWorld(); else renderLocal();
}
function renderLocal() {
  const past = rankSeason !== SEASON;
  const top = topRuns(past ? season1Local() : ranking);
  if (!top.length) return rankMessage('まだ記録がありません');
  $('rankList').replaceChildren(...top.map((r, i) =>
    rankRow(i + 1, r.score, { date: fmtDate(r.at), cls: !past && r === lastRun ? ' latest' : '' })));
}
/** 世界ランキング: 最下位まで、スクロールで続きを読み足していく（1回に数十人ずつ） */
let worldPage = null;                              // { token, next: 次に読む順位 - 1, total, loading, failed, season, kind }
const subOf = (kind, r) => (kind === 'rate' ? `${r.wins ?? 0}勝${(r.games || 0) - (r.wins ?? 0)}敗` : null);
async function renderWorld() {
  const token = ++rankToken, season = rankSeason, kind = rankKind;
  worldPage = null;
  rankMessage('読み込み中…');
  let data;
  try { data = await world.fetchTop(0, { season, kind }); } catch { data = null; }
  if (token !== rankToken || rankScope !== 'world') return;
  if (!data) return rankMessage('世界ランキングにつながりませんでした');
  if (!data.top.length) rankMessage(kind === 'rate' ? 'まだレート戦をした人がいません' : 'まだ記録がありません');
  else $('rankList').replaceChildren(...worldRows(data.top, kind));
  worldPage = { token, next: data.top.length, total: data.total ?? data.top.length, loading: false, failed: false, season, kind };
  if (data.me) {
    const unit = kind === 'rate' ? '' : '点';
    $('rankMe').innerHTML = `あなた　<b>${fmtNum(data.me.rank)}位</b>　${kind === 'rate' ? 'レート ' : ''}${fmtNum(data.me.score)}${unit}`
      + (worldPage.total ? `<span class="rank-total">／${fmtNum(worldPage.total)}人中</span>` : '');
    $('rankMe').classList.remove('hidden');
  }
  moreWorld();                                     // 画面に余白があれば、スクロールしなくても続きを読む
}
const worldRows = (top, kind) => top.map((r) => rankRow(r.rank, r.score, { name: r.name, sub: subOf(kind, r), cls: r.me ? ' latest' : '', dim: !!r.hidden }));
/** 一覧の下の端が近づいたら続きを読む（最下位まで） */
async function moreWorld() {
  const p = worldPage, list = $('rankList');
  if (!p || p.loading || p.failed || p.token !== rankToken || p.next >= p.total) return;
  if (list.scrollTop + list.clientHeight < list.scrollHeight - 300) return;
  p.loading = true;
  const tail = document.createElement('li');
  tail.className = 'rank-empty rank-more';
  tail.textContent = '読み込み中…';
  list.append(tail);
  let data;
  try { data = await world.fetchTop(p.next, { season: p.season, kind: p.kind }); } catch { data = null; }
  tail.remove();
  if (p !== worldPage || p.token !== rankToken || rankScope !== 'world') return;
  p.loading = false;
  if (!data || !data.top.length) { p.failed = !data; if (data) p.total = p.next; return; }
  list.append(...worldRows(data.top, p.kind));
  p.next += data.top.length;
  p.total = data.total ?? p.total;
  moreWorld();
}
for (const b of document.querySelectorAll('.rank-kind-btn')) b.addEventListener('click', () => { rankKind = b.dataset.kind; renderRanking(); });
$('rankSeasonBtn').addEventListener('click', () => { rankSeason = rankSeason === SEASON ? 1 : SEASON; renderRanking(); });
$('rankList').addEventListener('scroll', () => { if (rankScope === 'world') moreWorld(); }, { passive: true });
/** ゲーム中に開いたら、一時停止と同じように連鎖の再生を止める（とじたら戻す） */
function openRanking(kind = null) {
  pausedBeforeRank = paused;
  paused = true;
  cancelDrag();
  renderer.timeScale = 0;
  editName(false);
  rankSeason = SEASON;
  if (kind) { rankScope = 'world'; rankKind = kind; }
  renderRanking();
  $('rankOverlay').classList.remove('hidden');
}
function closeRanking() {
  rankToken++;
  editName(false);
  paused = pausedBeforeRank;
  renderer.timeScale = desiredSpeed();
  $('rankOverlay').classList.add('hidden');
}
/** 名前の変更: 「変更」で入力欄、「決定」（または Enter）でサーバーへ */
let editingName = false;
function editName(on) {
  editingName = on;
  $('rankNameText').classList.toggle('hidden', on);
  $('rankNameInput').classList.toggle('hidden', !on);
  $('rankNameBtn').textContent = on ? '決定' : '変更';
  if (on) { $('rankNameInput').value = world.name; $('rankNameInput').focus(); $('rankNameInput').select(); }
  else $('rankNameInput').blur();
}
async function commitName() {
  const changed = $('rankNameInput').value.trim() !== world.name && world.setName($('rankNameInput').value);
  editName(false);
  $('rankNameText').textContent = world.name;
  if (changed) { await world.flush(true); if (rankScope === 'world') renderWorld(); }
}
$('rankNameBtn').addEventListener('click', () => (editingName ? commitName() : editName(true)));
$('rankNameInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitName(); } });
/** はじめて世界ランキングを開いたときの、なまえの入力（空では決められない） */
async function commitNamePrompt() {
  if (!world.setName($('rankNamePromptInput').value)) { $('rankNamePromptInput').focus(); return; }
  await world.flush(true);
  renderRanking();
}
$('rankNamePromptBtn').addEventListener('click', commitNamePrompt);
$('rankNamePromptInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commitNamePrompt(); } });
for (const b of document.querySelectorAll('.rank-scope-btn')) {
  b.addEventListener('click', () => { rankScope = b.dataset.scope; renderRanking(); });
}
$('btnRank').addEventListener('click', () => { sfx.unlock(); if (!gameOverShown) openRanking(); });
$('btnOverRank').addEventListener('click', () => openRanking('best'));
$('rankClose').addEventListener('click', closeRanking);

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
const saveKey = () => seasonKey('blockmancala-save');      // シーズン 1 の途中のゲーム（前のスコアの計算）は続けない
function saveGame() {
  if (tutorial || inBattle()) return;
  try {
    if (game.gameOver) { localStorage.removeItem(saveKey()); return; }
    localStorage.setItem(saveKey(), JSON.stringify({ state: game.exportState() }));
  } catch {}
}
function clearSave() { if (inBattle()) return; try { localStorage.removeItem(saveKey()); } catch {} }
function readSave() {
  try { const d = JSON.parse(localStorage.getItem(saveKey()) || 'null'); return d?.state?.v === 1 && !d.state.gameOver ? d : null; } catch { return null; }
}
/** 状態 st の盤面・トレイ・スコアをそのまま画面に出す（再生の途中のものは打ち切る） */
function showState(st) {
  generation++; queue = Promise.resolve(); pending = 0; fastBefore = 0; playingSeq = 0; playback.clear(); playLeft = 0;
  endDrag();
  game.importState(st);
  kitScore = game.score.score || 0; sfx.setKit(tutorial ? 0 : kitForScore(kitScore));      // 途中から続けるときは、そのスコアの音のセットから
  renderer.reset();
  scenes.clear();
  ambient.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  dropShare();
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
  skillBest = best;
  generation++; queue = Promise.resolve(); pending = 0; fastBefore = 0; playingSeq = 0; playback.clear(); playLeft = 0;
  bestCelebrated = false;
  runRecorded = false;
  clearSave();
  kitScore = 0; sfx.setKit(0);
  document.querySelector('.best-pill')?.classList.remove('beat');
  game.reset();
  endDrag();
  renderer.reset();
  scenes.clear();
  ambient.reset();
  renderer.bindBoard(game.board);
  $('gameOver').classList.add('hidden');
  dropShare();
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
 * 一時停止・ゲームオーバーの「遊び方」から開く（初回も自動では出さない）。
 * 遊んでいる途中に見たときは、終わったらそのゲームの続きから
 */
const TUTORIAL_SNAP = 2.6;                       // 決めた場所へ吸い付く距離（マス）。慣れていない人でも置けるように広め
const TUTORIAL_SLOT = 1;                         // 手駒はまん中の枠に出す
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
/**
 * 置いた: 連鎖の再生中は「置いた後」の説明を出し、再生が終わったら次のステップへ。
 * 動きを説明するステップ（explain）は、再生が終わってから「置いた後」の説明（まとめ）を出し、タップで次へ
 */
function tutorialPlaced() {
  tutorial.placed = true;
  showTutorialTarget();
  const i = tutorial.i, st = TUTORIAL_STEPS[i];
  if (st.explain) {
    enqueue(async () => {
      if (!tutorial || tutorial.i !== i) return;
      showTutorialText(st.after, false);
      await waitTap();
      if (tutorial && tutorial.i === i) tutorialStep(i + 1);
    });
    return;
  }
  if (st.after) showTutorialText(st.after, false);
  enqueue(async () => {
    await renderer.wait(st.expectChain ? 1400 : 700);
    if (tutorial && tutorial.i === i) tutorialStep(i + 1);
  });
}
/**
 * ブロックの動きの説明（本物の盤面で、再生を止めながら）:
 *  explainFull  = 満杯になったラインのマスを金色の枠で囲み、番号を光らせる（少し見せたら自動で進む）
 *  explainEnter = 先頭が GOAL に入ったところで止める（out）。続けて、残りのブロックが止まるマスに印を出し、
 *                 入る先のラインの番号をブロックの色で光らせる（enter。押しこまれるブロックの行き先にも印）。どちらもタップで次へ
 */
async function explainFull(step, text) {
  const color = step.stack[0]?.color ?? 'yellow';
  renderer.annotate(lineCells(step.kind, step.n).map(({ x, r }) => ({ x, r, color, kind: 'line' })));
  renderer.litLines([{ kind: step.kind, n: step.n }], color);
  showTutorialText(text, false);
  await renderer.wait(1600);
  renderer.clearAnnotations();
}
async function explainEnter(step, ex) {
  if (ex.out) {
    renderer.goal.classList.add('ready');
    showTutorialText(ex.out, false);
    await waitTap();
    renderer.goal.classList.remove('ready');
  }
  if (!ex.enter || !tutorial) return;
  const marks = [], lines = [];
  for (const m of step.moves) {
    const a = m.to !== 'goal' && step.after.get(m.block.id);
    if (!a) continue;
    marks.push({ x: a.x, r: a.r, color: m.block.color, kind: 'target' });
    lines.push({ kind: step.kind, n: m.to, color: m.block.color });
  }
  // 押しこまれるブロック（発動したライン以外で、入る前と後で場所が変わるもの）の行き先
  for (const [id, p] of step.before) {
    const a = step.after.get(id);
    if (a && (a.x !== p.x || a.r !== p.r) && !step.stack.some((b) => b.id === id)) marks.push({ x: a.x, r: a.r, color: p.color, kind: 'target' });
  }
  renderer.annotate(marks);
  renderer.litLines(lines);
  showTutorialText(ex.enter, false);
  await waitTap();
}
/**
 * 読んだらタップで次へ（「次へ」ボタンでも、画面のどこでもよい。スキップ・上のボタン・一時停止の画面は除く）。
 * 表示した直後のタップ（前の説明を閉じた指など）は数えない
 */
let tapDone = null;
function waitTap() {
  return new Promise((resolve) => {
    const next = $('tutNext'), t0 = performance.now();
    const ready = () => performance.now() - t0 > 350 && !paused;
    const onUp = (e) => { if (ready() && !e.target.closest?.('#tutSkip, .top, .overlay')) finish(); };
    const finish = () => {
      window.removeEventListener('pointerup', onUp, true);
      next.onclick = null;
      next.classList.add('hidden');
      tapDone = null;
      placeTutorialText();
      resolve();
    };
    next.onclick = () => { if (ready()) finish(); };        // キーボードで押したとき（指のときは pointerup で先に進む）
    next.classList.remove('hidden');
    placeTutorialText();
    window.addEventListener('pointerup', onUp, true);
    tapDone = finish;
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
  setHintedSlot(-1);
  const t = tutorialTarget();
  if (!t || !t.piece || game.gameOver) { renderer.clearHint(); hideHand(); return; }
  renderer.showHint(t.piece, t.ox, t.oy, true);                     // 持っている間も置く場所は見せたまま
  if (drag) { hideHand(); return; }
  renderer.litLines((TUTORIAL_STEPS[tutorial.i].lit ?? []).map(([kind, n]) => ({ kind, n })), 'yellow');   // 見てほしいラインの番号
  setHintedSlot(t.slot);
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
  tapDone?.();                                   // 説明の途中でタップを待っていたら終わらせる
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
/* ---------- 説明書（「遊び方」。ホーム・一時停止・ゲームオーバーから開く。中身は manual-content.js を初めて開くときに読みこむ） ---------- */
let manualReady = null;
async function openManual() {
  sfx.unlock();
  cancelDrag();
  manualReady ??= import('./manual-content.js?v=202610091551').then(({ MANUAL_HTML }) => { $('manual').innerHTML = MANUAL_HTML; }).catch((e) => { manualReady = null; throw e; });
  try { await manualReady; } catch { $('manual').textContent = '説明書を読みこめませんでした。通信のよいところで、もう一度ためしてください'; }
  $('manualOverlay').classList.remove('hidden');
  $('manualOverlay').scrollTop = 0;
}
function closeManual() { $('manualOverlay').classList.add('hidden'); }
$('manualClose').addEventListener('click', () => { sfx.unlock(); closeManual(); });
/** 「れんしゅうする」: 説明書を閉じて、チュートリアル（動かして覚える数手）へ */
$('manualPractice').addEventListener('click', () => {
  sfx.unlock();
  closeManual();
  hideHome();
  setPaused(false);
  startTutorial();
});
// もくじ・「もくじへ」: ページの中を滑らかに移動する（アドレスは変えない）
$('manual').addEventListener('click', (e) => {
  const a = e.target.closest?.('a[data-go]');
  if (!a) return;
  e.preventDefault();
  const to = document.getElementById(a.dataset.go);
  if (to) to.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
});
$('btnHowto').addEventListener('click', openManual);
$('btnOverHowto').addEventListener('click', openManual);

/* ---------- ゲーム名と遊べる場所・結果のシェア ---------- */
$('brandUrl').textContent = displayUrl();
/**
 * ゲームオーバーになったら結果カード（share-card.js）をすぐ作り始めておく。スマホの共有メニュー（navigator.share）は
 * タップの直後にしか開けないので、タップしてから画像を作ると間に合わないことがある
 */
let share = null;           // { data, file: Promise<File | null>, url: 画像の blob URL }
function prepareShare(data) {
  dropShare();
  const s = { data };
  // 画面が出てくる動き（360ms）が終わってから描く（描いている間に動きが引っかからないように）
  // 3D の盤面は、ゲームと同じ描き方で背景ごと描いた絵を使う（描けなければ宝石の絵）
  const image3d = () => (data.theme === '3d' && renderer.view3d
    ? load3d().then((view) => view.snapshot({ width: CARD_W, height: CARD_H, cx: CARD_BOARD.cx, cy: CARD_BOARD.cy, cell: CARD_BOARD.cell, blocks: data.board })).catch(() => null)
    : null);
  s.file = delay(450).then(image3d).then((img) => drawResultCard(img ? { ...data, image3d: img } : data)).then(cardBlob).then((blob) => {
    if (!blob || s !== share) return null;             // 待っている間に次のゲームになった
    s.url = URL.createObjectURL(blob);
    return new File([blob], `${GAME_NAME}.png`, { type: 'image/png' });
  }).catch((e) => { console.error(e); return null; });
  share = s;
}
function dropShare() {
  if (share?.url) URL.revokeObjectURL(share.url);
  share = null;
  $('shareSheet').classList.add('hidden');
}
const shareText = (d) => `${GAME_NAME} で ${d.score.toLocaleString('en-US')}点！ 最大${d.chain}連鎖 #${GAME_NAME}\n${gameUrl()}`;
/** 「結果をシェア」: 画像つきで共有メニューを開く。画像を共有できないブラウザでは、カードを見せて保存・長押し・リンクのコピーで */
$('btnShare').addEventListener('click', async () => {
  const s = share;
  if (!s) return;
  $('btnShare').classList.add('wait');
  const file = await s.file;
  $('btnShare').classList.remove('wait');
  if (s !== share) return;
  if (file && navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], text: shareText(s.data) }); return; } catch (e) { if (e?.name === 'AbortError') return; }
  }
  if (!s.url) return;
  $('shareImg').src = s.url;
  $('shareSave').href = s.url;
  $('shareHint').textContent = '画像を長押しすると、保存やシェアができます';
  $('shareSheet').classList.remove('hidden');
});
$('shareClose').addEventListener('click', () => $('shareSheet').classList.add('hidden'));
$('shareCopy').addEventListener('click', () => {
  const url = gameUrl(), hint = $('shareHint');
  const failed = () => { hint.textContent = url; };
  try { navigator.clipboard.writeText(url).then(() => { hint.textContent = 'リンクを コピーしました'; }, failed); } catch { failed(); }
});

$('btnRetry').addEventListener('click', () => { sfx.unlock(); saveBest(); restart(); });
window.addEventListener('resize', () => {
  slotBoxCache = null; slotCenterCache = null;
  renderTray();
  // 持っているピースはマスの大きさが変わったので作り直す（盤面は renderer が先に合わせ直している）
  if (drag) { $('dragLayer').innerHTML = ''; drag.ox = null; updateDrag({ clientX: drag.x, clientY: drag.y }); }
  if (tutorial) { placeTutorialText(); showTutorialTarget(); }
});
/* ---------- はじめに、なまえを決める（決めるまで遊べない。世界ランキングに参加する） ---------- */
/** なまえを決めたら done を呼ぶ。空では決められず、閉じる方法も無い（決めるまで盤面には触れない） */
function nameGate(done) {
  const gate = $('nameGate'), input = $('gateInput'), go = $('gateGo');
  gate.classList.remove('hidden');
  const ready = () => !!input.value.trim();
  input.oninput = () => { go.disabled = !ready(); };
  const commit = () => {
    if (!ready() || !world.setName(input.value)) { input.focus(); return; }
    gate.classList.add('hidden');
    world.flush(true);                             // ランキングに参加する（前のベストスコアが残っていれば、ここで送る）
    done();
  };
  go.onclick = commit;                             // 開くたびに付け直す（前に開いたときの done は呼ばない）
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } };
  setTimeout(() => input.focus(), 60);
}
/* ---------- 対戦（versus.js。ルールは core/battle.js） ---------- */
/**
 * 自分の盤面におじゃまが置かれる（ルールはもう確定している。画面で見せるだけ）。
 * 連鎖の再生の列には並べず、置く操作もふさがない（「再生中」の数 pending にも入れない）。連鎖の再生中でなければ、おじゃまの演出の間も手駒を持って置ける
 */
function enqueueDrop(res) {
  if (!res?.landed.length) return;
  const gen = generation;
  renderer.garbageLand(res.landed).then(async () => {
    if (gen !== generation) return;
    updateDanger();
    if (game.gameOver && inBattle()) await battleLost();
  }).catch((e) => console.error(e));
}
/** 対戦で置ける場所がなくなった（見えたところで負け。相手にも知らせる） */
async function battleLost() {
  if (gameOverShown) return;
  gameOverShown = true;
  cancelDrag();
  await renderer.wait(250);
  renderer.setFever(0);
  renderer.setDanger(0);
  versus.localLost();
}
/** 対戦の画面にして、新しいゲーム（おじゃまのルール・決まった手駒の決め方） */
function enterBattle() {
  stopTutorial();
  for (const id of ['home', 'lobby', 'gameOver', 'pauseOverlay', 'rankOverlay', 'designOverlay', 'vsRules']) $(id).classList.add('hidden');
  renderer.setPaused(false);
  document.body.classList.add('battle');
  document.body.classList.toggle('battle-online', versus.kind === 'online');
  game.setBattle(true, BATTLE_RATES, { seed: versus.seed });   // 相手と同じ順番の手駒（使った枠にすぐ次が入る）
  restart();
  bestCelebrated = true;                           // 対戦ではベストスコアのお祝いはしない
}
/** 対戦をやめて、ふだんのゲーム（前のモードの続き）とホームへ */
function exitBattle() {
  document.body.classList.remove('battle', 'battle-online', 'vs-busy');
  game.setBattle(false);
  inputLocked = false;
  loadBest();
  startOrResume();
  showHome();
}
versus = new Versus({
  game, renderer, sfx, $,
  workerUrl: new URL('../core/dealer-worker.js?v=202610091551', import.meta.url),
  myName: () => world.name || 'YOU',
  enter: enterBattle,
  exit: exitBattle,
  lock(on) { inputLocked = on; if (on) cancelDrag(); },
  enqueueDrop,
  busy: () => pending > 0,                         // 自分の連鎖を再生しているか（その間はおじゃまを置かない。置かれた直後にまた連鎖するまで待たせない）
  findRated: () => openLobby('rated'),
  celebrate() { ambient.celebrate('best'); scenes.newBest($('vsResBig').getBoundingClientRect()); },
});
ambient.bindBoard(versus.view.plateSets);          // 相手の盤面の土台も、背景と一緒に同じ色へ変わる

/* ---------- ホーム（遊び方を選ぶ・ランキング・デザイン・遊び方・サウンド） ---------- */
let homeTapAt = 0;
function showHome() {
  cancelDrag();
  paused = true;
  renderer.timeScale = 0;
  renderer.setPaused(true);
  $('pauseOverlay').classList.add('hidden');
  $('homeSoloSub').classList.toggle('hidden', !readSave());
  homePanel('main');
  $('home').classList.remove('hidden');
  updateHomeSound();
}
function hideHome() {
  $('home').classList.add('hidden');
  renderer.setPaused(false);
  paused = false;
  renderer.timeScale = desiredSpeed();
}
function homePanel(which) {
  $('homeMain').classList.toggle('hidden', which !== 'main');
  $('homeVsPanel').classList.toggle('hidden', which !== 'vs');
  if (which === 'vs') {
    const rec = readRecords(), parts = [];
    for (const [k, v] of Object.entries(CPU_LEVELS)) { const r = rec.cpu[k]; if (r && (r.w || r.l)) parts.push(`${v.name} ${r.w}勝${r.l}敗`); }
    if (rec.online.w || rec.online.l) parts.push(`オンライン ${rec.online.w}勝${rec.online.l}敗`);
    $('homeVsRec').textContent = parts.length ? `戦績　${parts.join('・')}` : '';
    // 自分のレート（このシーズン）
    world.fetchRate().then((r) => { $('homeRateVal').textContent = `あなたのレート ${r.rate}${r.games ? `（${r.wins}勝${r.games - r.wins}敗）` : ''}`; })
      .catch(() => { $('homeRateVal').textContent = ''; });
  }
}
function updateHomeSound() { $('homeSound').classList.toggle('off', !sfx.enabled); }
$('btnHome').addEventListener('click', () => {
  sfx.unlock();
  if (inBattle()) {
    if (versus.ended) { versus.exit(); return; }
    const now = performance.now();
    if (now - homeTapAt < 2200) { homeTapAt = 0; versus.exit(); return; }
    homeTapAt = now;
    renderer.showText('もう一度押すと<small>対戦をやめて ホームへ</small>', 't2');
    return;
  }
  saveBest();
  if (!pending) saveGame();
  showHome();
});
/** ひとりで: 遊んでいたゲームの続きへ。チュートリアルの途中ならやめて本番のゲームへ、ゲームオーバーのあとなら新しいゲーム */
$('homeSolo').addEventListener('click', () => {
  sfx.unlock();
  hideHome();
  if (tutorial) { stopTutorial(); startOrResume(); }
  else if (gameOverShown) restart();
});
$('homeVs').addEventListener('click', () => { sfx.unlock(); homePanel('vs'); });
$('homeVsBack').addEventListener('click', () => homePanel('main'));
$('homeVsRules').addEventListener('click', () => $('vsRules').classList.remove('hidden'));
$('vsRulesClose').addEventListener('click', () => $('vsRules').classList.add('hidden'));
for (const b of document.querySelectorAll('.home-level')) b.addEventListener('click', () => { sfx.unlock(); hideHome(); versus.startCpu(b.dataset.level); });
$('homeRandom').addEventListener('click', () => { sfx.unlock(); openLobby('random'); });
$('homeRated').addEventListener('click', () => { sfx.unlock(); openLobby('rated'); });
$('homeRoomMake').addEventListener('click', () => { sfx.unlock(); openLobby('make'); });
$('homeRoomJoin').addEventListener('click', () => { sfx.unlock(); openLobby('join'); });
$('homeRank').addEventListener('click', () => { sfx.unlock(); openRanking(); });
$('homeRate')?.addEventListener('click', () => { sfx.unlock(); openRanking('rate'); });
$('homeDesign').addEventListener('click', () => { sfx.unlock(); openDesign(); });
$('homeHowto').addEventListener('click', openManual);
$('homeSound').addEventListener('click', () => { sfx.unlock(); sfx.enabled = !sfx.enabled; updateSoundButton(); updateHomeSound(); });
$('btnOverHome')?.addEventListener('click', () => { sfx.unlock(); saveBest(); showHome(); });

/** デザイン（盤面の種類）: 一時停止の画面と同じ一覧を、こちらへ移して見せる */
function openDesign() {
  $('designSlot').appendChild(document.querySelector('.board-themes'));
  $('designOverlay').classList.remove('hidden');
  render3dPreview();
}
$('designClose').addEventListener('click', () => {
  $('pauseOverlay').querySelector('.pause-box').insertBefore(document.querySelector('.board-themes'), $('btnResume'));
  $('designOverlay').classList.add('hidden');
});

/* ---------- オンライン対戦: 相手を探す・あいことば ---------- */
let lobbyNet = null;
function lobbyText(title, note = '') { $('lobbyTitle').textContent = title; $('lobbyNote').textContent = note; }
async function openLobby(kind) {
  if (!world.named) { nameGate(() => openLobby(kind)); return; }
  lobbyNet?.cancel();
  const net = lobbyNet = new BattleNet({ me: world.id, name: world.name, relayOnly: new URLSearchParams(location.search).has('relay') });
  $('lobby').classList.remove('hidden');
  $('lobbyCode').classList.add('hidden');
  $('lobbyJoin').classList.add('hidden');
  $('lobbySpin').classList.remove('hidden');
  if (kind === 'join') {
    lobbyText('あいことばで入る', '友だちの 4けたの あいことばを入れてください');
    $('lobbySpin').classList.add('hidden');
    $('lobbyJoin').classList.remove('hidden');
    $('lobbyInput').value = '';
    setTimeout(() => $('lobbyInput').focus(), 60);
    return;
  }
  try {
    let room;
    if (kind === 'make') {
      lobbyText('あいことばを作っています…');
      net.onWaiting = (r) => {
        lobbyText('あいことば', '友だちに この4けたを伝えて、「あいことばで入る」から入ってもらってください');
        $('lobbyCode').textContent = r.code;
        $('lobbyCode').classList.remove('hidden');
      };
      room = await net.createRoom();
    } else if (kind === 'rated') {
      lobbyText('レート戦の相手をさがしています', 'だれかが「レート戦」を選ぶと始まります');
      room = await net.matchRated();
    } else {
      lobbyText('相手をさがしています', 'だれかが「だれかと対戦」を選ぶと始まります');
      room = await net.matchRandom();
    }
    lobbyMatched(net, room, kind === 'rated');
  } catch (e) {
    if (net !== lobbyNet) return;
    console.error(e);
    $('lobbySpin').classList.add('hidden');
    lobbyText('つながりませんでした', '通信のよいところで、もう一度ためしてください');
  }
}
async function lobbyJoin() {
  const code = $('lobbyInput').value.replace(/\D/g, '');
  if (code.length !== 4) { $('lobbyInput').focus(); return; }
  const net = lobbyNet;
  if (!net) return;
  $('lobbyJoin').classList.add('hidden');
  $('lobbySpin').classList.remove('hidden');
  lobbyText('部屋に入っています…');
  try {
    lobbyMatched(net, await net.joinRoom(code));
  } catch (e) {
    if (net !== lobbyNet) return;
    $('lobbySpin').classList.add('hidden');
    $('lobbyJoin').classList.remove('hidden');
    lobbyText('あいことばで入る', e.code === 'no-room' ? 'その あいことばの部屋は見つかりませんでした' : 'つながりませんでした。もう一度ためしてください');
  }
}
function lobbyMatched(net, room, rated = false) {
  if (!room || net !== lobbyNet) return;
  sfx.matchFound();
  $('lobbySpin').classList.add('hidden');
  $('lobbyCode').classList.add('hidden');
  lobbyText('相手が見つかりました！', `vs ${room.opponent?.name ?? ''}`);
  setTimeout(() => {
    if (net !== lobbyNet) return;                  // 始まるまでの間に「やめる」を押した（部屋は出ている）
    lobbyNet = null;
    $('lobby').classList.add('hidden');
    hideHome();
    versus.startOnline(net, room, { rated });
  }, 900);
}
$('lobbyJoinGo').addEventListener('click', lobbyJoin);
$('lobbyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); lobbyJoin(); } });
$('lobbyCancel').addEventListener('click', () => { lobbyNet?.cancel(); lobbyNet = null; $('lobby').classList.add('hidden'); });

/* ---------- QR コード（このゲームの URL。インスタグラムのプロフィールの QR のようなカード） ---------- */
/** カードを canvas に描く（そのまま「画像を保存」にも使う）: 白いカード・グラデーションの QR・まん中にロゴ・ゲーム名と URL */
function drawQrCard() {
  const cv = $('qrCard'), g = cv.getContext('2d'), W = cv.width, H = cv.height;
  g.clearRect(0, 0, W, H);
  g.fillStyle = '#fff';
  g.beginPath(); g.roundRect(0, 0, W, H, 60); g.fill();
  const qr = makeQr(gameUrl(), { ecl: 'H' });
  const size = 520, x = (W - size) / 2, y = 86;
  drawQr(g, qr, x, y, size, {
    colors: ['#2b4bbf', '#a849fe'], logoCells: 7,
    logo(ctx, cx, cy, s) {                          // アイコンと同じ階段の形（白いふちの角丸の四角）
      ctx.save();
      ctx.fillStyle = '#fff';
      ctx.beginPath(); ctx.roundRect(cx - s / 2 - 8, cy - s / 2 - 8, s + 16, s + 16, (s + 16) * 0.26); ctx.fill();
      ctx.fillStyle = LOGO_BG;
      ctx.beginPath(); ctx.roundRect(cx - s / 2, cy - s / 2, s, s, s * 0.22); ctx.fill();
      ctx.translate(cx - s / 2, cy - s / 2); ctx.scale(s / 32, s / 32);
      ctx.fillStyle = LOGO_FG; ctx.fill(new Path2D(LOGO_PATH));
      ctx.restore();
    },
  });
  g.textAlign = 'center';
  g.fillStyle = '#1d2340';
  g.font = '900 60px Nunito, "M PLUS Rounded 1c", sans-serif';
  g.fillText(GAME_NAME, W / 2, y + size + 104);
  g.fillStyle = '#7b84a8';
  g.font = '800 30px Nunito, "M PLUS Rounded 1c", sans-serif';
  g.fillText(displayUrl(), W / 2, y + size + 152);
}
function openQr() {
  sfx.unlock();
  cancelDrag();
  $('qrNote').textContent = 'カメラで読みこむと、すぐ遊べます';
  $('qrOverlay').classList.remove('hidden');
  drawQrCard();
  document.fonts?.ready.then(() => { if (!$('qrOverlay').classList.contains('hidden')) drawQrCard(); });   // 字が読みこまれたら描き直す
}
$('btnQr').addEventListener('click', openQr);
$('qrClose').addEventListener('click', () => $('qrOverlay').classList.add('hidden'));
$('qrOverlay').addEventListener('click', (e) => { if (e.target === $('qrOverlay')) $('qrOverlay').classList.add('hidden'); });
const qrBlob = () => new Promise((r) => $('qrCard').toBlob(r, 'image/png'));
$('qrShare').addEventListener('click', async () => {
  const url = gameUrl();
  try {
    const blob = await qrBlob(), file = blob && new File([blob], `${GAME_NAME}-qr.png`, { type: 'image/png' });
    if (file && navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file], text: `${GAME_NAME}\n${url}` }); return; }
    if (navigator.share) { await navigator.share({ title: GAME_NAME, url }); return; }
  } catch (e) { if (e?.name === 'AbortError') return; }
  $('qrCopy').click();
});
$('qrCopy').addEventListener('click', () => {
  const url = gameUrl(), note = $('qrNote');
  const failed = () => { note.textContent = url; };
  try { navigator.clipboard.writeText(url).then(() => { note.textContent = 'リンクを コピーしました'; }, failed); } catch { failed(); }
});
$('qrSave').addEventListener('click', async () => {
  const blob = await qrBlob();
  if (!blob) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${GAME_NAME}-qr.png`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  $('qrNote').textContent = '画像を保存しました';
});

startOrResume();
showHome();
if (!world.named) nameGate(() => {});              // 途中の保存があっても、なまえが無ければ先に決めてもらう
// 宝石のかけら・星・ラインの光の枠の絵（色ごと）と虹色の絵は、最初に使う瞬間に作ると一瞬止まるので、起動後の空き時間に作っておく（見た目は同じ）。
// まとめて作ると、それはそれで一瞬止まるので、1つずつ間をあけて
{
  const jobs = [() => renderer.tuneFxDensity(), ...renderer.shardLayer.warmJobs(), ...renderer.sparkLayer.warmJobs(), ...renderer.rims.warmJobs(), ...scenes.warmJobs()];
  const idle = window.requestIdleCallback ? (f) => requestIdleCallback(f, { timeout: 2000 }) : (f) => setTimeout(f, 120);
  const next = () => { const job = jobs.shift(); if (!job) return; job(); idle(next); };
  setTimeout(() => idle(next), 300);
}
window.__booted = true;
window.__game = game;
window.__renderer = renderer;
window.__sfx = sfx;
window.__scenes = scenes;
window.__ambient = ambient;
window.__ui = { showScore, renderTray, setBest(v) { best = v; }, pending: () => pending, versus, showHome, hideHome };

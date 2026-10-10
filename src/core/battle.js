import { SIZE, ANIM, isInside } from './constants.js?v=202610100228';
import { Board, createBlock, createGarbage, isGarbage } from './board.js?v=202610100228';

/**
 * 対戦（ぷよぷよのような、連鎖で相手におじゃまを送り合う遊び方）のルール。DOM 非依存。
 *
 * - 連鎖すると、連鎖の数を書いた 1×1 の「おじゃまブロック」が相手へ飛ぶ（ATTACK_MIN_CHAIN = 1 連鎖から。1 連鎖なら数字 1）。全消しは ALL_CLEAR_ATTACK を足す
 * - 相手の連鎖が終わったら、すぐ盤面に置かれる。そのとき自分が連鎖している（再生中）なら、その連鎖が終わったらすぐ（busy）。1 回に置かれる個数に上限は無い。
 *   予告（まだ置かれていないおじゃまを盤面の上に並べる）は画面には出さない。相殺もしない（OFFSET_PENDING）。
 *   対戦では、連鎖の再生が終わるまで次のピースは置けない（画面側）ので、盤面のルールと見えている盤面はいつもそろっている
 * - 自分が連鎖すると、連鎖の数ぶんの合計が、外側のおじゃま 1 個から順に当たる（5 連鎖なら合計 −5。Game.chipGarbage・chipOrder）。送るおじゃまは減らない（両方起きる）
 * - おじゃまは、三角の盤面の一番外側の辺（直角をはさむ 2 辺）の空きマスに、真ん中（角）から外へ置かれる（上にブロックがあっても関係ない）。
 *   外側の辺が埋まったら（おじゃまかブロックだけになったら）次の辺へ（edgeSpot）
 * - おじゃまは動かない・その上には置けない・入っているラインは満杯にならない（発動しない）
 * - 置けるピースが無くなったほうの負け。長引いたら（MARGIN_MS から）1 回に送るおじゃまの個数が増えていく（ぷよぷよのマージンタイム）
 */
export const ATTACK_MIN_CHAIN = 1;
/** 自分の連鎖で、まだ落ちていない予告のおじゃまも削るか（ぷよぷよの相殺） */
export const OFFSET_PENDING = false;
export const ALL_CLEAR_ATTACK = 5;
/** 対戦の連鎖の再生の速さ（CPU・オンラインとも。ふつうの再生を 1 とした倍率。画面・相手の盤面・シミュレーションが同じ数を使う） */
export const BATTLE_SPEED = 1.8;
/**
 * マージンタイム（ぷよぷよと同じく、長引いたら送るおじゃまが増える）: MARGIN_MS を過ぎると、1 回の攻撃で送るおじゃまが 2 個になり、
 * そこから MARGIN_STEP_MS ごとに 1 個ずつ増える（MARGIN_MAX 個まで。どれにも同じ連鎖の数を書く）。
 * 個数が増えた瞬間は、画面にそれを示す（versus.js。「おじゃま ×2」と、何分何秒を過ぎたか）。marginStartOf(n) = 個数が n 個になる時刻
 */
export let MARGIN_MS = 90000;
export let MARGIN_STEP_MS = 20000;
export let MARGIN_MAX = 5;
/** シミュレーション（調整）用に、マージンタイムの数値を変える */
export function tuneMargin({ start, step, max } = {}) {
  if (start != null) MARGIN_MS = start;
  if (step != null) MARGIN_STEP_MS = step;
  if (max != null) MARGIN_MAX = max;
}
/** 対戦の手駒の決め方（遊んでいる人の出来には合わせず、決まった確率） */
export const BATTLE_TIGHT_RATE = 0.03;
export const BATTLE_ALL_CLEAR_RATE = 0.12;

/** 1 回の攻撃で送るおじゃまの個数が n 個（2 以上）になる時刻（対戦が始まってからの ms） */
export const marginStartOf = (n) => MARGIN_MS + Math.max(0, n - 2) * MARGIN_STEP_MS;

/** 1 回の攻撃で送るおじゃまの個数（elapsed = 対戦が始まってからの ms） */
export function marginBlocks(elapsed) {
  if (!(elapsed >= MARGIN_MS)) return 1;
  return Math.min(MARGIN_MAX, 2 + Math.floor((elapsed - MARGIN_MS) / MARGIN_STEP_MS));
}

/** 1 回置いたときに相手へ送るおじゃまの数字（0 = 送らない） */
export function attackFor(chain, allClear = false) {
  return (chain >= ATTACK_MIN_CHAIN ? chain : 0) + (allClear ? ALL_CLEAR_ATTACK : 0);
}

/**
 * 1 ターンの連鎖の再生にかかる時間（ms。速さ 1 のとき）。main.js の再生（溜め + 各発動の列車と流れこみ + 間）と同じ見積もり
 * （renderer.js の stepCells と同じ数え方）。相手の画面で、その連鎖がいつ終わるかを知らせるのに使う
 */
export function stepCells(step) {
  const { kind, stack, after } = step;
  let longest = 1;
  for (let k = 1; k < stack.length; k++) {
    const a = after?.get?.(stack[k].id);
    longest = Math.max(longest, a ? SIZE - (kind === 'col' ? a.r : a.x) : k);
  }
  return 9 + longest;
}
export function playDuration(steps) {
  if (!steps?.length) return 0;
  return steps.reduce((a, s) => a + stepCells(s) * ANIM.step + ANIM.betweenChains, ANIM.charge);
}

/**
 * おじゃまが置かれる演出の長さ（速さ 1 のとき。ms）: 警告の間（DROP_WARN_MS）→ 1 個ずつ DROP_GAP_MS ずらして、ドンと置かれる（DROP_SLAM_MS）→ 余韻（DROP_HOLD_MS）。
 * 演出は連鎖の再生の列にも、置く操作にも関係しない（演出の間も手駒を置ける。置かれる予定のマスは赤い枠で示す）
 */
export const DROP_WARN_MS = 600;
export const DROP_GAP_MS = 170;
export const DROP_SLAM_MS = 260;
export const DROP_HOLD_MS = 220;

/* ---------- おじゃまが置かれる場所・削られる順番 ---------- */
/**
 * 盤面は直角が下の三角形（画面では (0, 0) が一番下の角）。おじゃまは、直角をはさむ 2 つの辺（x = 0 の辺と r = 0 の辺）= 一番外側の辺から置かれる。
 * 辺は外側から数えて「輪」: 輪 k = min(x, r) が k のマス。輪の中は、角（k, k）から離れた順（真ん中から外へ。左右の辺は交互）。
 * edgeOrder() = 盤面の全マスを、置く順番・削る順番に並べたもの（輪が小さい順 → 角に近い順 → 同じなら x の辺が先）。
 */
export function edgeOrder() {
  const cells = [];
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) {
    const k = Math.min(x, r);
    cells.push({ x, r, k, d: Math.max(x, r) - k, leg: x >= r ? 0 : 1 });
  }
  return cells.sort((a, b) => a.k - b.k || a.d - b.d || a.leg - b.leg).map(({ x, r }) => ({ x, r }));
}
/**
 * おじゃまを削る順番（連鎖の数ぶんの合計を当てる順。Game.chipGarbage）: **外側のおじゃまから**。
 * 輪が小さい順（一番外側の辺から）→ 同じ輪の中は、角から一番遠い端のおじゃまが先、角に近い（内側の）おじゃまはあと（同じ距離なら x の辺が先）。
 * 置く順番（edgeOrder = 角から外へ）の、輪の中だけを逆にしたもの
 */
export function chipOrder() {
  const cells = [];
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) {
    const k = Math.min(x, r);
    cells.push({ x, r, k, d: Math.max(x, r) - k, leg: x >= r ? 0 : 1 });
  }
  return cells.sort((a, b) => a.k - b.k || b.d - a.d || a.leg - b.leg).map(({ x, r }) => ({ x, r }));
}
const EDGE_ORDER = edgeOrder();
/**
 * おじゃまを置くマス: 一番外側の輪から、空いているマスを真ん中から順に（上にブロックがあっても関係なく、そのマスが空いていればよい）。
 * 外側の輪に空きが無くなったら（おじゃまかブロックだけになったら）次の輪へ。空きが無ければ null。occupied(x, r) = そのマスが埋まっているか。
 * random を渡すと、真ん中から同じ距離の 2 マス（左右の辺）のどちらを先にするかを毎回ばらす
 */
export function edgeSpot(occupied, random = null) {
  let i = 0;
  while (i < EDGE_ORDER.length) {
    const c = EDGE_ORDER[i], k = Math.min(c.x, c.r), d = Math.max(c.x, c.r) - k;
    // 輪 k・距離 d の（最大 2 マスの）組を取り出す
    const group = [c];
    while (i + group.length < EDGE_ORDER.length) {
      const e = EDGE_ORDER[i + group.length], ek = Math.min(e.x, e.r);
      if (ek === k && Math.max(e.x, e.r) - ek === d) group.push(e); else break;
    }
    const free = group.filter((g) => !occupied(g.x, g.r));
    if (free.length) return free.length > 1 && random && random() < 0.5 ? free[1] : free[0];
    i += group.length;
  }
  return null;
}

/* ---------- 予告（まだ落ちていない、送られてきたおじゃま） ---------- */
/**
 * items = [{ id, n, readyAt }]。readyAt = 相手の連鎖が終わる時刻（それまでは落ちない）
 */
export class GarbageQueue {
  constructor() { this.items = []; }
  add({ id, n, readyAt = 0 }) {
    if (!(n > 0) || this.items.some((g) => g.id === id)) return false;
    this.items.push({ id, n: Math.floor(n), readyAt });
    return true;
  }
  /** 自分の連鎖で k 削る。{ changed: [{ id, n, from }], removed: [{ id, from }] } */
  offset(k) {
    const changed = [], removed = [];
    if (!(k > 0)) return { changed, removed };
    for (const g of this.items) {
      const from = g.n;
      g.n -= k;
      if (g.n <= 0) removed.push({ id: g.id, from }); else changed.push({ id: g.id, n: g.n, from });
    }
    this.items = this.items.filter((g) => g.n > 0);
    return { changed, removed };
  }
  /** 落ちてよい（相手の連鎖が終わった）もの */
  ready(now) { return this.items.filter((g) => g.readyAt <= now); }
  /** 落ちてよいものを古い順に max 個まで取り出す */
  take(now, max = Infinity) {
    const out = this.ready(now).slice(0, max);
    const ids = new Set(out.map((g) => g.id));
    this.items = this.items.filter((g) => !ids.has(g.id));
    return out;
  }
  /** 取り出したけれど盤面に入らなかったものを、先頭に戻す */
  putBack(list) { this.items = [...list.filter((g) => !this.items.some((h) => h.id === g.id)), ...this.items]; }
  get total() { return this.items.reduce((a, g) => a + g.n, 0); }
  clear() { this.items = []; }
}

/**
 * 1 人ぶんの対戦の進み方（おじゃまを送る・落とすタイミング）。画面の再生と、相手（CPU）の見えない再生のどちらでも同じ。
 * game = core/game.js の Game（setBattle(true) にしたもの。連鎖でおじゃまを削るのは Game.placePiece が置いた瞬間に行い、turn.chip に残す）。
 * now() = 時刻（ms。一時停止の間は止まる時計でもよい）。busy() = 今、この人の連鎖（とおじゃまの落ちる動き）を再生しているか。
 * 使う側は:
 *   placed(turn, readyIn) … 置いた瞬間（readyIn = このターンの連鎖の再生が終わるまでの ms）。送るおじゃまの数字を返す
 *   receive(attack)       … 相手からおじゃまが届いた { id, n, readyIn }
 *   tick()                … こまめに呼ぶ。落としてよければ盤面へ落とし、{ landed, left } を返す
 * hooks: send({ id, n, readyIn }) / drop({ landed, left }) / pending() / over()
 */
export class BattleSide {
  constructor({ game, now = () => Date.now(), random = Math.random, hooks = {}, idPrefix = 'a', offsetPending = OFFSET_PENDING, busy = () => false }) {
    this.game = game; this.now = now; this.random = random; this.hooks = hooks; this.offsetPending = offsetPending; this.busy = busy;
    this.idPrefix = idPrefix; this.nextId = 1;
    this.queue = new GarbageQueue();
    this.startAt = now();
    this.stuck = false;                   // 盤面の上までふさがっていて落とせなかった（次に置いて盤面が変わるまで待つ）
    this.stats = { sent: 0, attacks: 0, chipped: 0, received: 0, landed: 0, bestAttack: 0 };
    this.over = false;
  }
  elapsed() { return this.now() - this.startAt; }
  /** 置いた。連鎖していれば相手へおじゃまを送る（送った数字を返す）。turn.chip（盤面のおじゃまを削った結果）も数える */
  placed(turn, readyIn = playDuration(turn.steps)) {
    this.stuck = false;
    const k = turn.steps.length;
    this.stats.chipped += turn.chip?.removed.length ?? 0;
    if (k && this.offsetPending) {
      const off = this.queue.offset(k);
      this.stats.chipped += off.removed.length;
      turn.offset = off;
      if (off.changed.length || off.removed.length) this.hooks.pending?.();
    }
    const n = attackFor(k, !!turn.allClear);
    if (n) {
      const count = marginBlocks(this.elapsed());
      const attack = { id: `${this.idPrefix}${this.nextId++}`, n, count, readyIn: Math.max(0, Math.round(readyIn)) };
      this.stats.sent += n * count; this.stats.attacks++; this.stats.bestAttack = Math.max(this.stats.bestAttack, n);
      turn.attack = attack;
      this.hooks.send?.(attack);
    }
    return n;
  }
  /** 相手からおじゃまが届いた（count 個。マージンタイムで増える） */
  receive({ id, n, count = 1, readyIn = 0 }) {
    if (this.over) return false;
    const readyAt = this.now() + Math.max(0, readyIn);
    let added = 0;
    for (let j = 0; j < Math.max(1, count); j++) if (this.queue.add({ id: j ? `${id}.${j}` : id, n, readyAt })) added++;
    if (!added) return false;
    this.stats.received += n * added;
    this.hooks.pending?.();
    return true;
  }
  /** 落ちてよい予告（相手の連鎖が終わったもの）があり、自分が連鎖していなければ、すぐ落とす */
  shouldDrop() {
    if (this.over || this.game.gameOver || this.stuck) return false;
    return this.queue.ready(this.now()).length > 0 && !this.busy();
  }
  tick() {
    if (!this.shouldDrop()) return null;
    const items = this.queue.take(this.now());
    const res = this.game.dropGarbage(items, this.random);
    if (res.left.length) this.queue.putBack(res.left);
    if (!res.landed.length && res.left.length) {
      this.stuck = true;                  // どこにも入らなかった（上までふさがっている）: 次に置いて盤面が変わるまで待つ
      return null;
    }
    this.stats.landed += res.landed.length;
    this.hooks.pending?.();
    this.hooks.drop?.(res);
    if (this.game.gameOver) this.lose();
    return res;
  }
  lose() {
    if (this.over) return;
    this.over = true;
    this.hooks.over?.();
  }
}


/** 盤面を短い文字にする（相手の盤面と食い違っていないか確かめる・食い違ったら直す） */
const LETTER = { red: 'r', orange: 'o', yellow: 'y', green: 'g', cyan: 'c', blue: 'b', purple: 'p' };
const COLOR_OF = Object.fromEntries(Object.entries(LETTER).map(([k, v]) => [v, k]));
export function packBoard(board) {
  let s = '';
  const g = [];
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
    if (!isInside(x, r)) continue;
    const b = board.get(x, r);
    if (!b) s += '.';
    else if (isGarbage(b)) { s += '#'; g.push(b.garbage); }
    else s += LETTER[b.color] ?? 'x';
  }
  return { s, g };
}
export function unpackBoard({ s, g }) {
  const board = new Board();
  let i = 0, k = 0;
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
    if (!isInside(x, r)) continue;
    const ch = s[i++];
    if (ch === '#') board.set(x, r, createGarbage(g[k++] ?? 1));
    else if (ch && ch !== '.') board.set(x, r, createBlock(COLOR_OF[ch] ?? 'x'));
  }
  return board;
}
export const samePack = (a, b) => a.s === b.s && a.g.join(',') === b.g.join(',');

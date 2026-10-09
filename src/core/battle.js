import { SIZE, ANIM, isInside } from './constants.js?v=202610091030';
import { Board, createBlock, createGarbage, isGarbage } from './board.js?v=202610091030';

/**
 * 対戦（ぷよぷよのような、連鎖で相手におじゃまを送り合う遊び方）のルール。DOM 非依存。
 *
 * - 連鎖すると、連鎖の数を書いた 1×1 の「おじゃまブロック」が相手へ飛ぶ（ATTACK_MIN_CHAIN 連鎖から。1 連鎖では送らない。
 *   ぷよぷよでも、小さな消し方ではおじゃまは送られない）。全消しは ALL_CLEAR_ATTACK を足す（ぷよぷよの全消しボーナス）
 * - 送られたおじゃまは、まず盤面の上に「予告」として並ぶ。相手の連鎖が終わるまでは落ちてこない
 * - 相手の連鎖が終わったあと、自分が次に置いたピースのすぐあとに落ちてくる（置かずに待っていても GARBAGE_GRACE_MS で落ちる）。
 *   1 回に落ちるのは DROP_MAX 個まで。ルールは置いた瞬間に確定し、画面は後から順番に再生するので、自分の連鎖の再生中に落ちると決まったおじゃまは、
 *   その連鎖が見え終わってから落ちてくる
 * - 自分が連鎖すると、盤面のおじゃまの数字が全部、連鎖の数だけ減る（0 になったら消える。Game.placePiece）。送るおじゃまは減らない（両方起きる）。
 *   予告のおじゃまは削らない（OFFSET_PENDING。ぷよぷよの相殺と同じことを 2 通りでするのは分かりにくく、シミュレーションでは決着もつかなかった）
 * - おじゃまは盤面の上から落ちてきて、三角の盤面（直角が下の V 字の入れ物）の一番低いところに積もる（dropPath）
 * - おじゃまは動かない・その上には置けない・入っているラインは満杯にならない（発動しない）
 * - 置けるピースが無くなったほうの負け。長引いたら（MARGIN_MS から）1 回に送るおじゃまの個数が増えていく（ぷよぷよのマージンタイム）
 */
export const ATTACK_MIN_CHAIN = 2;
/** 自分の連鎖で、まだ落ちていない予告のおじゃまも削るか（ぷよぷよの相殺） */
export const OFFSET_PENDING = false;
export const ALL_CLEAR_ATTACK = 5;
export const GARBAGE_GRACE_MS = 2500;
export const DROP_MAX = 5;
/**
 * マージンタイム（ぷよぷよと同じく、長引いたら送るおじゃまが増える）: MARGIN_MS を過ぎると、1 回の攻撃で送るおじゃまが 2 個になり、
 * そこから MARGIN_STEP_MS ごとに 1 個ずつ増える（MARGIN_MAX 個まで。どれにも同じ連鎖の数を書く）。
 * 連鎖のたびに盤面のおじゃまが全部削れるので、数字を大きくするより、個数を増やすほうが盤面が埋まっていく
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

/* ---------- おじゃまの落ち方 ---------- */
/**
 * おじゃまが盤面の上から落ちてきて止まるまでの道のり。盤面は直角が下の V 字の入れ物（画面では、マス (x, r) の高さは x + r に比例し、
 * (0, 0) が一番下）。画面の縦の列（r - x が同じ）を上から落ち、下の 2 つの辺（(x-1, r) と (x, r-1)）のどちらかが空いていれば
 * そちらへ斜めにすべり、両方空いていればまっすぐ下（(x-1, r-1)）へ、両方ふさがれば（ブロック・おじゃま・入れ物の壁）止まる。
 * ブロックをすり抜けることはない（上からふさがれた穴には入らない）。occupied(x, r) = 盤面の中のマスが埋まっているか。
 * 返り値: 落とす列ごとの止まる場所 [{ x, r, path: [{ x, r }, …]（落ち始めの盤面のすぐ上から、止まる位置まで） }]（同じ場所は 1 つにまとめる）
 */
export function dropSpots(occupied, random = Math.random) {
  const inside = (x, r) => x >= 0 && r >= 0 && x + r <= SIZE - 1;
  const blocked = (x, r) => x < 0 || r < 0 || (inside(x, r) && occupied(x, r));
  const spots = new Map();
  for (let d = -(SIZE - 1); d <= SIZE - 1; d++) {
    const top = SIZE + ((SIZE + d) % 2 ? 1 : 0);                 // 盤面のすぐ上（x + r と r - x の偶奇はそろう）
    let x = (top - d) / 2, r = (top + d) / 2;
    const path = [{ x, r }];
    for (;;) {
      const a = blocked(x - 1, r), b = blocked(x, r - 1);
      if (a && b) break;
      if (!a && !b) {
        if (!blocked(x - 1, r - 1)) { x--; r--; }
        else if (random() < 0.5) x--; else r--;
      } else if (!a) x--;
      else r--;
      path.push({ x, r });
    }
    if (!inside(x, r) || occupied(x, r)) continue;               // この列はいっぱい
    const key = x + ',' + r;
    if (!spots.has(key) || spots.get(key).path.length > path.length) spots.set(key, { x, r, path });
  }
  return [...spots.values()];
}
/**
 * どこに止まるか: 一番低いところ（x + r が小さい。同じ高さなら random）。
 * safety(spot) を渡すと、その小さいものを先に選ぶ（0 = 手駒が全部置ける / 1 = どれかは置ける / 2 = 1 つも置けない。Game.dropGarbage）。
 * 落ちたおじゃまで、たまたま手駒の入る場所だけがふさがって負けにならないように（盤面がほんとうに混んできたら負ける）
 */
export function pickSpot(spots, random = Math.random, safety = null) {
  let best = null, bestKey = null, ties = 0;
  for (const s of spots) {
    const key = [safety ? safety(s) : 0, s.x + s.r];
    const cmp = !best ? -1 : key[0] - bestKey[0] || key[1] - bestKey[1];
    if (cmp < 0) { best = s; bestKey = key; ties = 1; }
    else if (cmp === 0 && random() * ++ties < 1) best = s;
  }
  return best;
}
/** 一番低いところに止まる道のり（無ければ null） */
export const dropPath = (occupied, random = Math.random, safety = null) => pickSpot(dropSpots(occupied, random), random, safety);

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
  take(now, max = DROP_MAX) {
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
 * now() = 時刻（ms。一時停止の間は止まる時計でもよい）。
 * このゲームはルールを置いた瞬間に最後まで確定させ、画面は後から順番に再生する。おじゃまも同じで、落ちるのは「決めた瞬間」に盤面へ入り、
 * 画面ではそれまでに置いたターンの再生が終わってから落ちてくる（使う側が再生の列に並べる）。だから自分の連鎖の再生中に届いたおじゃまは、
 * その連鎖が見え終わってから落ちる
 * 使う側は:
 *   placed(turn, readyIn) … 置いた瞬間（readyIn = このターンの連鎖の再生が終わるまでの ms）。送るおじゃまの数字を返す
 *   receive(attack)       … 相手からおじゃまが届いた { id, n, readyIn }
 *   tick()                … こまめに呼ぶ。落としてよければ盤面へ落とし、{ landed, left } を返す
 * hooks: send({ id, n, readyIn }) / drop({ landed, left }) / pending() / over()
 */
export class BattleSide {
  constructor({ game, now = () => Date.now(), random = Math.random, hooks = {}, idPrefix = 'a', offsetPending = OFFSET_PENDING }) {
    this.game = game; this.now = now; this.random = random; this.hooks = hooks; this.offsetPending = offsetPending;
    this.idPrefix = idPrefix; this.nextId = 1;
    this.queue = new GarbageQueue();
    this.startAt = now();
    this.placedAt = -Infinity;            // 最後に置いた時刻
    this.stats = { sent: 0, attacks: 0, chipped: 0, received: 0, landed: 0, bestAttack: 0 };
    this.over = false;
  }
  elapsed() { return this.now() - this.startAt; }
  /** 置いた。連鎖していれば相手へおじゃまを送る（送った数字を返す）。turn.chip（盤面のおじゃまを削った結果）も数える */
  placed(turn, readyIn = playDuration(turn.steps)) {
    this.placedAt = this.now();
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
  /**
   * 落ちてよい予告（相手の連鎖が終わったもの）があり、そのあとに自分が置いた（置いたピースのすぐあとに落ちる）か、
   * 置かずに GARBAGE_GRACE_MS 待ったなら落とす
   */
  shouldDrop() {
    if (this.over || this.game.gameOver) return false;
    const ready = this.queue.ready(this.now());
    if (!ready.length) return false;
    const since = Math.min(...ready.map((g) => g.readyAt));
    return this.placedAt >= since || this.now() >= since + GARBAGE_GRACE_MS;
  }
  tick() {
    if (!this.shouldDrop()) return null;
    const items = this.queue.take(this.now(), DROP_MAX);
    const res = this.game.dropGarbage(items, this.random);
    if (res.left.length) this.queue.putBack(res.left);
    if (!res.landed.length && res.left.length) {
      // どこにも入らなかった（上までふさがっている）: 次に置くまで待つ
      this.placedAt = -Infinity;
      for (const g of this.queue.items) g.readyAt = Math.max(g.readyAt, this.now());
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

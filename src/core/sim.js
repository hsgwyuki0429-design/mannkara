import { SIZE, isInside, lineCells } from './constants.js?v=202609240125';

/**
 * 探索用の軽い盤面（手駒の組み合わせ探索・全消しの計画で何万回も試すため）。
 * ルールはブロックの色や id に依らず「どのマスが埋まっているか」だけで決まるので、
 * 占有 0/1 と各ラインの個数だけを持つ。処理は board.js / mancala.js とまったく同じ
 * （テストで本体と一致することを確かめている）。
 *
 * 状態は Uint8Array: [0, 64) = マス (r * 8 + x) の占有, [64, 64 + 18) = ライン個数
 * （col n → 64 + n, row n → 64 + 9 + n）
 */
const CELLS = 64, CNT = 64, LEN = CNT + 2 * (SIZE + 1);
const K = { col: 0, row: 1 };
const cntAt = (kind, n) => CNT + kind * (SIZE + 1) + n;
/** LINES[kind][n] = そのラインのマス（slot 順、0 = 斜辺側の端） */
const LINES = [0, 1].map((kind) => Array.from({ length: SIZE + 1 }, (_, n) =>
  n ? lineCells(kind ? 'row' : 'col', n).map(({ x, r }) => r * SIZE + x) : []));
const INSIDE = [];
for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) INSIDE.push(r * SIZE + x);
/** マスが属する縦列・横列の番号 */
const COL_OF = (i) => SIZE - (i % SIZE), ROW_OF = (i) => SIZE - Math.floor(i / SIZE);

export const TOTAL_CELLS = INSIDE.length;

export function fromBoard(board) {
  const s = new Uint8Array(LEN);
  for (const { x, r } of board.entries()) fill(s, r * SIZE + x);
  return s;
}
export const cloneSim = (s) => s.slice();

function fill(s, i) {
  s[i] = 1;
  s[cntAt(0, COL_OF(i))]++;
  s[cntAt(1, ROW_OF(i))]++;
}
function empty(s, i) {
  s[i] = 0;
  s[cntAt(0, COL_OF(i))]--;
  s[cntAt(1, ROW_OF(i))]--;
}

export function blocks(s) {
  let n = 0;
  for (let k = 1; k <= SIZE; k++) n += s[cntAt(0, k)];
  return n;
}
export function keyOf(s) {
  let key = 0;
  for (const i of INSIDE) key = key * 2 + s[i];
  return key;
}

/* ---------- 配置 ---------- */
/** 形のセル [{x, y}] を左上 (ox, oy) に置けるか */
export function canPlace(s, cells, ox, oy) {
  for (const c of cells) {
    const x = ox + c.x, r = oy + c.y;
    if (!isInside(x, r) || s[r * SIZE + x]) return false;
  }
  return true;
}
export function place(s, cells, ox, oy) {
  for (const c of cells) fill(s, (oy + c.y) * SIZE + ox + c.x);
}
/** 置ける左上の位置 [[ox, oy], …] */
export function placements(s, cells) {
  const out = [];
  for (let oy = 0; oy < SIZE; oy++) for (let ox = 0; ox < SIZE; ox++) if (canPlace(s, cells, ox, oy)) out.push([ox, oy]);
  return out;
}
export function fits(s, cells) {
  for (let oy = 0; oy < SIZE; oy++) for (let ox = 0; ox < SIZE; ox++) if (canPlace(s, cells, ox, oy)) return true;
  return false;
}

/* ---------- 発動（mancala.js と同じ） ---------- */
/** Board.insertBottom と同じ。入れたら true */
function insertBottom(s, kind, n) {
  const cells = LINES[kind][n];
  const count = s[cntAt(kind, n)];
  if (count === n) return false;
  if (count === n - 1) {                       // 手前を奥へ詰めて埋める → 満杯
    for (const i of cells) if (!s[i]) fill(s, i);
    return true;
  }
  let first = -1;
  for (let k = 0; k < n; k++) if (s[cells[k]]) { first = k; break; }
  const stop = first < 0 ? n - 1 : first - 1;
  if (stop < 0) return false;
  fill(s, cells[stop]);
  return true;
}
/** ライン(kind, n) を発動（満杯が前提）。ゴールへ入った個数を返す */
function resolveLine(s, kind, n) {
  for (const i of LINES[kind][n]) empty(s, i);
  let goals = 0;
  for (let k = 0; k < n; k++) {
    const target = n - 1 - k;
    if (!(target > 0 && insertBottom(s, kind, target))) goals++;
  }
  return goals;
}
function minFull(s, kind) {
  for (let n = 1; n <= SIZE; n++) if (s[cntAt(kind, n)] === n) return n;
  return 0;
}
/** 次に発動するライン [kind, n]（なければ null）。mancala.js の decide と同じ優先順位 */
function nextActivation(s) {
  const c = minFull(s, K.col), r = minFull(s, K.row);
  if (!c || !r) return c ? [K.col, c] : r ? [K.row, r] : null;
  const lenCol = chainFrom(s, K.col, c), lenRow = chainFrom(s, K.row, r);
  return lenRow > lenCol ? [K.row, r] : [K.col, c];     // 同じなら縦
}
const memo = new Map();
function chainFrom(s, kind, n) {
  const b = s.slice();
  resolveLine(b, kind, n);
  return 1 + chainLength(b);
}
function chainLength(s) {
  const key = keyOf(s);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  const b = s.slice();
  let n = 0;
  for (let act; (act = nextActivation(b)); ) {
    resolveLine(b, act[0], act[1]);
    if (++n > 2000) break;
  }
  if (memo.size > 50000) memo.clear();
  memo.set(key, n);
  return n;
}
/** 連鎖が終わるまで解決。発動したライン数を返す */
export function resolveAll(s) {
  let n = 0;
  for (let act; (act = nextActivation(s)); ) {
    resolveLine(s, act[0], act[1]);
    if (++n > 2000) break;
  }
  return n;
}

/**
 * 全消しまでの「遠さ」の目安（全消しの計画で、有望な盤面から先に調べるため）。
 * ブロックごとに「縦・横のどちらかのラインを満杯にするのに足りないマス数」を足す。
 * 短いライン（右上・左下の角の近く）にあるブロックほど消しやすい。
 */
export function clearCost(s) {
  let cost = 0;
  for (const i of INSIDE) {
    if (!s[i]) continue;
    const c = COL_OF(i), r = ROW_OF(i);
    cost += 1 + Math.min(c - s[cntAt(0, c)], r - s[cntAt(1, r)]);
  }
  return cost;
}

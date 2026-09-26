import { SIZE, isInside, lineCells } from './constants.js?v=202609261121';

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

/** ライン(kind 'col' | 'row', n) にあるブロックの数 */
export const lineCount = (s, kind, n) => s[cntAt(kind === 'col' ? 0 : 1, n)];

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

/**
 * 左上 (ox, oy) に置いたとき、形がまわりにどれだけ気持ちよく収まるか。
 * 形のマスの上下左右のうち、形の外にあるものを数える: 盤面の外（walls）・ブロック（blocks）・空き（open）。
 * kind（気持ちよさの強い順）:
 *  'perfect' = 空きに1つも接していない（ブロックに囲まれた穴をちょうど埋める）
 *  'rect'    = 置くと、形がまるごと入る「すきまの無い長方形」ができる（縦横2マス以上・RECT_MIN_AREA マス以上・
 *              前からあるブロックを RECT_MIN_EXTRA 個以上含む）。凹みを埋めて四角くそろえる置き方
 *  'dent'    = 凹みにはまる: ブロックに1辺以上接し、ふさがる辺（ブロック + 盤面の外）が空きに接する辺より多い
 *              （置くと、ブロックと空きの境目が短くなる）
 * rect は置いたあとにできる一番大きい長方形 { x, r, w, h }（無ければ null）
 */
export const RECT_MIN_EXTRA = 2;
export const RECT_MIN_AREA = 6;
export function fitOf(s, cells, ox, oy) {
  const own = new Set(cells.map((c) => (oy + c.y) * SIZE + ox + c.x));
  let walls = 0, blocks = 0, open = 0;
  for (const c of cells) {
    const x = ox + c.x, r = oy + c.y;
    for (const [dx, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, nr = r + dr, i = nr * SIZE + nx;
      if (!isInside(nx, nr)) walls++;
      else if (own.has(i)) continue;
      else if (s[i]) blocks++;
      else open++;
    }
  }
  const rect = blocks ? rectOf(s, cells, ox, oy, own) : null;
  const kind = !open && blocks ? 'perfect' : rect ? 'rect' : blocks && walls + blocks > open ? 'dent' : null;
  return { kind, walls, blocks, open, rect };
}

/** 置いたあと、形がまるごと入るすきまの無い長方形のうち一番大きいもの（fitOf の 'rect' の条件を満たすもの） */
function rectOf(s, cells, ox, oy, own) {
  // 置いたあとの占有の累積和（盤面の外は空き扱い = 長方形に入れない）
  const P = new Int16Array((SIZE + 1) * (SIZE + 1));
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
    const i = r * SIZE + x;
    const v = isInside(x, r) && (s[i] || own.has(i)) ? 1 : 0;
    P[(r + 1) * (SIZE + 1) + x + 1] = v + P[r * (SIZE + 1) + x + 1] + P[(r + 1) * (SIZE + 1) + x] - P[r * (SIZE + 1) + x];
  }
  const full = (x0, x1, r0, r1) => P[(r1 + 1) * (SIZE + 1) + x1 + 1] - P[r0 * (SIZE + 1) + x1 + 1]
    - P[(r1 + 1) * (SIZE + 1) + x0] + P[r0 * (SIZE + 1) + x0] === (x1 - x0 + 1) * (r1 - r0 + 1);
  let minX = SIZE, maxX = 0, minR = SIZE, maxR = 0;
  for (const c of cells) {
    minX = Math.min(minX, ox + c.x); maxX = Math.max(maxX, ox + c.x);
    minR = Math.min(minR, oy + c.y); maxR = Math.max(maxR, oy + c.y);
  }
  let best = null;
  // 形の外枠から4方向へ広げていく。広げてすきまができたら、その方向はそれ以上広げても無駄
  for (let x0 = minX; x0 >= 0 && full(x0, maxX, minR, maxR); x0--)
    for (let x1 = maxX; x1 < SIZE && full(x0, x1, minR, maxR); x1++)
      for (let r0 = minR; r0 >= 0 && full(x0, x1, r0, maxR); r0--)
        for (let r1 = maxR; r1 < SIZE && full(x0, x1, r0, r1); r1++) {
          const w = x1 - x0 + 1, h = r1 - r0 + 1;
          if (w < 2 || h < 2 || w * h < Math.max(RECT_MIN_AREA, cells.length + RECT_MIN_EXTRA)) continue;
          if (!best || w * h > best.w * best.h) best = { x: x0, r: r0, w, h };
        }
  return best;
}

/* ---------- 発動（mancala.js と同じ） ---------- */
/** Board.insertBottom と同じ。入れたら true */
function insertBottom(s, kind, n) {
  const cells = LINES[kind][n];
  const count = s[cntAt(kind, n)];
  if (count === n) return false;
  if (s[cells[0]]) {                           // 手前の端が埋まっている → 一番近い空欄まで奥へ詰めて入る
    for (const i of cells) if (!s[i]) { fill(s, i); return true; }
  }
  let first = -1;
  for (let k = 0; k < n; k++) if (s[cells[k]]) { first = k; break; }
  const stop = first < 0 ? n - 1 : first - 1;
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

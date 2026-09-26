import { SIZE, isInside, lineCells } from './constants.js?v=202609260258';
import { SHAPES } from './pieces.js?v=202609260258';
import * as Sim from './sim.js?v=202609260258';

/**
 * 全消しの手順探し専用の、さらに軽い盤面（ビット）。
 * 36 マスを 2 つの整数（lo = マス 0〜31、hi = マス 32〜35）のビットで持つので、盤面のコピーがいらない。
 *  - 形の置き方は、全部の位置のビットを前もって作っておき、重なりを AND 1回で調べる
 *  - 連鎖は、置いた形が通るラインのどれかが満杯になった時だけ解決する。解決は sim.js で行い、
 *    結果を盤面ごとに覚えておく（同じ盤面は2回解決しない）ので、ルールは sim.js・本体とまったく同じ
 * マスの番号は sim.js の keyOf と同じ順（上の行から、左から）。
 */
const INSIDE = [];
for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) INSIDE.push({ x, r });
const BIT_AT = new Map(INSIDE.map(({ x, r }, b) => [r * SIZE + x, b]));
const TWO32 = 4294967296;

/** マスの一覧 → [lo, hi] */
function maskOf(cells) {
  let lo = 0, hi = 0;
  for (const { x, r } of cells) {
    const b = BIT_AT.get(r * SIZE + x);
    if (b < 32) lo |= 1 << b; else hi |= 1 << (b - 32);
  }
  return [lo, hi];
}

/** ライン（縦1〜8・横1〜8）: { lo, hi, n } */
const LINES = [];
/** マス b が属する縦列・横列（LINES の番号） */
const COL_OF = new Array(INSIDE.length), ROW_OF = new Array(INSIDE.length);
for (const kind of ['col', 'row']) {
  for (let n = 1; n <= SIZE; n++) {
    const cells = lineCells(kind, n);
    const [lo, hi] = maskOf(cells);
    for (const { x, r } of cells) (kind === 'col' ? COL_OF : ROW_OF)[BIT_AT.get(r * SIZE + x)] = LINES.length;
    LINES.push({ lo, hi, n });
  }
}

/** 形ごとの置ける位置すべて: PLACEMENTS[name] = [{ name, ox, oy, lo, hi, lines: [LINES の番号] }] */
export const PLACEMENTS = {};
for (const s of SHAPES) {
  const list = [];
  for (let oy = 0; oy < SIZE; oy++) for (let ox = 0; ox < SIZE; ox++) {
    const cells = s.cells.map(([x, y]) => ({ x: ox + x, r: oy + y }));
    if (!cells.every(({ x, r }) => isInside(x, r))) continue;
    const [lo, hi] = maskOf(cells);
    const lines = [...new Set(cells.flatMap(({ x, r }) => { const b = BIT_AT.get(r * SIZE + x); return [COL_OF[b], ROW_OF[b]]; }))];
    list.push({ name: s.name, ox, oy, lo, hi, lines });
  }
  PLACEMENTS[s.name] = list;
}

export const keyOf = (lo, hi) => (lo >>> 0) + hi * TWO32;

function popcount(v) {
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}
export const blocks = (lo, hi) => popcount(lo) + popcount(hi);

/** sim.js の盤面 → [lo, hi] */
export function fromSim(s) {
  let lo = 0, hi = 0;
  INSIDE.forEach(({ x, r }, b) => { if (s[r * SIZE + x]) { if (b < 32) lo |= 1 << b; else hi |= 1 << (b - 32); } });
  return [lo, hi];
}
function toSim(lo, hi) {
  const s = Sim.fromBoard({ entries: () => [] });
  const cells = [];
  INSIDE.forEach(({ x, r }, b) => { if (b < 32 ? (lo >>> b) & 1 : (hi >>> (b - 32)) & 1) cells.push({ x, y: r }); });
  Sim.place(s, cells, 0, 0);
  return s;
}

/** 置いた直後の盤面 → 連鎖が終わった盤面のキー（盤面ごとに覚えておく） */
const resolved = new Map();
function resolve(lo, hi) {
  const key = keyOf(lo, hi);
  let out = resolved.get(key);
  if (out === undefined) {
    const s = toSim(lo, hi);
    Sim.resolveAll(s);
    const [rlo, rhi] = fromSim(s);
    out = keyOf(rlo, rhi);
    if (resolved.size > 200000) resolved.clear();
    resolved.set(key, out);
  }
  return out;
}

/**
 * 盤面 (lo, hi) に置き方 p を置いて連鎖まで解決した盤面のキー。置けなければ -1。
 * 置いた形が通るラインがどれも満杯にならなければ、連鎖は起きないので解決しない
 */
export function play(lo, hi, p) {
  if ((lo & p.lo) | (hi & p.hi)) return -1;
  const nlo = lo | p.lo, nhi = hi | p.hi;
  for (const i of p.lines) {
    const L = LINES[i];
    if ((nlo & L.lo) === L.lo && (nhi & L.hi) === L.hi) return resolve(nlo, nhi);
  }
  return keyOf(nlo, nhi);
}
export const loOf = (key) => (key % TWO32) | 0;
export const hiOf = (key) => Math.floor(key / TWO32);

/** sim.js の clearCost と同じ（全消しまでの遠さの目安） */
const miss = new Int8Array(LINES.length);
export function clearCost(lo, hi) {
  for (let i = 0; i < LINES.length; i++) miss[i] = LINES[i].n - popcount(lo & LINES[i].lo) - popcount(hi & LINES[i].hi);
  let cost = 0;
  for (let b = 0; b < 32; b++) if ((lo >>> b) & 1) cost += 1 + Math.min(miss[COL_OF[b]], miss[ROW_OF[b]]);
  for (let b = 32; b < INSIDE.length; b++) if ((hi >>> (b - 32)) & 1) cost += 1 + Math.min(miss[COL_OF[b]], miss[ROW_OF[b]]);
  return cost;
}

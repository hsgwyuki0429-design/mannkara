// 撮影モードの盤面集を作る: 「1個置くだけで大連鎖して全消し」になる盤面を焼きなまし法で大量に探し、
// 本物のゲーム（Game.placePiece）で置き直して確かめたものだけを src/core/studio-library.js に書き出す。
// 使い方: node scripts/build-studio.mjs [探す回数]   （省略時 160。1回 1 秒くらい）
import { writeFileSync } from 'node:fs';
import { Board, createBlock } from '../src/core/board.js';
import { Game } from '../src/core/game.js';
import { Piece, SHAPES } from '../src/core/pieces.js';
import { isInside, SIZE } from '../src/core/constants.js';
import * as Sim from '../src/core/sim.js';
import { encodeCells, studioState, STUDIO_SLOT } from '../src/core/studio.js';

const RUNS = Number(process.argv[2]) || 160;
const ITERATIONS = 4000;
/** 盤面集に入れる最低の連鎖数 */
const MIN_CHAIN = 10;
/** 盤面集に入れる最低のブロック数（少ないと、消えていく見映えが弱い） */
const MIN_BLOCKS = 12;
let seed = 20261010;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const INSIDE = [];
for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) INSIDE.push([x, r]);
const CELLS = SHAPES.map((s) => [s.name, new Piece(s.name).cells]);
const TYPE_OF = Object.fromEntries(SHAPES.map((s) => [s.name, s.type]));
const TYPES = [...new Set(SHAPES.map((s) => s.type))];
const cellsOf = (occ) => INSIDE.filter((_, i) => occ[i]);
function simOf(occ) {
  const b = new Board();
  for (const [x, r] of cellsOf(occ)) b.set(x, r, createBlock('blue'));
  return Sim.fromBoard(b);
}

/**
 * 盤面の良さ: 満杯のラインが残っている盤面（連鎖が終わっていない）は使えない。
 * どれか1つの形をどこかに置いて全消しになれば 1000 点 + 連鎖の長さ・ブロックの多さ（見映え）。
 * ならなければ、残るブロックが少ないほど良い（全消しに近づける）
 */
function evaluate(occ, w) {
  const s = simOf(occ);
  if (Sim.fullLines(s).length) return null;
  const n = Sim.blocks(s);
  let best = { f: -Infinity };
  for (const [name, cells] of CELLS) {
    for (const [ox, oy] of Sim.placements(s, cells)) {
      const b = s.slice();
      Sim.place(b, cells, ox, oy);
      const chain = Sim.resolveAll(b), left = Sim.blocks(b);
      const favor = TYPE_OF[name] === w.favor ? w.favorBonus : 0;
      const f = left === 0 ? 1000 + chain * w.chain + n * w.blocks + cells.length * w.size + favor : chain * 2 - left * 8;
      if (f > best.f) best = { f, name, ox, oy, chain, left, n };
    }
  }
  return best;
}

function anneal(w) {
  let occ, cur;
  do { occ = INSIDE.map(() => (random() < 0.5 ? 1 : 0)); cur = evaluate(occ, w); } while (!cur);
  let T = 20;
  for (let it = 0; it < ITERATIONS; it++) {
    const next = occ.slice();
    const k = 1 + Math.floor(random() * 2);
    for (let j = 0; j < k; j++) next[Math.floor(random() * INSIDE.length)] ^= 1;
    const e = evaluate(next, w);
    T *= 0.999;
    if (!e) continue;
    if (e.f >= cur.f || random() < Math.exp((e.f - cur.f) / T)) { occ = next; cur = e; }
  }
  return cur.left === 0 ? { occ, ...cur } : null;
}

/** ダミーの手駒: 盤面に置ける形で、置いても全消しにならないもの（置く形・1マスとは別の種類） */
function decoysFor(occ, key) {
  const s = simOf(occ);
  const keyType = new Piece(key).type;
  const ok = SHAPES.filter((sh) => sh.type !== keyType && sh.type !== 'Dot' && Sim.fits(s, new Piece(sh.name).cells));
  const out = [];
  while (out.length < 2 && ok.length) {
    const i = Math.floor(random() * ok.length);
    const sh = ok.splice(i, 1)[0];
    if (out.some((n) => new Piece(n).type === sh.type)) continue;
    out.push(sh.name);
  }
  return out;
}

/** 本物のゲームで置き直して、全消しになるか確かめる。なれば連鎖数 */
function verify(code) {
  const { state, target } = studioState(code);
  const game = new Game({ random });
  game.importState(state);
  game.scripted = true;
  const turn = game.placePiece(STUDIO_SLOT, target.ox, target.oy);
  return turn && turn.allClear && game.board.totalBlocks() === 0 ? turn.steps.length : 0;
}

const found = new Map();
const t0 = Date.now();
for (let run = 0; run < RUNS; run++) {
  // 連鎖の長さを重く見る回・ブロックの多さを重く見る回を混ぜ、回ごとに置く形の好みも変えて、いろいろな盤面にする
  const w = { chain: 6 + random() * 10, blocks: 1 + random() * 5, size: random() * 3,
    favor: TYPES[Math.floor(random() * TYPES.length)], favorBonus: random() < 0.75 ? 60 : 0 };
  const res = anneal(w);
  if (!res || res.chain < MIN_CHAIN || res.n < MIN_BLOCKS) continue;
  const hex = encodeCells(cellsOf(res.occ));
  if (found.has(hex)) continue;
  for (let tries = 0; tries < 6; tries++) {
    const code = [hex, `${res.name}@${res.ox}${res.oy}`, ...decoysFor(res.occ, res.name)].join(' ');
    const chain = verify(code);
    if (chain >= MIN_CHAIN) { found.set(hex, { code, chain, blocks: res.n }); break; }
  }
  if ((run + 1) % 10 === 0) console.log(`${run + 1}/${RUNS}  見つかった盤面 ${found.size}  ${((Date.now() - t0) / 1000).toFixed(0)}s`);
}

// 並び: 「次へ」で似た盤面ばかり続かないよう、置く形の種類ごとに1つずつ順に取り出す
// （各種類の中では、連鎖が長い → ブロックが多い順。1周の中でも同じ順）
const better = (a, b) => b.chain - a.chain || b.blocks - a.blocks;
const byType = new Map();
for (const e of [...found.values()].sort(better)) {
  const type = new Piece(e.code.split(' ')[1].split('@')[0]).type;
  if (!byType.has(type)) byType.set(type, []);
  byType.get(type).push(e);
}
const list = [];
while (byType.size) {
  const round = [];
  for (const [type, items] of byType) { round.push(items.shift()); if (!items.length) byType.delete(type); }
  list.push(...round.sort(better));
}
const hist = {};
for (const e of list) hist[e.chain] = (hist[e.chain] ?? 0) + 1;
const out = `// 自動生成: node scripts/build-studio.mjs （手で編集しない）
// 撮影モードの盤面 ${list.length} 個。光っている場所に1個置くだけで、大連鎖して全消しになる（本物のゲームで置き直して確かめたもの）。
// 書き方は src/core/studio.js の parseStudio。並びは、置く形の種類を1つずつ順に（似た盤面が続かないように）
export const STUDIO_BOARDS = [
${list.map((e) => `  ${JSON.stringify(e.code)},   // ${e.chain}連鎖・${e.blocks}個`).join('\n')}
];
`;
writeFileSync(new URL('../src/core/studio-library.js', import.meta.url), out);
console.log(`書き出した: ${list.length} 個  連鎖数の分布 ${JSON.stringify(hist)}`);

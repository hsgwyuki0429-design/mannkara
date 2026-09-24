// 空の盤面から「決まった手順どおりに置くと、最後の1個でちょうど全消し」になる手順を大量に探し、
// 良いものを選んで src/core/allclear-library.js に書き出す（ゲーム中は探さずにこの手順集から選ぶ）。
// 使い方: node scripts/build-allclear.mjs [本数]   （省略時 300。対称な手順も加えるのでおよそ倍になる）
import { writeFileSync } from 'node:fs';
import { Board } from '../src/core/board.js';
import { resolveChains } from '../src/core/mancala.js';
import { Piece, SHAPES } from '../src/core/pieces.js';
import { planAllClear, countWays } from '../src/core/planner.js';
import * as Sim from '../src/core/sim.js';

const TARGET = Number(process.argv[2]) || 300;
/** 手順の長さ（トレイは3個ずつなので3の倍数）と、その割合 */
const LENGTHS = [[6, 0.2], [9, 0.6], [12, 0.2]];
let seed = 20260924;
const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

const encode = (seq) => seq.map((m) => `${m.name}@${m.ox}${m.oy}`).join(' ');

/**
 * 本体（Board / resolveChains）で置き直して確かめる。
 * 全部置けて、途中で空にならず、最後の1個でちょうど空になるなら、各手の連鎖数を返す。だめなら null
 */
function verify(seq) {
  const b = new Board(), chains = [];
  for (const [i, m] of seq.entries()) {
    const p = new Piece(m.name);
    if (!b.canPlace(p, m.ox, m.oy)) return null;
    b.place(p, m.ox, m.oy);
    chains.push(resolveChains(b).length);
    const left = b.totalBlocks();
    if (i < seq.length - 1 ? left === 0 : left !== 0) return null;
  }
  return chains;
}

/** 縦横を入れ替えた手順（盤面は対角線について対称）。入れ替えた形が手駒に無ければ null */
const norm = (cells) => cells.map(([x, y]) => `${x},${y}`).sort().join(' ');
const BY_CELLS = new Map(SHAPES.map((s) => [norm(s.cells), s.name]));
function transpose(seq) {
  const out = [];
  for (const m of seq) {
    const cells = SHAPES.find((s) => s.name === m.name).cells.map(([x, y]) => [y, x]);
    const name = BY_CELLS.get(norm(cells));
    if (!name) return null;
    out.push({ name, ox: m.oy, oy: m.ox });
  }
  return out;
}

const plans = new Map();                     // 手順の文字列 -> { len, chains }
const firstTrays = new Map();                // 1回目のトレイの形の組み合わせ -> 出た回数（同じ始まりばかりにしない）
const add = (seq) => {
  const chains = verify(seq);
  if (!chains) return false;
  if (chains.at(-1) < 3) return false;                       // 最後の1個は3連鎖以上で全部消える見せ場にする
  const code = encode(seq);
  if (plans.has(code)) return false;
  plans.set(code, { len: seq.length, chains });
  return true;
};

const t0 = Date.now();
let tries = 0;
for (const [len, share] of LENGTHS) {
  const want = Math.round(TARGET * share);
  let got = 0;
  while (got < want && tries < TARGET * 40) {
    tries++;
    // 1マスの形を使うと簡単に消せてしまい似た手順ばかりになるので、7割は1マスなしで探す
    const avoid = random() < 0.7 ? ['Dot'] : [];
    const seq = planAllClear(new Board(), { depth: len, random, budgetMs: 400, beam: 16, sample: 12, avoid });
    if (!seq) continue;
    const first = seq.slice(0, 3).map((m) => m.name).sort().join(',');
    if ((firstTrays.get(first) ?? 0) >= 3) continue;
    if (!add(seq)) continue;
    firstTrays.set(first, (firstTrays.get(first) ?? 0) + 1);
    got++;
    const t = transpose(seq);
    if (t) add(t);                                            // 本体で確かめて通ったものだけ
  }
}

// 1回目のトレイから見て「置き方がたくさんあるうちの1通り」になっているか（手順どおりでないと崩れる目安）
const empty = Sim.fromBoard(new Board());
const ways = [...plans.keys()].slice(0, 60).map((code) => countWays(empty, code.split(' ').slice(0, 3).map((m) => m.split('@')[0]), 500).count);

const list = [...plans.keys()];
const byLen = LENGTHS.map(([len]) => `${len}個: ${[...plans.values()].filter((p) => p.len === len).length}`).join(' / ');
const src = `// 自動生成: node scripts/build-allclear.mjs （手で編集しない）
// 空の盤面から、この順番・この場所に置くと最後の1個でちょうど全消しになる手順（${list.length} 本。${byLen}）。
// 1手は "形の名前@左上のx左上のy"。本体で置き直して確かめたものだけを入れている
export const ALL_CLEAR_PLANS = [
${list.map((c) => '  ' + JSON.stringify(c) + ',').join('\n')}
];
`;
writeFileSync(new URL('../src/core/allclear-library.js', import.meta.url), src);
const w = ways.sort((a, b) => a - b);
console.log(`${list.length} plans (${byLen}) in ${((Date.now() - t0) / 1000).toFixed(0)}s, ${tries} searches`);
console.log(`1回目のトレイの置き方の数（60本, 500で打ち切り）: 最小 ${w[0]} / 中央値 ${w[w.length >> 1]} / 最大 ${w.at(-1)}`);

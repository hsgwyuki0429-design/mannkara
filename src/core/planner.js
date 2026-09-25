import { Piece, SHAPES } from './pieces.js?v=202609251248';
import * as Sim from './sim.js?v=202609251248';

const now = () => (globalThis.performance?.now?.() ?? Date.now());
const CELLS = Object.fromEntries(SHAPES.map((s) => [s.name, new Piece(s.name).cells]));
const ALL = SHAPES.map((s) => s.name);

/**
 * 手駒を「順番と場所を選べば全部置ける」か（置くたびに連鎖も解決する）。
 * 深さ優先で「残りのどれかを、どこかに置く」を試し、1通りでも最後まで置ければ true。
 */
export function solvable(s, names) {
  if (names.length === 0) return true;
  if (names.length === 1) return Sim.fits(s, CELLS[names[0]]);
  const tried = new Set();
  for (let i = 0; i < names.length; i++) {
    if (tried.has(names[i])) continue;              // 同じ形は1回試せば十分
    tried.add(names[i]);
    const others = names.filter((_, j) => j !== i);
    const cells = CELLS[names[i]];
    for (const [ox, oy] of Sim.placements(s, cells)) {
      const b = Sim.cloneSim(s);
      Sim.place(b, cells, ox, oy);
      Sim.resolveAll(b);
      if (solvable(b, others)) return true;
    }
  }
  return false;
}

/**
 * 手駒を全部置き切る「置き方」を数える。数えるのは置き終えた盤面（連鎖後）の種類の数で、
 * 置く順番を入れ替えただけで同じ結果になるものは1通りと数える（プレイヤーから見て同じ手なので）。
 * cap 通り見つかった時点で打ち切る。{ count, ends: Set<盤面のキー> } を返す。
 */
export function countWays(s, names, cap = Infinity) {
  const ends = new Set(), seen = new Set();
  const rec = (st, rest) => {
    if (ends.size >= cap) return;
    const key = Sim.keyOf(st);
    if (!rest.length) { ends.add(key); return; }
    const memo = key + '|' + rest.join(',');             // 同じ盤面・同じ残りの形は1回だけ調べる
    if (seen.has(memo)) return;
    seen.add(memo);
    for (let i = 0; i < rest.length; i++) {
      if (i > 0 && rest[i] === rest[i - 1]) continue;     // 同じ形は1回試せば十分（rest は並べ替え済み）
      const others = rest.filter((_, j) => j !== i);
      const cells = CELLS[rest[i]];
      for (const [ox, oy] of Sim.placements(st, cells)) {
        const b = Sim.cloneSim(st);
        Sim.place(b, cells, ox, oy);
        Sim.resolveAll(b);
        rec(b, others);
        if (ends.size >= cap) return;
      }
    }
  };
  rec(s, [...names].sort());
  return { count: ends.size, ends };
}

/** 形 name を盤面のどこに置けるかの数 */
export const spots = (s, name) => Sim.placements(s, CELLS[name]).length;

/**
 * 全消しの手順を探す。
 * 今の盤面から depth 個のピースを順に置き、ちょうど depth 個目で盤面が空になる手順を返す
 * （途中で空になる手順は使わない。全消しは最後の見せ場にする）。
 * ビームサーチを、揺らぎを変えながら budgetMs の間くり返す。avoid に挙げた種類（'Dot' など）は使わない。
 * depth の代わりに depths（手数の候補の配列）を渡すと、くり返すたびに候補からランダムに選ぶ。
 * 見つかれば [{ name, ox, oy }, …]、見つからなければ null。
 */
export function planAllClear(board, { depth, depths = [depth], random = Math.random, budgetMs = 40, beam = 10, sample = 10, avoid = [] } = {}) {
  const deadline = now() + budgetMs;
  const start = Sim.fromBoard(board);
  const ok = (name) => !avoid.includes(TYPE_OF[name]);
  do {
    const d = depths[Math.floor(random() * depths.length)];
    const seq = beamSearch(start, d, random, beam, sample, deadline, ok);
    if (seq) return seq;
  } while (now() < deadline);
  return null;
}

/**
 * 1回ぶんのビームサーチ。各手数で「全消しまでの遠さ」(clearCost) が小さい盤面を beam 個だけ残して進む。
 * 形は出現率どおりに sample 個ずつ抽選して試すので、特定の形ばかりにはならない（最後の1手だけは全部の形を試す）。
 */
function beamSearch(start, depth, random, beam, sample, deadline, ok) {
  let states = [{ s: start, seq: [] }];
  for (let d = 1; d <= depth; d++) {
    const last = d === depth;
    const kids = new Map();
    for (const st of states) {
      for (const name of last ? ALL : sampleShapes(random, sample)) {
        if (!ok(name) || !allowed(st.seq, name)) continue;
        const cells = CELLS[name];
        for (const [ox, oy] of Sim.placements(st.s, cells)) {
          const b = Sim.cloneSim(st.s);
          Sim.place(b, cells, ox, oy);
          Sim.resolveAll(b);
          const left = Sim.blocks(b);
          if (last) { if (left === 0) return [...st.seq, { name, ox, oy }]; continue; }
          if (left === 0) continue;                           // 途中で空になる手順は使わない
          const score = Sim.clearCost(b) + random() * 2;      // 少し揺らして毎回違う手順に
          const key = Sim.keyOf(b);
          const prev = kids.get(key);
          if (!prev || prev.score > score) kids.set(key, { s: b, seq: [...st.seq, { name, ox, oy }], score });
        }
      }
      if (now() > deadline) return null;
    }
    states = [...kids.values()].sort((a, b) => a.score - b.score).slice(0, beam);
    if (!states.length) return null;
  }
  return null;
}

/**
 * 小さい形ばかりの不自然な手順にならないよう、1つの手順に入れる数を制限する
 * （1マスは1個まで、ほかは同じ種類2個まで）
 */
const TYPE_OF = Object.fromEntries(SHAPES.map((s) => [s.name, s.type]));
function allowed(seq, name) {
  const type = TYPE_OF[name];
  const same = seq.filter((m) => TYPE_OF[m.name] === type).length;
  return same < (type === 'Dot' ? 1 : 2);
}

/** 出現率どおりの重みで、重複なしに k 個の形を選ぶ */
function sampleShapes(random, k) {
  const pool = [...SHAPES];
  const out = [];
  while (out.length < k && pool.length) {
    let t = random() * pool.reduce((a, s) => a + s.weight, 0);
    let i = pool.findIndex((s) => (t -= s.weight) < 0);
    if (i < 0) i = pool.length - 1;
    out.push(pool[i].name);
    pool.splice(i, 1);
  }
  return out;
}

/** 手順どおりに置いたあとの盤面のキー（プレイヤーが計画どおりに進めたかの確認用） */
export function keyAfter(board, seq) {
  const s = Sim.fromBoard(board);
  for (const { name, ox, oy } of seq) {
    Sim.place(s, CELLS[name], ox, oy);
    Sim.resolveAll(s);
  }
  return Sim.keyOf(s);
}

import { Piece, SHAPES } from './pieces.js?v=202609260258';
import * as Bits from './bitboard.js?v=202609260258';
import * as Sim from './sim.js?v=202609260258';

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
 * 今の盤面から順にピースを置き、手数が minDepth 以上 maxDepth 以下の step の倍数（トレイの区切り）のところで
 * ちょうど盤面が空になる手順を返す（途中で空になる手順は使わない。全消しは最後の見せ場にする）。
 * 1回のビームサーチで minDepth〜maxDepth のどの長さでも見つけられるので、長い手順でも見つかりやすい。
 * minDepth は minDepths（候補の配列）からくり返すたびにランダムに選ぶ（毎回同じ長さにならないように）。
 * 揺らぎを変えながら budgetMs の間くり返す。avoid に挙げた種類（'Dot' など）は使わない。
 * depth を渡すと、ちょうど depth 個の手順だけを探す。
 * 見つかれば [{ name, ox, oy }, …]、見つからなければ null。
 */
export function planAllClear(board, {
  depth, depths = depth ? [depth] : [6], maxDepth, step = 3,
  random = Math.random, budgetMs = 40, beam = 10, sample = 10, avoid = [],
} = {}) {
  const deadline = now() + budgetMs;
  const start = Sim.fromBoard(board);
  const ok = (name) => !avoid.includes(TYPE_OF[name]);
  do {
    const lo = depths[Math.floor(random() * depths.length)];
    const hi = depth ?? Math.max(lo, maxDepth ?? lo);
    const seq = beamSearch(start, lo, hi, step, random, beam, sample, deadline, ok);
    if (seq) return seq;
  } while (now() < deadline);
  return null;
}

/**
 * 1回ぶんのビームサーチ。各手数で「全消しまでの遠さ」(clearCost) が小さい盤面を beam 個だけ残して進む。
 * 形は出現率どおりに sample 個ずつ抽選して試すので、特定の形ばかりにはならない。
 * 全消しにしてよい手数（lo 以上 hi 以下の step の倍数）では全部の形を試し、空になったらその手順を返す。
 * 盤面はビット（bitboard.js）で持ち、手順は親をたどって最後に組み立てる（途中でコピーを作らない）。
 */
function beamSearch(start, lo, hi, step, random, beam, sample, deadline, ok) {
  const [slo, shi] = Bits.fromSim(start);
  let states = [{ lo: slo, hi: shi, parent: null, move: null, types: {} }];
  for (let d = 1; d <= hi; d++) {
    const finish = d >= lo && d % step === 0;
    const kids = new Map();
    for (const st of states) {
      for (const name of finish ? ALL : sampleShapes(random, sample)) {
        if (!ok(name) || !allowedType(st.types, name)) continue;
        for (const p of Bits.PLACEMENTS[name]) {
          const key = Bits.play(st.lo, st.hi, p);
          if (key < 0) continue;
          if (key === 0) {
            if (finish) return seqOf({ parent: st, move: p });
            continue;                                         // 途中で空になる手順は使わない
          }
          if (d === hi) continue;
          const prev = kids.get(key);
          const klo = Bits.loOf(key), khi = Bits.hiOf(key);
          const base = prev ? prev.base : Bits.clearCost(klo, khi);   // 同じ盤面の遠さは1回だけ計算
          const score = base + random() * 2;                  // 少し揺らして毎回違う手順に
          if (!prev || prev.score > score) kids.set(key, { lo: klo, hi: khi, parent: st, move: p, score, base });
        }
      }
      if (now() > deadline) return null;
    }
    states = [...kids.values()].sort((a, b) => a.score - b.score).slice(0, beam);
    for (const st of states) st.types = { ...st.parent.types, [TYPE_OF[st.move.name]]: (st.parent.types[TYPE_OF[st.move.name]] ?? 0) + 1 };
    if (!states.length) return null;
  }
  return null;
}
/** 親をたどって手順 [{ name, ox, oy }, …] を組み立てる */
function seqOf(st) {
  const seq = [];
  for (let s = st; s.move; s = s.parent) seq.push({ name: s.move.name, ox: s.move.ox, oy: s.move.oy });
  return seq.reverse();
}

/**
 * 小さい形ばかりの不自然な手順にならないよう、1つの手順に入れる数を制限する
 * （1マスは1個まで、ほかは同じ種類2個まで）
 */
const TYPE_OF = Object.fromEntries(SHAPES.map((s) => [s.name, s.type]));
/** types = これまでの手順に入っている種類ごとの数 */
function allowedType(types, name) {
  const type = TYPE_OF[name];
  return (types[type] ?? 0) < (type === 'Dot' ? 1 : 2);
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

import { SIZE, SCORE_PER_GOAL, chainMultiplier } from './constants.js?v=202609251235';
import { SHAPE_BY_NAME } from './pieces.js?v=202609251235';
import { solvable } from './planner.js?v=202609251235';
import * as Sim from './sim.js?v=202609251235';

/**
 * 学習モードの「おすすめの置き場所」（AI ではなく、今の盤面での総当たり）。
 *
 * 候補 = 残っている手駒のどれかを、置ける場所のどこかに置く手。それぞれについて:
 *  1. 置いたあと、残りの手駒を全部置き切れるか（詰まないか）… これを最優先
 *  2. その手で入る点数（ゴールに入る個数 × 連鎖の倍率）
 *  3. 置いたあとの盤面の良さ（evaluate）
 *  4. もう1手先: 残りの手駒の次の1手で入る点数と盤面の良さ（の最大）を半分の重みで
 * の合計が一番大きい手を返す。
 */
const cellsOf = (name) => SHAPE_BY_NAME[name].cells.map(([x, y]) => ({ x, y }));
/** 盤面に「置ける場所が残っているか」を見る大きめの形（空間が潰れていないかの目安） */
const ROOMY = ['O0', 'I0', 'I1', 'O30', 'R0', 'R1', 'V50', 'V52'].map(cellsOf);
const now = () => (globalThis.performance?.now?.() ?? Date.now());

/** その手で入る点数のおおよそ（ゴールに入った個数 × 連鎖の倍率） */
function gainOf(before, after, cells, chains) {
  const goals = before + cells - Sim.blocks(after);
  return goals * SCORE_PER_GOAL * chainMultiplier(Math.max(1, chains));
}

/**
 * 置いたあとの盤面の良さ（大きいほど良い）:
 * ブロックが少ない・全消しに近い / 満杯まであと1個のラインが多い（次に消しやすい）/ 大きい形を置ける場所が残っている
 */
export function evaluate(s) {
  let near = 0;
  for (const kind of ['col', 'row']) for (let n = 2; n <= SIZE; n++) {
    if (Sim.lineCount(s, kind, n) === n - 1) near++;
  }
  let roomy = 0;
  for (const cells of ROOMY) if (Sim.fits(s, cells)) roomy++;
  return -10 * Sim.blocks(s) - 3 * Sim.clearCost(s) + 18 * near + 14 * roomy;
}

/**
 * おすすめの手 { slot, ox, oy, survive } を返す（置ける手が無ければ null）。
 * tray は [Piece | null, …]。budgetMs を過ぎたら、もう1手先の読みを省いて決める
 */
export function bestMove(board, tray, { budgetMs = 60 } = {}) {
  const start = Sim.fromBoard(board);
  const before = Sim.blocks(start);
  const rest = tray.map((p, slot) => p && { slot, name: p.name, cells: cellsOf(p.name) }).filter(Boolean);
  const deadline = now() + budgetMs;
  let best = null;
  const tried = new Set();
  for (const r of rest) {
    if (tried.has(r.name)) continue;                          // 同じ形は1回調べれば十分
    tried.add(r.name);
    const others = rest.filter((o) => o !== r);
    for (const [ox, oy] of Sim.placements(start, r.cells)) {
      const b = Sim.cloneSim(start);
      Sim.place(b, r.cells, ox, oy);
      const chains = Sim.resolveAll(b);
      const survive = solvable(b, others.map((o) => o.name));
      let value = gainOf(before, b, r.cells.length, chains) + evaluate(b);
      if (others.length && now() < deadline) value += 0.5 * lookahead(b, others);
      if (!best || (survive && !best.survive) || (survive === best.survive && value > best.value)) {
        best = { slot: r.slot, ox, oy, survive, value };
      }
    }
  }
  return best && { slot: best.slot, ox: best.ox, oy: best.oy, survive: best.survive };
}

/** 残りの手駒の「次の1手」で得られる点数 + 盤面の良さの最大 */
function lookahead(s, others) {
  const before = Sim.blocks(s);
  let best = -Infinity;
  const tried = new Set();
  for (const o of others) {
    if (tried.has(o.name)) continue;
    tried.add(o.name);
    for (const [ox, oy] of Sim.placements(s, o.cells)) {
      const b = Sim.cloneSim(s);
      Sim.place(b, o.cells, ox, oy);
      const chains = Sim.resolveAll(b);
      best = Math.max(best, gainOf(before, b, o.cells.length, chains) + evaluate(b));
    }
  }
  return best === -Infinity ? -500 : best;
}

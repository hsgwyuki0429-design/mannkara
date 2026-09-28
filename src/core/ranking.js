/**
 * ランキング（端末ごと・モードごとに別）。1ゲームを { score, chain, combo, at } の1件として残し、
 * スコア・コンボ・連鎖のそれぞれで上位 RANK_SIZE 件を出す。
 * どのランキングにも入らなくなったゲームは残さない（残るのは多くても RANK_SIZE × 3 件）。
 * DOM も localStorage も使わない（main.js が読み書きする）
 */
export const RANK_SIZE = 10;
/** 画面の上のボタンの並び順 */
export const RANK_KINDS = ['score', 'combo', 'chain'];

/**
 * そのランキングの上位（値が 0 のゲームは出さない）。同じ値なら、スコアが高い方 → 先に出した方が上
 * （あとから同じ記録を出しても、前の記録を抜かない）
 */
export function topBy(list, kind, n = RANK_SIZE) {
  return list
    .filter((r) => r[kind] > 0)
    .sort((a, b) => b[kind] - a[kind] || b.score - a.score || (a.at || 0) - (b.at || 0))
    .slice(0, n);
}

/** ゲームを1件足す。{ list: 足したあとの一覧, ranks: { score, combo, chain } それぞれ何位か（入らなければ 0） } */
export function addRun(list, run) {
  const all = [...list, run];
  const ranks = {};
  const keep = new Set();
  for (const kind of RANK_KINDS) {
    const top = topBy(all, kind);
    ranks[kind] = top.indexOf(run) + 1;
    for (const r of top) keep.add(r);
  }
  return { list: all.filter((r) => keep.has(r)), ranks };
}

/** 端末に残っていた一覧を読む（壊れていたら空）。数でない値は 0 にする */
export function parseRanking(text) {
  let data;
  try { data = JSON.parse(text || '[]'); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return data.filter((r) => r && typeof r === 'object')
    .map((r) => ({ score: num(r.score), chain: num(r.chain), combo: num(r.combo), at: num(r.at), ...(r.legacy ? { legacy: true } : {}) }));
}

/**
 * ランキングができる前の記録（ベストスコア・最大連鎖・最大コンボ）を、それぞれ別の1件として入れる。
 * どのゲームの記録かは分からないので、ほかの値は 0（その値のランキングにだけ出る）・日付なし・legacy
 */
export function legacyRuns(best, records) {
  const out = [];
  if (best > 0) out.push({ score: best, chain: 0, combo: 0, at: 0, legacy: true });
  if (records?.chain > 0) out.push({ score: 0, chain: records.chain, combo: 0, at: 0, legacy: true });
  if (records?.combo > 0) out.push({ score: 0, chain: 0, combo: records.combo, at: 0, legacy: true });
  return out;
}

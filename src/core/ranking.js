/**
 * この端末のランキング（スコアだけ。端末ごと・モードごとに別）。1ゲームを { score, at } の1件として残し、
 * 上位 RANK_SIZE 件だけを残す。DOM も localStorage も使わない（main.js が読み書きする）
 */
export const RANK_SIZE = 10;

/** 上位（0 点は出さない）。同じスコアなら先に出した方が上（あとから同じ点を出しても、前の記録を抜かない） */
export function topRuns(list, n = RANK_SIZE) {
  return list
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || (a.at || 0) - (b.at || 0))
    .slice(0, n);
}

/** ゲームを1件足す。{ list: 足したあとの上位, rank: 何位か（入らなければ 0） } */
export function addRun(list, run) {
  const top = topRuns([...list, run]);
  return { list: top, rank: top.indexOf(run) + 1 };
}

/** 端末に残っていた一覧を読む（壊れていたら空）。数でない値は 0 にする */
export function parseRanking(text) {
  let data;
  try { data = JSON.parse(text || '[]'); } catch { return []; }
  if (!Array.isArray(data)) return [];
  const num = (v) => (Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  return topRuns(data.filter((r) => r && typeof r === 'object').map((r) => ({ score: num(r.score), at: num(r.at) })));
}

/** ランキングができる前のベストスコアを1件として入れる（どの日の記録かは分からないので日付なし） */
export const legacyRuns = (best) => (best > 0 ? [{ score: best, at: 0 }] : []);

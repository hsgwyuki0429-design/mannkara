import { TIGHT_RATE } from './constants.js?v=202610051342';

/**
 * ひっかけ（置き方が1〜2通りしかない組み合わせ）の確率を、遊んでいる人の出来に合わせて変える。
 *  - ベストスコアがまだ無い・最近のゲームがベストの半分にも届いていない（うまくいっていない）→ ほとんど出さない（快適に遊べる）
 *  - 今のゲームがベストの 85% を超えた（自己ベストが近い）→ 多めに出す。ベストを超えたらさらに多く（間違えさせる）
 *  - それ以外はふつう（TIGHT_RATE）
 * skill = { best: ベストスコア, recent: 最近のゲームのスコア（新しい順） }。無ければふつう
 */
export const TIGHT_RATE_EASY = 0.01;
export const TIGHT_RATE_NEAR_BEST = 0.15;
export const TIGHT_RATE_OVER_BEST = 0.25;
export const NEAR_BEST = 0.85;
export const STRUGGLING = 0.5;
export const RECENT_GAMES = 5;

export function tightRateFor(score, skill) {
  if (!skill) return TIGHT_RATE;
  const best = skill.best || 0;
  if (best <= 0) return TIGHT_RATE_EASY;
  if (score > best) return TIGHT_RATE_OVER_BEST;
  if (score >= best * NEAR_BEST) return TIGHT_RATE_NEAR_BEST;
  const recent = (skill.recent || []).slice(0, RECENT_GAMES);
  if (recent.length && recent.reduce((a, b) => a + b, 0) / recent.length < best * STRUGGLING) return TIGHT_RATE_EASY;
  return TIGHT_RATE;
}

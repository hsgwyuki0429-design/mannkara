import { TIGHT_RATE, ALL_CLEAR_RATE } from './constants.js?v=202610091208';

/**
 * ひっかけ（置き方が1〜2通りしかない組み合わせ）の確率を、遊んでいる人の出来に合わせて変える。
 * 急に難しくなったと気づかれないよう、段差を付けずになめらかに変える。
 *  - 最初の NEW_GAMES ゲーム（まだルールに慣れていない）→ 0%
 *  - 最近のゲームの平均がベストの半分未満（うまくいっていない）→ 1%（考えれば置けるので、少しは出して上達につなげる）
 *  - それ以外は 3%（TIGHT_RATE）
 *  - 今のゲームがベストの 80% → 100%: 3% → 8% へなめらかに上げる
 *  - ベストを超えたら 8% から、超えた分だけ上げて、ベストの 1.3 倍で上限 12%
 * ひっかけを配った直後の TIGHT_COOLDOWN 回の補充は 0%（game.js。続けて当たって理不尽に感じないように）
 * skill = { best: このゲームを始めたときのベスト, recent: 最近のスコア（新しい順）, games: 遊んだゲーム数 }。無ければ 3%
 */
export const NEW_GAMES = 3;
export const TIGHT_RATE_STRUGGLING = 0.01;
export const NEAR_BEST = 0.8;
export const TIGHT_RATE_AT_BEST = 0.08;
export const TIGHT_RATE_MAX = 0.12;
export const OVER_BEST_SPAN = 0.3;
export const STRUGGLING = 0.5;
export const RECENT_GAMES = 5;
export const TIGHT_COOLDOWN = 2;

export function tightRateFor(score, skill) {
  if (!skill) return TIGHT_RATE;
  const best = skill.best || 0;
  if (best <= 0 || (skill.games ?? Infinity) < NEW_GAMES) return 0;
  const r = score / best;
  if (r > 1) return Math.min(TIGHT_RATE_MAX, TIGHT_RATE_AT_BEST + (TIGHT_RATE_MAX - TIGHT_RATE_AT_BEST) * (r - 1) / OVER_BEST_SPAN);
  if (r >= NEAR_BEST) return TIGHT_RATE + (TIGHT_RATE_AT_BEST - TIGHT_RATE) * (r - NEAR_BEST) / (1 - NEAR_BEST);
  const recent = (skill.recent || []).slice(0, RECENT_GAMES);
  if (recent.length && recent.reduce((a, b) => a + b, 0) / recent.length < best * STRUGGLING) return TIGHT_RATE_STRUGGLING;
  return TIGHT_RATE;
}

/**
 * 全消しのチャンスの確率も、出来に合わせる（上限 ALL_CLEAR_RATE_MAX = 40%）。
 *  - 最初の NEW_GAMES ゲーム・うまくいっていない（最近の平均がベストの半分未満）→ 40%（全消しで一気に点が入り、立て直せる）
 *  - ふつう → 25%（ALL_CLEAR_RATE）
 *  - 今のゲームがベストの 80% → 100%: 25% → 15% へなめらかに下げる（ベストの更新は、全消しに頼りすぎず自分の力で）
 *  - ベストを超えたら 15% から、ベストの 1.3 倍で下限 10%
 * skill が無ければ 25%
 */
export const ALL_CLEAR_RATE_MAX = 0.4;
export const ALL_CLEAR_RATE_AT_BEST = 0.15;
export const ALL_CLEAR_RATE_MIN = 0.1;
export function allClearRateFor(score, skill) {
  if (!skill) return ALL_CLEAR_RATE;
  const best = skill.best || 0;
  if (best <= 0 || (skill.games ?? Infinity) < NEW_GAMES) return ALL_CLEAR_RATE_MAX;
  const r = score / best;
  if (r > 1) return Math.max(ALL_CLEAR_RATE_MIN, ALL_CLEAR_RATE_AT_BEST + (ALL_CLEAR_RATE_MIN - ALL_CLEAR_RATE_AT_BEST) * (r - 1) / OVER_BEST_SPAN);
  if (r >= NEAR_BEST) return ALL_CLEAR_RATE + (ALL_CLEAR_RATE_AT_BEST - ALL_CLEAR_RATE) * (r - NEAR_BEST) / (1 - NEAR_BEST);
  const recent = (skill.recent || []).slice(0, RECENT_GAMES);
  if (recent.length && recent.reduce((a, b) => a + b, 0) / recent.length < best * STRUGGLING) return ALL_CLEAR_RATE_MAX;
  return ALL_CLEAR_RATE;
}

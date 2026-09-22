// ===== 盤面定数 =====
// 列番号は「右端 = 列1」「左端 = 列8」。
// 配列 index は columnHeights[0] = 列1, columnHeights[7] = 列8 とする（仕様 21）。
// 画面上の x 座標(screenX) は 0 = 一番左 = 列8, 7 = 一番右 = 列1。
export const COLUMN_COUNT = 8;
export const ROW_COUNT = 10;          // グリッド縦マス数（床を含む）
export const GAME_OVER_HEIGHT = 9;    // 床底からの高さがこれを超えたらゲームオーバー
                                      // （全列が揃う基準高さ8 の1マス上）

// 列 index -> 固定床の高さ（床マス数）。列1が最も高く、列8が0。
export function floorHeight(colIndex) {
  return COLUMN_COUNT - 1 - colIndex;
}
// 列 index -> 発動に必要なブロック数（列番号と同じ）
export function requiredCount(colIndex) {
  return colIndex + 1;
}
// 画面 x <-> 列 index
export const screenXToColIndex = (x) => COLUMN_COUNT - 1 - x;
export const colIndexToScreenX = (i) => COLUMN_COUNT - 1 - i;

// ===== スコア定数（調整用） =====
export const SCORE_PER_GOAL = 100;
// chain 回数 -> 倍率（仮の値。あとから差し替えやすいよう配列で管理）
export const CHAIN_MULTIPLIERS = [1, 1, 1.5, 2, 3, 4, 6, 8, 10, 13, 16, 20];
export function chainMultiplier(chain) {
  return CHAIN_MULTIPLIERS[Math.min(chain, CHAIN_MULTIPLIERS.length - 1)];
}

// ===== アニメーション時間（ms・調整用） =====
export const ANIM = {
  drop: 110,       // 着地・重力
  step: 85,        // ベルトコンベア1コマぶん（下がる/右へ1つ）
  goal: 260,       // ゴール吸収
  push: 230,       // 各列へ下から押し上げ
  betweenChains: 140,
};

// ===== 盤面 =====
// 8×8 を対角線で切った三角形。列番号は「右端 = 列1」「左端 = 列8」。
// 列N は上端から N マスだけ使える（列1 = 1マス, 列8 = 8マス）。
//
// 座標系は2つ:
//   画面座標 (x, r) : x = 0(左端=列8)…7(右端=列1), r = 0(上端)…7(下端)
//   列座標 (colIndex, slot) : colIndex 0 = 列1 … 7 = 列8,
//                             slot 0 = その列の一番下のマス … N-1 = 一番上のマス
// columnHeights[0] = 列1 … columnHeights[7] = 列8 とする（仕様 21）。
export const SIZE = 8;

export const capacity = (colIndex) => colIndex + 1;          // 列の容量 = 列番号
export const screenXToColIndex = (x) => SIZE - 1 - x;
export const colIndexToScreenX = (i) => SIZE - 1 - i;
/** 画面座標が三角盤面の内側か */
export const isInside = (x, r) => x >= 0 && r >= 0 && x < SIZE && r < SIZE && x + r <= SIZE - 1;
/** 画面座標 -> 列座標 */
export function toColSlot(x, r) {
  const colIndex = screenXToColIndex(x);
  return { colIndex, slot: colIndex - r };                    // slot = (N-1) - r
}
/** 列座標 -> 画面座標 */
export function toScreen(colIndex, slot) {
  return { x: colIndexToScreenX(colIndex), r: colIndex - slot };
}
/** 横ライン r に含まれるマス数（r=0 は8マス, r=7 は1マス） */
export const rowLength = (r) => SIZE - r;

// ===== トレイ =====
export const TRAY_SIZE = 3;

// ===== スコア（調整用） =====
export const SCORE_PER_CELL_PLACED = 1;
export const SCORE_PER_COLUMN_GOAL = 100;   // 列発動でゴールへ入った1個
export const SCORE_PER_ROW_CELL = 40;       // 横ラインで消えた1個
// 連鎖回数 -> 倍率
export const CHAIN_MULTIPLIERS = [1, 1, 1.5, 2, 3, 4, 6, 8, 10, 13, 16, 20];
export const chainMultiplier = (chain) => CHAIN_MULTIPLIERS[Math.min(chain, CHAIN_MULTIPLIERS.length - 1)];
// 連続で何かを発動させた手数(streak) -> 倍率
export const streakMultiplier = (streak) => 1 + Math.min(streak - 1, 8) * 0.25;

// ===== アニメーション時間（ms・調整用） =====
export const ANIM = {
  place: 140,      // 置いた時のポップ
  sink: 150,       // 発動列が通路まで沈む
  step: 80,        // ベルトコンベア1コマ
  goal: 240,       // ゴール吸収
  push: 240,       // 各列へ下から押し上げ
  rowFlash: 160,   // 横ラインが光る
  rowFly: 320,     // 横ラインがゴールへ飛ぶ
  betweenChains: 120,
};

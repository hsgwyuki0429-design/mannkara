// ===== 盤面 =====
// 8×8 を対角線で切った三角形。画面座標 (x, r): x = 0(左端)…7(右端), r = 0(上端)…7(下端)。
// 盤面は x + r <= 7 のマス（左上が直角の三角形、斜辺は右下向き）。
//
// 「ライン」は2種類あり、対角線について完全に対称:
//   縦列N (kind 'col') : x = 8-N の列。N マス。右端が縦1(1マス)、左端が縦8(8マス)。
//   横列N (kind 'row') : r = 8-N の行。N マス。下端が横1(1マス)、上端が横8(8マス)。
// どちらも斜辺側の端を「下(slot 0)」とする。縦列は下端、横列は右端が slot 0。
// 縦列は下の通路を右へ、横列は右の通路を下へ流れ、右下の共通ゴールへ入る。
export const SIZE = 8;
export const KINDS = ['col', 'row'];

export const isInside = (x, r) => x >= 0 && r >= 0 && x < SIZE && r < SIZE && x + r <= SIZE - 1;

/** ライン(kind, n) のマスを slot 順（0 = 斜辺側の端）で返す */
export function lineCells(kind, n) {
  const cells = [];
  const fixed = SIZE - n;
  for (let k = 0; k < n; k++) {
    const along = n - 1 - k;
    cells.push(kind === 'col' ? { x: fixed, r: along } : { x: along, r: fixed });
  }
  return cells;
}
/** 画面座標 -> その座標を通る縦列/横列の番号 */
export const colNumberAt = (x) => SIZE - x;
export const rowNumberAt = (r) => SIZE - r;

/** 縦横で連鎖数が同じ時は縦を選ぶ（タイブレーク） */
export const KIND_PRIORITY = { col: 0, row: 1 };

// ===== トレイ =====
export const TRAY_SIZE = 3;
/** 手駒1つごとに「置けば発動が起きるテトロミノ」を選ぶ確率 */
export const CHAIN_PIECE_RATE = 0.1;
/** 新しいトレイが「順番と場所を選べば3つとも置ける」組み合わせになる確率（残りは1つ以上置けるだけ保証） */
export const SOLVABLE_TRAY_RATE = 0.9;
/** 条件を満たすトレイを探す抽選回数の上限 */
export const TRAY_RETRIES = 40;

// ===== スコア（調整用） =====
export const SCORE_PER_CELL_PLACED = 1;
export const SCORE_PER_GOAL = 100;          // ゴールへ入った1個
export const CHAIN_MULTIPLIERS = [1, 1, 1.5, 2, 3, 4, 6, 8, 10, 13, 16, 20];
export const chainMultiplier = (chain) => CHAIN_MULTIPLIERS[Math.min(chain, CHAIN_MULTIPLIERS.length - 1)];
export const streakMultiplier = (streak) => 1 + Math.min(streak - 1, 8) * 0.25;

// ===== アニメーション時間（ms・調整用） =====
export const ANIM = {
  step: 62,        // 1マスぶん動く時間（流れる・押し込むすべて共通）
  betweenChains: 90,
};
/** 連鎖が1つ進むごとに再生速度をこれだけ上げる（2連鎖目 1.2倍, 3連鎖目 1.4倍 …） */
export const CHAIN_SPEED_UP = 0.2;
export const CHAIN_SPEED_MAX = 2.6;

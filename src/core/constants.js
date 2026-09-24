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
/** 盤面のマス数（36） */
export const CELL_COUNT = (SIZE * (SIZE + 1)) / 2;
/**
 * 連鎖が終わった盤面に残せるブロックの最大数（28）。
 * 縦8本・横8本のどれも満杯ではない＝16本すべてに空きが要り、1つの空きは縦横1本ずつしか受け持てないので、
 * 空きは最低 8 マス。埋まり具合（Board.fillRate）はこれに対する割合で測る（36 マスに対する割合だと 78% が上限になる）。
 */
export const MAX_BLOCKS = CELL_COUNT - SIZE;

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
/** 手駒1つごとに「置けば発動が起きる形」を選ぶ確率 */
export const CHAIN_PIECE_RATE = 0.1;
/**
 * 新しいトレイの決め方（埋まり具合 = Board.fillRate = ブロック数 / 28）:
 *  - HARD_FILL 未満: 必ず「順番と場所を選べば3つとも置ける」（詰まない手順が1つ以上ある）組み合わせ
 *  - HARD_FILL 以上: HARD_SOLVABLE_RATE の確率で「うまい手順なら生き残れる」組み合わせ、残りは完全にランダム
 */
export const HARD_FILL = 0.8;              // ブロック 23 個以上
export const HARD_SOLVABLE_RATE = 0.5;
/**
 * 全消しのチャンス: 埋まり具合が ALL_CLEAR_FILL 以下（ブロック 5 個以下）のとき、ALL_CLEAR_RATE の確率で
 * 「ALL_CLEAR_PIECES 個（トレイ2回ぶん）置いたところで全消しできる」ように2回ぶんの手駒を計算して配る。
 * 手順が見つからなかったときは、次の補充でもう一度探す。
 */
export const ALL_CLEAR_FILL = 0.2;
export const ALL_CLEAR_RATE = 0.2;
export const ALL_CLEAR_PIECES = 6;
/** 全消しの手順探しにかける時間の上限（ms）。見つからなければ普通の手駒にする */
export const ALL_CLEAR_BUDGET_MS = 40;
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
  step: 34,        // 1マスぶん動く時間（流れる・押し込むすべて共通）
  betweenChains: 30,
};
/** 連鎖が1つ進むごとに再生速度をこれだけ掛けて上げる（2連鎖目 1.35倍, 3連鎖目 1.82倍 …） */
export const CHAIN_SPEED_GROWTH = 1.35;
export const CHAIN_SPEED_MAX = 6;
/** 1ターンぶんの連鎖の再生は、どんなに長くてもおよそこの時間に収める（超えそうなら全体を速める） */
export const TURN_PLAY_BUDGET = 1600;
/** 再生待ちのターンが溜まっている（再生中に次を置いた）ときは、さらにこの倍率で速める */
export const BACKLOG_SPEED = 1.8;

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
 * 手駒1つごとに「今の盤面の穴・くぼみにはまる形」を選ぶ確率（連鎖ピースに選ばれなかった枠で）。
 * ぴったり = 置くとまわりの空きに1つも接しない（Sim.fitOf の 'perfect'）。くぼみ = 空きに接するのが1辺だけ（'snug'）。
 * 穴を埋めたい気持ちに応えるための形で、ぴったりの方を FIT_PERFECT_WEIGHT 倍選びやすくする（大きい形ほど選びやすい）
 */
export const FIT_PIECE_RATE = 0.3;
export const FIT_PERFECT_WEIGHT = 8;
/** 穴にぴったり置いたときのボーナス（置いたマス1つあたり） */
export const SCORE_PER_PERFECT_FIT_CELL = 25;
/**
 * 新しいトレイの決め方（埋まり具合 f = Board.fillRate = ブロック数 / 28）:
 *  - 埋まり具合に関係なく、必ず「順番と場所を選べば3つとも置ける」＝詰まない置き方が1つ以上ある組み合わせ
 *  - 置き方の数（置き終えた盤面の種類。countWays）は埋まり具合に比例して桁で減らす:
 *    目標 = WAYS_MAX^(1 - f)（空 300 → 半分 17 → 8割 3 → 満杯 1）。候補をいくつか抽選し、目標に一番近いものを配る
 *  - 埋まり具合が TIGHT_MAX_FILL 未満（そんなに埋まっていない）でも、補充のたびに TIGHT_RATE の確率で
 *    「置き方が1〜2通りしかない」組み合わせ。大きい形で押し込むのではなく、1つずつなら TIGHT_MIN_SPOTS か所以上に
 *    置ける形だけで作る（1つずつなら置けるのに、3つとも置ける置き方はほとんど無い）。
 *    見つからなければ次の補充でもう一度探す。それ以上埋まっていると、ふつうの目標がもともと 1〜十数通り
 *  - 詰む組み合わせを配ってよいのは、埋まり具合が HARD_FILL 以上で、見つかった詰まない組み合わせが
 *    どれも置き方1通りだけ、かつその置き方だと置き終えた盤面が前に配った時の盤面と同じになる（ループする）ときだけ
 */
export const WAYS_MAX = 300;
/** 目標の何倍以内なら、その候補で決める */
export const WAYS_TOLERANCE = 2;
export const TIGHT_RATE = 0.1;
export const TIGHT_MAX_FILL = 0.6;         // ブロック 16 個まで
export const TIGHT_MIN_SPOTS = 4;
export const TIGHT_MAX_WAYS = 2;
/** 置き方の少ない組み合わせ探し: 1つずつ形を入れ替えて置き方を減らしていく。数えるのは TIGHT_CAP 通りまで */
export const TIGHT_CAP = 15;
export const TIGHT_BUDGET_MS = 20;
export const HARD_FILL = 0.8;              // ブロック 23 個以上
/** 候補の抽選の上限（数と時間） */
export const LINEUP_CANDIDATES = 40;
export const LINEUP_BUDGET_MS = 25;
/** 埋まり具合 f のときの置き方の数の目標 */
export const targetWays = (f) => Math.max(1, Math.round(Math.pow(WAYS_MAX, 1 - Math.min(1, Math.max(0, f)))));
/**
 * 全消しのチャンス: ブロックが残っている盤面（埋まり具合は問わない）で、補充のたびに ALL_CLEAR_RATE の確率で
 * 「ALL_CLEAR_PIECES のどれかの個数（3個ずつ配るので3の倍数）を、この順番・この場所に置くと最後の1個でちょうど全消し」の
 * 手順を今の盤面から計算し、3個ずつ配る。手順どおりの盤面にならなかったら、そこで計画はおしまい。
 * 手順が見つからなかったときは、次の補充でもう一度探す
 */
export const ALL_CLEAR_RATE = 0.2;
export const ALL_CLEAR_PIECES = [6, 9, 12];
/**
 * 盤面が空のとき（ゲーム開始・全消しの直後）は EMPTY_ALL_CLEAR_RATE の確率で、手順集（allclear-library.js）から
 * 「6個以上（主に9個）をこの順番・この場所に置くと、最後の1個でちょうど全消し」の手順を選び、3個ずつ配る。
 * 手順どおりの盤面になっていないと（違う置き方をしたら）そこで計画はおしまい（探し直さない）。
 * （空の盤面では上の計算はしない）
 */
export const EMPTY_ALL_CLEAR_RATE = 0.6;
/** 全消しの手順探しにかける時間の上限（ms）。見つからなければ普通の手駒にする */
export const ALL_CLEAR_BUDGET_MS = 40;
/** 条件を満たすトレイを探す抽選回数の上限 */
export const TRAY_RETRIES = 40;

// ===== スコア（調整用） =====
export const SCORE_PER_CELL_PLACED = 1;
export const SCORE_PER_GOAL = 100;          // ゴールへ入った1個
/** 連鎖倍率（index = 連鎖数）。2連鎖目から伸び、長い連鎖ほど大きく跳ねる */
export const CHAIN_MULTIPLIERS = [1, 1, 2, 3, 5, 8, 12, 16, 20, 25, 30, 40, 50];
export const chainMultiplier = (chain) => CHAIN_MULTIPLIERS[Math.min(chain, CHAIN_MULTIPLIERS.length - 1)];
/** 連続発動ターン(COMBO)倍率: 1ターン増えるごとに +0.5、COMBO 11 で最大 ×6 */
export const STREAK_STEP = 0.5;
export const STREAK_CAP = 10;
export const streakMultiplier = (streak) => 1 + Math.min(Math.max(0, streak - 1), STREAK_CAP) * STREAK_STEP;
/** 全消し（ALL CLEAR）のボーナス。そのターンの COMBO 倍率も掛ける */
export const ALL_CLEAR_BONUS = 5000;

// ===== アニメーション時間（ms・調整用） =====
export const ANIM = {
  step: 60,        // 1マスぶん動く時間（流れる・押し込むすべて共通）。ゆっくり動く分、動いている間の演出で見せる
  betweenChains: 70,
  charge: 150,     // 発動の直前にラインが光って溜める時間
};
/** 連鎖が進んでも再生は速くしない（どの連鎖も同じ速さでじっくり見せる） */
export const CHAIN_SPEED_GROWTH = 1;
export const CHAIN_SPEED_MAX = 1;
/** 1ターンぶんの連鎖の再生時間の上限（なし: 長い連鎖でもまとめて速めない） */
export const TURN_PLAY_BUDGET = Infinity;
/** 再生待ちのターンが溜まっている（再生中に次を置いた）ときは、さらにこの倍率で速める */
export const BACKLOG_SPEED = 1.8;

import { COLUMN_COUNT, ROW_COUNT, GAME_OVER_HEIGHT, floorHeight, requiredCount, screenXToColIndex } from './constants.js';

let nextBlockId = 1;
export function createBlock(color) {
  return { id: `b${nextBlockId++}`, color };
}

/**
 * 盤面。各列は下から積み上がるスタック。
 * columns[0] = 列1（右端）… columns[7] = 列8（左端）
 * columns[i][0] が列の一番下のブロック。
 */
export class Board {
  constructor() {
    this.columns = Array.from({ length: COLUMN_COUNT }, () => []);
  }

  static fromHeights(heights, color = 'debug') {
    // heights[0] = 列1 の個数 … heights[7] = 列8 の個数
    const b = new Board();
    heights.forEach((n, i) => {
      for (let k = 0; k < n; k++) b.columns[i].push(createBlock(color));
    });
    return b;
  }

  get heights() {
    return this.columns.map((c) => c.length);
  }
  height(colIndex) {
    return this.columns[colIndex].length;
  }
  /** 床底からの絶対高さ（床マス + ブロック） */
  stackTop(colIndex) {
    return floorHeight(colIndex) + this.columns[colIndex].length;
  }

  /** ちょうど必要数の列（列番号の配列, 昇順） */
  findExactColumns() {
    const out = [];
    for (let i = 0; i < COLUMN_COUNT; i++) {
      if (this.columns[i].length === requiredCount(i)) out.push(i + 1);
    }
    return out;
  }

  /** 通常配置：列の一番上に積む */
  pushTop(colIndex, block) {
    this.columns[colIndex].push(block);
  }
  /** マンカラ配布：列の一番下から押し込み、既存を1つ押し上げる */
  insertBottom(colIndex, block) {
    this.columns[colIndex].unshift(block);
  }
  takeAll(colIndex) {
    return this.columns[colIndex].splice(0, this.columns[colIndex].length);
  }

  isOverflow() {
    for (let i = 0; i < COLUMN_COUNT; i++) {
      if (this.stackTop(i) > GAME_OVER_HEIGHT) return true;
    }
    return false;
  }

  /** そのピース配置が合法か（積んだ結果が盤面の上端を超えないか） */
  canPlaceCells(cells) {
    const add = new Array(COLUMN_COUNT).fill(0);
    for (const c of cells) {
      if (c.x < 0 || c.x >= COLUMN_COUNT) return false;
      add[screenXToColIndex(c.x)]++;
    }
    for (let i = 0; i < COLUMN_COUNT; i++) {
      if (add[i] && this.stackTop(i) + add[i] > ROW_COUNT) return false;
    }
    return true;
  }

  /**
   * テトロミノ着地後：セルを分離し、各セルが真下へ落ちて積み上がる（仕様 6）。
   * cells: [{x, y, color}]  y は下ほど大きい想定（落下順の決定のみに使う）
   * 戻り値: [{block, colIndex, index}] 配置結果（描画用）
   */
  placeCells(cells) {
    const placed = [];
    const sorted = [...cells].sort((a, b) => b.y - a.y); // 下のセルから積む
    for (const c of sorted) {
      const colIndex = screenXToColIndex(c.x);
      const block = createBlock(c.color);
      this.pushTop(colIndex, block);
      placed.push({ block, colIndex, index: this.columns[colIndex].length - 1 });
    }
    return placed;
  }

  clone() {
    const b = new Board();
    b.columns = this.columns.map((c) => c.map((x) => ({ ...x })));
    return b;
  }

  /** デバッグ表示用 */
  debugLines() {
    return this.columns.map((c, i) => {
      const n = c.length;
      const req = requiredCount(i);
      const state = n === req ? ' READY' : n > req ? ' OVER' : '';
      return `Column ${i + 1}: ${n} / ${req}${state}`;
    });
  }
}

import { SIZE, capacity, isInside, toColSlot, toScreen, rowLength } from './constants.js';

let nextBlockId = 1;
export function createBlock(color) {
  return { id: `b${nextBlockId++}`, color };
}

/**
 * 三角形の盤面。重力なし（置いた場所にそのまま残る）。
 * columns[i] = 列(i+1) のスロット配列（長さ = 列番号）。slot 0 が一番下。空きは null。
 */
export class Board {
  constructor() {
    this.columns = Array.from({ length: SIZE }, (_, i) => new Array(capacity(i)).fill(null));
  }

  /** デバッグ用：各列を下から詰めて heights[i] 個置く（heights[0] = 列1） */
  static fromHeights(heights, color = 'debug') {
    const b = new Board();
    heights.forEach((n, i) => {
      for (let k = 0; k < Math.min(n, capacity(i)); k++) b.columns[i][k] = createBlock(color);
    });
    return b;
  }

  /* ---------- 参照 ---------- */
  get(x, r) {
    if (!isInside(x, r)) return undefined;
    const { colIndex, slot } = toColSlot(x, r);
    return this.columns[colIndex][slot];
  }
  set(x, r, block) {
    const { colIndex, slot } = toColSlot(x, r);
    this.columns[colIndex][slot] = block;
  }
  count(colIndex) {
    return this.columns[colIndex].filter(Boolean).length;
  }
  get heights() {
    return this.columns.map((_, i) => this.count(i));
  }
  totalBlocks() {
    return this.heights.reduce((a, b) => a + b, 0);
  }

  /* ---------- 配置 ---------- */
  canPlace(piece, ox, oy) {
    for (const c of piece.cells) {
      const x = ox + c.x, r = oy + c.y;
      if (!isInside(x, r) || this.get(x, r)) return false;
    }
    return true;
  }
  /** どこかに置けるか */
  fits(piece) {
    for (let oy = 0; oy < SIZE; oy++) {
      for (let ox = 0; ox < SIZE; ox++) if (this.canPlace(piece, ox, oy)) return true;
    }
    return false;
  }
  /** 置く（重力なし）。戻り値: [{block, x, r}] */
  place(piece, ox, oy) {
    const placed = [];
    for (const c of piece.cells) {
      const block = createBlock(piece.color);
      this.set(ox + c.x, oy + c.y, block);
      placed.push({ block, x: ox + c.x, r: oy + c.y });
    }
    return placed;
  }

  /* ---------- 判定 ---------- */
  /** 満杯の列（列番号, 昇順）。列N は N マスすべて埋まった時 = ちょうど N 個 */
  fullColumns() {
    const out = [];
    for (let i = 0; i < SIZE; i++) if (this.count(i) === capacity(i)) out.push(i + 1);
    return out;
  }
  /** 横ライン r のマス（画面座標） */
  rowCells(r) {
    const cells = [];
    for (let x = 0; x < rowLength(r); x++) cells.push({ x, r });
    return cells;
  }
  /** 満杯の横ライン（r の配列, 上から順） */
  fullRows() {
    const out = [];
    for (let r = 0; r < SIZE; r++) {
      if (this.rowCells(r).every(({ x }) => this.get(x, r))) out.push(r);
    }
    return out;
  }

  /* ---------- マンカラ用 ---------- */
  /** 列の全ブロックを取り出す（下から順） */
  takeColumn(colIndex) {
    const col = this.columns[colIndex];
    const blocks = col.filter(Boolean);
    col.fill(null);
    return blocks;
  }
  /**
   * 下から押し込む。一番下の空欄までのブロックだけを1マス押し上げ、空欄が1つ埋まる。
   * 空欄より上のブロックは動かない。空欄が無ければ false（押し込めない）。
   */
  insertBottom(colIndex, block) {
    const col = this.columns[colIndex];
    const hole = col.indexOf(null);
    if (hole < 0) return false;
    for (let k = hole; k > 0; k--) col[k] = col[k - 1];
    col[0] = block;
    return true;
  }
  /** 横ラインを消す。戻り値: [{block, x, r}] */
  clearRow(r) {
    const removed = [];
    for (const { x } of this.rowCells(r)) {
      const block = this.get(x, r);
      if (block) removed.push({ block, x, r });
      this.set(x, r, null);
    }
    return removed;
  }

  /** 全ブロックの画面座標（描画用） */
  *entries() {
    for (let i = 0; i < SIZE; i++) {
      for (let k = 0; k < this.columns[i].length; k++) {
        const block = this.columns[i][k];
        if (block) yield { block, ...toScreen(i, k) };
      }
    }
  }

  clone() {
    const b = new Board();
    b.columns = this.columns.map((c) => c.map((x) => (x ? { ...x } : null)));
    return b;
  }

  /** デバッグ表示用 */
  debugLines() {
    const cols = this.columns.map((c, i) => {
      const n = this.count(i);
      const pattern = c.map((v) => (v ? '■' : '□')).join('');
      return `Column ${i + 1}: ${n} / ${capacity(i)}${n === capacity(i) ? ' READY' : ''}  [${pattern}]`;
    });
    const rows = this.fullRows();
    if (rows.length) cols.push(`Full rows: ${rows.join(', ')}`);
    return cols;
  }
}

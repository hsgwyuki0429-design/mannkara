import { SIZE, isInside, lineCells, KINDS } from './constants.js?v=202609230548';

let nextBlockId = 1;
export function createBlock(color) {
  return { id: `b${nextBlockId++}`, color };
}

/**
 * 三角形の盤面。grid[r][x]。重力なし（置いた場所にそのまま残る）。
 * 縦列・横列はどちらも lineCells(kind, n) で slot 順に参照する。
 */
export class Board {
  constructor() {
    this.grid = Array.from({ length: SIZE }, () => new Array(SIZE).fill(null));
  }

  /** デバッグ用：各縦列を下から詰めて heights[i] 個置く（heights[0] = 縦1） */
  static fromHeights(heights, color = 'debug') {
    const b = new Board();
    heights.forEach((h, i) => {
      lineCells('col', i + 1).slice(0, h).forEach(({ x, r }) => b.set(x, r, createBlock(color)));
    });
    return b;
  }

  get(x, r) { return isInside(x, r) ? this.grid[r][x] : undefined; }
  set(x, r, block) { this.grid[r][x] = block; }

  /* ---------- ライン ---------- */
  line(kind, n) { return lineCells(kind, n).map(({ x, r }) => this.get(x, r)); }
  count(kind, n) { return this.line(kind, n).filter(Boolean).length; }
  isFull(kind, n) { return this.count(kind, n) === n; }
  /** 満杯のライン一覧 [{kind, n}] */
  fullLines() {
    const out = [];
    for (const kind of KINDS) for (let n = 1; n <= SIZE; n++) if (this.isFull(kind, n)) out.push({ kind, n });
    return out;
  }
  /** ラインの全ブロックを取り出す（slot 0 = 斜辺側から順） */
  takeLine(kind, n) {
    const blocks = [];
    for (const { x, r } of lineCells(kind, n)) {
      const b = this.get(x, r);
      if (b) blocks.push(b);
      this.set(x, r, null);
    }
    return blocks;
  }
  /**
   * 斜辺側の端から押し込む。
   *  - ラインが空なら、ブロックは一番奥まで進む
   *  - そうでなければ、一番近い空欄までのブロックだけが1マスずれ、空欄が1つ埋まる
   *    （それより奥のブロックは動かない）
   * 空欄が無ければ false。
   */
  insertBottom(kind, n, block) {
    const cells = lineCells(kind, n);
    if (cells.every(({ x, r }) => !this.get(x, r))) {
      const far = cells[cells.length - 1];
      this.set(far.x, far.r, block);
      return true;
    }
    const hole = cells.findIndex(({ x, r }) => !this.get(x, r));
    if (hole < 0) return false;
    for (let k = hole; k > 0; k--) this.set(cells[k].x, cells[k].r, this.get(cells[k - 1].x, cells[k - 1].r));
    this.set(cells[0].x, cells[0].r, block);
    return true;
  }

  /* ---------- 配置 ---------- */
  canPlace(piece, ox, oy) {
    return piece.cells.every((c) => {
      const x = ox + c.x, r = oy + c.y;
      return isInside(x, r) && !this.get(x, r);
    });
  }
  fits(piece) {
    for (let oy = 0; oy < SIZE; oy++) for (let ox = 0; ox < SIZE; ox++) if (this.canPlace(piece, ox, oy)) return true;
    return false;
  }
  place(piece, ox, oy) {
    return piece.cells.map((c) => {
      const block = createBlock(piece.color);
      this.set(ox + c.x, oy + c.y, block);
      return { block, x: ox + c.x, r: oy + c.y };
    });
  }

  /* ---------- 参照・デバッグ ---------- */
  get heights() { return Array.from({ length: SIZE }, (_, i) => this.count('col', i + 1)); }
  totalBlocks() {
    let n = 0;
    for (const { block } of this.entries()) if (block) n++;
    return n;
  }
  *entries() {
    for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
      const block = this.get(x, r);
      if (block) yield { block, x, r };
    }
  }
  /** 全ブロックの位置 Map<id, {x, r}>（描画の再生用スナップショット） */
  snapshot() {
    const m = new Map();
    for (const { block, x, r } of this.entries()) m.set(block.id, { x, r, color: block.color });
    return m;
  }

  clone() {
    const b = new Board();
    b.grid = this.grid.map((row) => row.map((v) => (v ? { ...v } : null)));
    return b;
  }
  debugLines() {
    const fmt = (kind, label) => Array.from({ length: SIZE }, (_, i) => {
      const n = i + 1, c = this.count(kind, n);
      const pat = this.line(kind, n).map((v) => (v ? '■' : '□')).join('');
      return `${label}${n}: ${c}/${n}${c === n ? ' READY' : ''}  [${pat}]`;
    });
    return [...fmt('col', '縦'), ...fmt('row', '横')];
  }
}

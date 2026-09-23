// ブロックブラスト式：回転なし・向き固定の形をそのまま置く。
// cells は [x, y]（y は下方向が正）。weight は出現しやすさ。
const S = (name, weight, rows) => {
  const cells = [];
  rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  return { name, weight, cells };
};

export const SHAPES = [
  S('1', 3, ['#']),
  S('2h', 3, ['##']),
  S('2v', 3, ['#', '#']),
  S('3h', 2, ['###']),
  S('3v', 2, ['#', '#', '#']),
  S('c1', 1.5, ['##', '#.']),
  S('c2', 1.5, ['##', '.#']),
  S('c3', 1.5, ['#.', '##']),
  S('c4', 1.5, ['.#', '##']),
  S('d1', 1, ['#.', '.#']),
  S('d2', 1, ['.#', '#.']),
  S('O', 1.5, ['##', '##']),
  S('4h', 1, ['####']),
  S('4v', 1, ['#', '#', '#', '#']),
  S('T1', 0.6, ['###', '.#.']),
  S('T2', 0.6, ['.#.', '###']),
  S('T3', 0.6, ['#.', '##', '#.']),
  S('T4', 0.6, ['.#', '##', '.#']),
  S('S1', 0.5, ['.##', '##.']),
  S('Z1', 0.5, ['##.', '.##']),
  S('S2', 0.5, ['#.', '##', '.#']),
  S('Z2', 0.5, ['.#', '##', '#.']),
  S('L1', 0.5, ['#.', '#.', '##']),
  S('J1', 0.5, ['.#', '.#', '##']),
  S('L2', 0.5, ['###', '#..']),
  S('J2', 0.5, ['###', '..#']),
  S('L3', 0.5, ['##', '.#', '.#']),
  S('J3', 0.5, ['##', '#.', '#.']),
  S('L4', 0.5, ['..#', '###']),
  S('J4', 0.5, ['#..', '###']),
  S('5h', 0.4, ['#####']),
  S('5v', 0.4, ['#', '#', '#', '#', '#']),
  S('V1', 0.3, ['###', '#..', '#..']),
  S('V2', 0.3, ['###', '..#', '..#']),
];
export const SHAPE_BY_NAME = Object.fromEntries(SHAPES.map((s) => [s.name, s]));
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];

export class Piece {
  constructor(name, color) {
    this.name = name;
    this.color = color ?? COLORS[0];
    this.cells = SHAPE_BY_NAME[name].cells.map(([x, y]) => ({ x, y }));
    this.width = Math.max(...this.cells.map((c) => c.x)) + 1;
    this.height = Math.max(...this.cells.map((c) => c.y)) + 1;
  }
  get size() { return this.cells.length; }
}

/** 手駒生成（独立。重みや袋方式へ差し替えやすい） */
export class PieceGenerator {
  constructor(random = Math.random, shapes = SHAPES) {
    this.random = random;
    this.shapes = shapes;
    this.total = shapes.reduce((a, s) => a + s.weight, 0);
  }
  next() {
    let t = this.random() * this.total;
    let shape = this.shapes[this.shapes.length - 1];
    for (const s of this.shapes) { if ((t -= s.weight) < 0) { shape = s; break; } }
    const color = COLORS[Math.floor(this.random() * COLORS.length)];
    return new Piece(shape.name, color);
  }
  /** トレイ3枠を新しく作る */
  spawnTray(count) {
    return Array.from({ length: count }, () => this.next());
  }
}

// ブロックブラスト式：回転なし・向き固定の形をそのまま置く。
// cells は [x, y]（y は下方向が正）。weight は出現しやすさ。
const S = (name, weight, rows) => {
  const cells = [];
  rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  return { name, weight, cells };
};

// テトロミノ7種の全向き（回転操作は無いので、向きごとに別の手駒として扱う）。
// 種類ごとの出現率が等しくなるよう、weight = 1 / その種類の向きの数。
const T = (type, list) => list.map((rows, i) => ({ ...S(`${type}${i}`, 1 / list.length, rows), type }));
export const SHAPES = [
  ...T('I', [['####'], ['#', '#', '#', '#']]),
  ...T('O', [['##', '##']]),
  ...T('T', [['###', '.#.'], ['#.', '##', '#.'], ['.#.', '###'], ['.#', '##', '.#']]),
  ...T('S', [['.##', '##.'], ['#.', '##', '.#']]),
  ...T('Z', [['##.', '.##'], ['.#', '##', '#.']]),
  ...T('J', [['#..', '###'], ['##', '#.', '#.'], ['###', '..#'], ['.#', '.#', '##']]),
  ...T('L', [['..#', '###'], ['#.', '#.', '##'], ['###', '#..'], ['##', '.#', '.#']]),
];
// 種類ごとの色（テトリス準拠）
export const TYPE_COLORS = { I: 'cyan', O: 'yellow', T: 'purple', S: 'green', Z: 'red', J: 'blue', L: 'orange' };
export const SHAPE_BY_NAME = Object.fromEntries(SHAPES.map((s) => [s.name, s]));
export const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];

export class Piece {
  constructor(name, color) {
    this.name = name;
    this.type = SHAPE_BY_NAME[name].type;
    this.color = color ?? TYPE_COLORS[this.type] ?? COLORS[0];
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
    return new Piece(shape.name);
  }
  /** 候補の中から重み付きで1つ選ぶ（連鎖ピース用） */
  pick(list) {
    const total = list.reduce((a, x) => a + x.weight, 0);
    let t = this.random() * total;
    for (const x of list) if ((t -= x.weight) < 0) return x;
    return list[list.length - 1];
  }
  /** トレイ3枠を新しく作る */
  spawnTray(count) {
    return Array.from({ length: count }, () => this.next());
  }
}

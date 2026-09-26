// ブロックブラスト式：回転なし・向き固定の形をそのまま置く。
// cells は [x, y]（y は下方向が正）。weight は出現しやすさ。
const S = (name, weight, rows) => {
  const cells = [];
  rows.forEach((line, y) => [...line].forEach((ch, x) => { if (ch === '#') cells.push([x, y]); }));
  return { name, weight, cells };
};

// 形の種類ごとの全向き（回転操作は無いので、向きごとに別の手駒として扱う）。
// 種類の出現率が typeWeight どおりになるよう、weight = typeWeight / その種類の向きの数。
const T = (type, typeWeight, list) => list.map((rows, i) => ({ ...S(`${type}${i}`, typeWeight / list.length, rows), type }));
export const SHAPES = [
  // テトロミノ7種
  ...T('I', 1, [['####'], ['#', '#', '#', '#']]),
  ...T('O', 1, [['##', '##']]),
  ...T('T', 1, [['###', '.#.'], ['#.', '##', '#.'], ['.#.', '###'], ['.#', '##', '.#']]),
  ...T('S', 1, [['.##', '##.'], ['#.', '##', '.#']]),
  ...T('Z', 1, [['##.', '.##'], ['.#', '##', '#.']]),
  ...T('J', 1, [['#..', '###'], ['##', '#.', '#.'], ['###', '..#'], ['.#', '.#', '##']]),
  ...T('L', 1, [['..#', '###'], ['#.', '#.', '##'], ['###', '#..'], ['##', '.#', '.#']]),
  // ブロックブラストの形: 1マス・直線(2/3/5)・3×3・2×3・小さいL(3マス)・大きいL(5マス)
  ...T('Dot', 0.5, [['#']]),
  ...T('I2', 1, [['##'], ['#', '#']]),
  ...T('I3', 1, [['###'], ['#', '#', '#']]),
  ...T('I5', 0.8, [['#####'], ['#', '#', '#', '#', '#']]),
  ...T('O3', 0.6, [['###', '###', '###']]),
  ...T('R', 0.8, [['###', '###'], ['##', '##', '##']]),
  ...T('V3', 1, [['##', '#.'], ['##', '.#'], ['.#', '##'], ['#.', '##']]),
  ...T('V5', 0.8, [['###', '#..', '#..'], ['###', '..#', '..#'], ['..#', '..#', '###'], ['#..', '#..', '###']]),
  // 三角の盤面に合わせた形
  // 斜め点線: どのマスも別の縦・横に入るので、少ないマスで何本ものラインの最後の1マスを埋められる（強いので少なめ）
  ...T('D2', 0.3, [['#.', '.#']]),
  ...T('D3', 0.25, [['#..', '.#.', '..#']]),
  // 逆斜め: 斜辺（階段）と平行。いくつものラインの斜辺側の端（配られたブロックが入る所）をまとめて埋める
  ...T('A2', 0.3, [['.#', '#.']]),
  ...T('A3', 0.25, [['..#', '.#.', '#..']]),
  // 階段ヘビ（W 型 5マス）: 斜辺のでこぼこを埋める
  ...T('W', 0.6, [['#..', '##.', '.##'], ['..#', '.##', '##.'], ['##.', '.##', '..#'], ['.##', '##.', '#..']]),
  // 十字（5マス）: 縦3本・横3本に同時に入る
  ...T('X', 0.5, [['.#.', '###', '.#.']]),
];
/** 種類ごとの出現しやすさ（向きの weight の合計） */
export const TYPE_WEIGHTS = SHAPES.reduce((m, s) => ({ ...m, [s.type]: (m[s.type] ?? 0) + s.weight }), {});
// 種類ごとの色（テトロミノはテトリス準拠、ほかは近い形と被らないように）
export const TYPE_COLORS = {
  I: 'cyan', O: 'yellow', T: 'purple', S: 'green', Z: 'red', J: 'blue', L: 'orange',
  Dot: 'purple', I2: 'green', I3: 'orange', I5: 'red', O3: 'blue', R: 'cyan', V3: 'yellow', V5: 'red',
  D2: 'cyan', D3: 'blue', A2: 'green', A3: 'orange', W: 'purple', X: 'yellow',
};
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

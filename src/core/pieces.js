// テトロミノ定義。cells は [x, y]（y は下方向が正）。回転状態を4つ持つ。
export const TETROMINOES = {
  I: { color: 'i', rotations: [
    [[0,1],[1,1],[2,1],[3,1]], [[2,0],[2,1],[2,2],[2,3]],
    [[0,2],[1,2],[2,2],[3,2]], [[1,0],[1,1],[1,2],[1,3]] ] },
  O: { color: 'o', rotations: [ [[0,0],[1,0],[0,1],[1,1]] ] },
  T: { color: 't', rotations: [
    [[1,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[2,1],[1,2]],
    [[0,1],[1,1],[2,1],[1,2]], [[1,0],[0,1],[1,1],[1,2]] ] },
  S: { color: 's', rotations: [
    [[1,0],[2,0],[0,1],[1,1]], [[1,0],[1,1],[2,1],[2,2]],
    [[1,1],[2,1],[0,2],[1,2]], [[0,0],[0,1],[1,1],[1,2]] ] },
  Z: { color: 'z', rotations: [
    [[0,0],[1,0],[1,1],[2,1]], [[2,0],[1,1],[2,1],[1,2]],
    [[0,1],[1,1],[1,2],[2,2]], [[1,0],[0,1],[1,1],[0,2]] ] },
  J: { color: 'j', rotations: [
    [[0,0],[0,1],[1,1],[2,1]], [[1,0],[2,0],[1,1],[1,2]],
    [[0,1],[1,1],[2,1],[2,2]], [[1,0],[1,1],[0,2],[1,2]] ] },
  L: { color: 'l', rotations: [
    [[2,0],[0,1],[1,1],[2,1]], [[1,0],[1,1],[1,2],[2,2]],
    [[0,1],[1,1],[2,1],[0,2]], [[0,0],[1,0],[1,1],[1,2]] ] },
};
export const PIECE_TYPES = Object.keys(TETROMINOES);

export class Piece {
  constructor(type, rotation = 0) {
    this.type = type;
    this.rotation = rotation % TETROMINOES[type].rotations.length;
  }
  get color() { return TETROMINOES[this.type].color; }
  get cells() {
    const r = TETROMINOES[this.type].rotations[this.rotation];
    return r.map(([x, y]) => ({ x, y }));
  }
  rotated(dir = 1) {
    const n = TETROMINOES[this.type].rotations.length;
    return new Piece(this.type, (this.rotation + dir + n) % n);
  }
  /** 正規化した幅と、左端が0になるようオフセットしたセル */
  normalizedCells() {
    const cs = this.cells;
    const minX = Math.min(...cs.map((c) => c.x));
    const minY = Math.min(...cs.map((c) => c.y));
    return cs.map((c) => ({ x: c.x - minX, y: c.y - minY }));
  }
  get width() {
    const cs = this.normalizedCells();
    return Math.max(...cs.map((c) => c.x)) + 1;
  }
  /** 盤面 x 位置(左端)に置いたときの絶対セル */
  cellsAt(originX) {
    return this.normalizedCells().map((c) => ({ x: originX + c.x, y: c.y, color: this.color }));
  }
}

/** 候補生成ロジック（独立させてある。7-bag等に差し替えやすい） */
export class PieceGenerator {
  constructor(random = Math.random) { this.random = random; }
  next() {
    const t = PIECE_TYPES[Math.floor(this.random() * PIECE_TYPES.length)];
    return new Piece(t, 0);
  }
  /** 常に3つの候補を保つ */
  spawnCandidates(current = [], count = 3) {
    const out = current.slice();
    while (out.length < count) out.push(this.next());
    return out;
  }
}

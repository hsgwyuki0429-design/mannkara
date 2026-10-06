import { colorOf } from './palette.js?v=202610062316';

/**
 * ゴールから飛び散る宝石のかけら。
 * かけらの塗りを CSS のグラデーション（ブロックと同じ数枚重ね）で作ると、かけらを出すたびに描き直しになって重い。
 * そこで、色ごとに1回だけ描いた小さな絵を、盤面の演出用の canvas（fx2d.js。何も描いていない間は画面から外す）に貼って動かす。
 * かけらを 1 つずつ要素にして動かすと、動いている数だけ毎フレームの仕事が増えるので使わない（ブロックを動かす requestAnimationFrame が回っている間は特に）。
 *
 * かけらの見た目は盤面のブロックと同じ: ひし形の4つのふちの面（光源は左上）とテーブル面。
 * 光の向きがそろうよう、かけらは回さない。薄くすると背景の青と混ざって濁るので、消えるときは小さくなるだけ。
 */
const MAX = 14;
const SPRITE = 64;

/** '#rrggbb' を t の割合で b に寄せる */
function mix(a, b, t) {
  const p = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [p(a), p(b)];
  return `rgb(${x.map((v, i) => Math.round(v + (y[i] - v) * t)).join(',')})`;
}

const SPRITES = new Map();
/** 3D の盤面の間は、かけらもガラスの立方体の絵（cube3d.js の sprites）にする。null で宝石の絵に戻す */
let override = null;
export function useSprites(map) { override = map; }
/**
 * 色ごとの宝石のかけらの絵（styles.css の .block と同じ塗り分け。画面の左上から光が当たる）。
 * 盤面の演出（Shards）と画面全体の演出（scenes.js の紙吹雪）で同じ絵を使い、作画をそろえる
 */
export function gemSprite(name) {
  if (override?.has(name)) return override.get(name);
  let img = SPRITES.get(name);
  if (img) return img;
  const c = colorOf(name), S = SPRITE, h = S / 2, k = S * 0.2;     // k = テーブル面までの距離
  img = document.createElement('canvas');
  img.width = img.height = S;
  const g = img.getContext('2d');
  // 盤面のブロックと同じく、右下へ小さな影を落とす（影の分だけ、宝石は少し内側に描く）
  g.translate(h, h); g.scale(0.88, 0.88); g.translate(-h * 1.03, -h * 1.03);
  const T = [h, 0], R = [S, h], B = [h, S], L = [0, h];            // ひし形の頂点（上・右・下・左）
  const t = [h, k], r = [S - k, h], b = [h, S - k], l = [k, h];    // テーブル面の頂点
  const face = (pts, fill) => { g.fillStyle = fill; g.beginPath(); pts.forEach(([px, py], i) => (i ? g.lineTo(px, py) : g.moveTo(px, py))); g.closePath(); g.fill(); };
  g.shadowColor = 'rgba(4,14,64,.38)'; g.shadowBlur = S * 0.05; g.shadowOffsetX = g.shadowOffsetY = S * 0.028;
  face([T, R, B, L], c.lo);
  g.shadowColor = 'transparent';
  face([L, T, t, l], mix(c.col, '#fffbe8', 0.48));                 // 左上の面: 光を正面から受ける
  face([T, R, r, t], mix(c.col, '#ffffff', 0.16));                 // 右上の面
  face([B, L, l, b], mix(c.col, c.lo, 0.62));                      // 左下の面: 影側
  face([R, B, b, r], mix(c.lo, '#160b48', 0.1));                   // 右下の面: 一番暗い
  const grd = g.createLinearGradient(k, k, S - k, S - k);          // テーブル面: 左上ほど明るい
  grd.addColorStop(0, mix(c.col, '#fff8e0', 0.14)); grd.addColorStop(0.45, c.col); grd.addColorStop(1, mix(c.col, c.lo, 0.34));
  face([t, r, b, l], grd);
  g.fillStyle = 'rgba(255,255,255,.9)';                            // 左上のふちの小さな映り込み
  g.beginPath(); g.arc(S * 0.3, S * 0.36, S * 0.045, 0, Math.PI * 2); g.fill();
  SPRITES.set(name, img);
  return img;
}

/**
 * かけらの位置と大きさ（経過 t 秒 / 全体の長さ T 秒 / 初速 vx, vy px/秒 / 重力 g px/秒²）。放物線で飛び、後半 45% で小さくなって消える
 */
export function shardPose(t, T, vx, vy, g) {
  const u = t / T;
  return { dx: vx * t, dy: vy * t + 0.5 * g * t * t, scale: u < 0.55 ? 1 : Math.max(0, 1 - (u - 0.55) / 0.45) };
}

export class Shards {
  /** fx = 盤面の小さな演出を描く canvas（fx2d.js の FxCanvas） */
  constructor(fx) {
    this.fx = fx;
    this.n = 0;                       // 出ているかけらの数
  }

  clear() {
    this.fx.drop(this);
    this.n = 0;
  }

  get count() { return this.n; }

  /**
   * (x, y) から色 colors[i] のかけらを n 個、上向きの扇形に散らす。size = かけらの対角線の長さ px, speed = 初速 px/秒。
   * spread = 扇の開き（ラジアン）、cap = 同時に出していてよい数（全消しのような見せ場だけ増やす）
   */
  burst(x, y, colors, n, size, speed, { spread = 2.4, cap = MAX, life = 0.72 } = {}) {
    n = Math.min(n, cap - this.n);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + ((i + 0.5) / n - 0.5) * spread + (Math.random() - 0.5) * 0.4;
      const v = speed * (1 + Math.random() * 0.55), vx = Math.cos(a) * v, vy = Math.sin(a) * v, g = speed * 3;
      const T = life + Math.random() * 0.14, sz = size * (0.8 + Math.random() * 0.45);
      const img = gemSprite(colors[i % colors.length]), start = this.fx.now();
      this.n++;
      this.fx.add({
        owner: this, start, end: start + T * 1000, done: () => { this.n--; },
        draw: (g2, now) => {
          const p = shardPose((now - start) / 1000, T, vx, vy, g), d = sz * p.scale;
          if (d < 0.5) return;
          g2.drawImage(img, x + p.dx - d / 2, y + p.dy - d / 2, d, d);
        },
      });
    }
  }

  /** 7色ぶんの絵を先に作っておくための仕事（1色ずつ） */
  warmJobs() { return ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'].map((name) => () => gemSprite(name)); }
}

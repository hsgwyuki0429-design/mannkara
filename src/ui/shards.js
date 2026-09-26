import { colorOf } from './palette.js?v=202609261436';

/**
 * ゴールから飛び散る宝石のかけら。
 * かけらの塗りを CSS のグラデーション（ブロックと同じ数枚重ね）で作ると、かけらを出すたびに描き直しになって重い。
 * 盤面を覆う大きな canvas に描くのも、それだけで重ね合わせが重くなる（空でも）。
 * そこで、色ごとに1回だけ描いた小さな絵をかけら（小さな要素）の背景に貼り、transform だけで動かす。
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
/**
 * 色ごとの宝石のかけらの絵（styles.css の .block と同じ塗り分け。画面の左上から光が当たる）。
 * 盤面の演出（Shards）と画面全体の演出（scenes.js の紙吹雪）で同じ絵を使い、作画をそろえる
 */
export function gemSprite(name) {
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

export class Shards {
  constructor(parent) {
    this.parent = parent;
    this.sprites = new Map();         // 色 → かけらの絵の CSS クラス名
    this.alive = new Set();
  }

  clear() {
    for (const d of this.alive) d.remove();
    this.alive.clear();
  }

  get count() { return this.alive.size; }

  /**
   * (x, y) から色 colors[i] のかけらを n 個、上向きの扇形に散らす。size = かけらの対角線の長さ px, speed = 初速 px/秒。
   * spread = 扇の開き（ラジアン）、cap = 同時に出していてよい数（全消しのような見せ場だけ増やす）
   */
  burst(x, y, colors, n, size, speed, { spread = 2.4, cap = MAX } = {}) {
    n = Math.min(n, cap - this.alive.size);
    for (let i = 0; i < n; i++) {
      const a = -Math.PI / 2 + ((i + 0.5) / n - 0.5) * spread + (Math.random() - 0.5) * 0.4;
      const v = speed * (1 + Math.random() * 0.55), vx = Math.cos(a) * v, vy = Math.sin(a) * v, g = speed * 3;
      const T = 0.72 + Math.random() * 0.22, sz = size * (0.8 + Math.random() * 0.45);
      const d = document.createElement('div');
      d.className = 'shard ' + this.cls(colors[i % colors.length]);
      d.style.cssText = `width:${sz}px;height:${sz}px`;
      this.parent.appendChild(d);
      this.alive.add(d);
      const frames = [];
      for (let k = 0; k <= 8; k++) {
        const t = (T * k) / 8, u = k / 8;
        frames.push({ transform: `translate(${x - sz / 2 + vx * t}px,${y - sz / 2 + vy * t + 0.5 * g * t * t}px) scale(${u < 0.55 ? 1 : 1 - (u - 0.55) / 0.45})` });
      }
      d.animate(frames, { duration: T * 1000, easing: 'linear' }).onfinish = () => { d.remove(); this.alive.delete(d); };
    }
  }

  /** 7色ぶんの絵とクラスを先に作っておくための仕事（1色ずつ） */
  warmJobs() { return ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'].map((name) => () => this.cls(name)); }

  /**
   * 色ごとのかけらの絵を背景にする CSS クラス名。絵（data URL）は色ごとに1回だけスタイルシートに書く
   * （かけら1個ずつの style に長い data URL を書くと、出すたびにその文字列の読み取りと画像の照合が走る）
   */
  cls(name) {
    let c = this.sprites.get(name);
    if (!c) {
      c = 'shard-' + name;
      if (!this.sheet) { this.sheet = document.createElement('style'); document.head.appendChild(this.sheet); }
      this.sheet.appendChild(document.createTextNode(`.shard.${c}{background-image:url(${gemSprite(name).toDataURL()})}\n`));
      this.sprites.set(name, c);
    }
    return c;
  }
}

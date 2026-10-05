import { colorOf } from './palette.js?v=202610051052';
import { easeOut } from './fx2d.js?v=202610051052';

/**
 * キラキラ（四方にとがった星）。ラインが満杯になったときの枠のまたたきと、ブロックが通り過ぎた跡に残る光で使う。
 * ぼんやり丸く光るのではなく、先のとがった星と小さな斜めの星を重ねた、くっきりした形（ふち取りだけ、ごく小さな光のにじみ）。
 *
 * 星の絵は色ごとに 1 回だけ描いた小さな絵（shards.js と同じ方式）を、盤面の演出用の canvas（fx2d.js）に拡大・回転して貼る。
 * 薄くはせず、小さくなって消える。星を 1 つずつ要素にして動かすと、動いている星の数だけ毎フレームの仕事が増えるので使わない。
 */
const SPRITE = 64;
const MAX = 36;                                           // 同時に出していてよい星の数

/** '#rrggbb' → [r, g, b] */
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const mixRgb = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));

const SPRITES = new Map();
/**
 * 星の絵（64px）。name = 'white'（暖かい白）か、ブロックの色名（その色の明るい面で縁どった白い星）。
 * 大きな四方の星 + 小さな斜めの星 + 中心の白い点 + ごく小さな光のにじみ
 */
export function sparkSprite(name) {
  let img = SPRITES.get(name);
  if (img) return img;
  const S = SPRITE, c = S / 2;
  const tint = name === 'white' ? [255, 226, 150] : rgb(colorOf(name).hi);
  const edge = mixRgb(tint, [255, 255, 255], 0.2), body = mixRgb(tint, [255, 255, 255], 0.78);
  img = document.createElement('canvas');
  img.width = img.height = S;
  const g = img.getContext('2d');
  const css = (a, al = 1) => `rgba(${a[0]},${a[1]},${a[2]},${al})`;
  // 光のにじみ（星の根元だけ。大きくぼかさない）
  const halo = g.createRadialGradient(c, c, 0, c, c, S * 0.27);
  halo.addColorStop(0, css(tint, 0.5)); halo.addColorStop(1, css(tint, 0));
  g.fillStyle = halo; g.fillRect(0, 0, S, S);
  // 四方の星: 先は細く、側面はなだらかにへこむ。k = 根元の太さ
  const star = (R, k, rot, fill) => {
    g.save(); g.translate(c, c); g.rotate(rot);
    g.beginPath(); g.moveTo(0, -R);
    g.quadraticCurveTo(k, -k, R, 0); g.quadraticCurveTo(k, k, 0, R); g.quadraticCurveTo(-k, k, -R, 0); g.quadraticCurveTo(-k, -k, 0, -R);
    g.closePath(); g.fillStyle = fill; g.fill(); g.restore();
  };
  const big = g.createRadialGradient(c, c, 0, c, c, c);
  big.addColorStop(0, css([255, 255, 255])); big.addColorStop(0.3, css(body)); big.addColorStop(1, css(edge, 0.95));
  star(c - 2, 4.6, 0, big);
  star(c * 0.56, 2.6, Math.PI / 4, css(body, 0.85));       // 小さな斜めの星
  g.fillStyle = '#fff';                                     // 中心
  g.beginPath(); g.arc(c, c, 3.1, 0, Math.PI * 2); g.fill();
  SPRITES.set(name, img);
  return img;
}

/**
 * 星の動き（進み具合 k = 0..1 → 大きさ・回転°・上への移動 px）。大きさ 0 からぽんと開いて（1.15）、少し回りながら小さくなって（0.85）消える。
 * 全体の緩急は ease-out で、4 つの区切り（0 / 0.3 / 0.6 / 1）の間は直線でつなぐ
 */
export function sparkPose(k, spin, rise) {
  const p = easeOut(Math.min(1, Math.max(0, k)));
  const seg = (a, b, c, d) => (p < 0.3 ? a + (b - a) * (p / 0.3) : p < 0.6 ? b + (c - b) * ((p - 0.3) / 0.3) : c + (d - c) * ((p - 0.6) / 0.4));
  return { scale: seg(0, 1.15, 0.85, 0), rot: seg(0, spin * 0.45, spin * 0.8, spin), dy: seg(0, -rise * 0.4, -rise * 0.75, -rise) };
}

export class Sparkles {
  /** fx = 盤面の小さな演出を描く canvas（fx2d.js の FxCanvas） */
  constructor(fx) {
    this.fx = fx;
    this.n = 0;                       // 出ている星の数
  }

  clear() {
    this.fx.drop(this);
    this.n = 0;
  }

  get count() { return this.n; }

  /**
   * (x, y) に星を 1 つ。size = 対角線の長さ px / life = 出ている長さ ms / delay = 何 ms 後か / color = 'white' か色名 /
   * rise = 上へ流れる距離 px / spin = 回る角度°。ぽんと開いて（大きさ 0 → 1.15）、少し回りながら小さくなって消える。
   * 出しすぎないよう、同時に MAX 個まで（超えたら出さない）
   */
  twinkle(x, y, { color = 'white', size = 14, life = 440, delay = 0, rise = 6, spin = 50 } = {}) {
    if (this.n >= MAX) return false;
    const img = sparkSprite(color), dir = Math.random() < 0.5 ? -1 : 1, start = this.fx.now() + delay;
    this.n++;
    this.fx.add({
      owner: this, start, end: start + life, done: () => { this.n--; },
      draw: (g, now) => {
        const p = sparkPose((now - start) / life, dir * spin, rise), d = size * p.scale;
        if (d < 0.5) return;
        g.translate(x, y + p.dy);
        g.rotate((p.rot * Math.PI) / 180);
        g.drawImage(img, -d / 2, -d / 2, d, d);
      },
    });
    return true;
  }

  /** 星の絵を先に作っておくための仕事（白 + 7色。起動後の空き時間に 1 つずつ） */
  warmJobs() { return ['white', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'].map((name) => () => sparkSprite(name)); }
}

import { colorOf } from './palette.js?v=202610021033';

/**
 * キラキラ（四方にとがった星）。ラインが満杯になったときの枠のまたたきと、ブロックが通り過ぎた跡に残る光で使う。
 * ぼんやり丸く光るのではなく、先のとがった星と小さな斜めの星を重ねた、くっきりした形（ふち取りだけ、ごく小さな光のにじみ）。
 *
 * 星の塗りは CSS のグラデーションで毎回描くと重いので、色ごとに 1 回だけ描いた小さな絵（shards.js と同じ方式）を
 * 要素の背景に貼り、scale・rotate・translate だけで動かす。薄くはせず、小さくなって消える。
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

export class Sparkles {
  constructor(parent) {
    this.parent = parent;
    this.classes = new Map();         // 色 → 星の絵の CSS クラス名
    this.alive = new Set();
  }

  clear() {
    for (const d of this.alive) d.remove();
    this.alive.clear();
  }

  get count() { return this.alive.size; }

  /**
   * (x, y) に星を 1 つ。size = 対角線の長さ px / life = 出ている長さ ms / delay = 何 ms 後か / color = 'white' か色名 /
   * rise = 上へ流れる距離 px / spin = 回る角度°。ぽんと開いて（大きさ 0 → 1.15）、少し回りながら小さくなって消える。
   * 出しすぎないよう、同時に MAX 個まで（超えたら出さない）
   */
  twinkle(x, y, { color = 'white', size = 14, life = 440, delay = 0, rise = 6, spin = 50 } = {}) {
    if (this.alive.size >= MAX) return false;
    const d = document.createElement('div');
    d.className = 'spark ' + this.cls(color);
    d.style.cssText = `width:${size}px;height:${size}px;transform:translate(${x - size / 2}px,${y - size / 2}px)`;
    this.parent.appendChild(d);
    this.alive.add(d);
    const dir = Math.random() < 0.5 ? -1 : 1;
    d.animate([
      { scale: '0', rotate: '0deg', translate: '0 0' },
      { scale: '1.15', rotate: `${dir * spin * 0.45}deg`, translate: `0 ${-rise * 0.4}px`, offset: 0.3 },
      { scale: '0.85', rotate: `${dir * spin * 0.8}deg`, translate: `0 ${-rise * 0.75}px`, offset: 0.6 },
      { scale: '0', rotate: `${dir * spin}deg`, translate: `0 ${-rise}px` },
    ], { duration: life, delay, easing: 'ease-out', fill: 'both' }).onfinish = () => { d.remove(); this.alive.delete(d); };
    return true;
  }

  /** 星の絵を先に作っておくための仕事（白 + 7色。起動後の空き時間に 1 つずつ） */
  warmJobs() { return ['white', 'red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'].map((name) => () => this.cls(name)); }

  /** 色ごとの星の絵を背景にする CSS クラス名。絵（data URL）は色ごとに 1 回だけスタイルシートに書く */
  cls(name) {
    let c = this.classes.get(name);
    if (!c) {
      c = 'spark-' + name;
      if (!this.sheet) { this.sheet = document.createElement('style'); document.head.appendChild(this.sheet); }
      this.sheet.appendChild(document.createTextNode(`.spark.${c}{background-image:url(${sparkSprite(name).toDataURL()})}\n`));
      this.classes.set(name, c);
    }
    return c;
  }
}

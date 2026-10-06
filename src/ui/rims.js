import { colorOf } from './palette.js?v=202610060919';
import { easeOut } from './fx2d.js?v=202610060919';

/**
 * ラインの光の跡: ブロックが通り過ぎたマスの縁が、ほんの少しのあいだ白く光って引く。
 * マスと同じ形の枠（ふちは白、外側と内側にブロックの明るい色のにじみ）を、色ごとに 1 回だけ描いた絵にしておき、
 * 盤面の演出用の canvas（fx2d.js）に、大きさと濃さだけを変えて貼る。マスごとに要素を作って動かすと、
 * 動いている数だけ毎フレームの仕事が増える（ブロックを動かす requestAnimationFrame が回っている間は特に）。
 * 枠の形は、以前の CSS（.rim-flash::after）と同じ: マスの 5% 内側、角の丸み 20%、
 * box-shadow: inset 0 0 0 2.5px #fff, inset 0 0 9px 1px 光, 0 0 0 1px rgba(255,255,255,.55), 0 0 11px 3px 光
 */

/** 光り方（進み具合 k = 0..1 → 濃さ・大きさ）。区切りごとに ease-out */
const KEYS = [[0, 0, 0.8], [0.14, 1, 1.06], [0.45, 0.55, 1.02], [1, 0, 1]];
export function rimPose(k) {
  k = Math.min(1, Math.max(0, k));
  let i = 1;
  while (i < KEYS.length - 1 && k > KEYS[i][0]) i++;
  const [t0, o0, s0] = KEYS[i - 1], [t1, o1, s1] = KEYS[i], e = easeOut((k - t0) / (t1 - t0));
  return { opacity: o0 + (o1 - o0) * e, scale: s0 + (s1 - s0) * e };
}
export const RIM_MS = 300;                                   // 1 マスが光っている長さ

const OFF = 4000;                                            // 影だけを描くための逃がし幅（px）
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) || 255);

/** 角丸の四角のパス */
function rr(g, x, y, w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/**
 * マスの大きさ c（px）の光の枠の絵。k = 描く細かさ。外側に光がにじむぶんの余白をつけた正方形で、中心がマスの中心。
 * 返り値 { cv, size }（size = 余白込みの 1 辺 px）
 */
export function rimSprite(name, c, k) {
  const pad = Math.ceil(c * 0.5), size = c + 2 * pad;
  const cv = document.createElement('canvas');
  cv.width = cv.height = Math.ceil(size * k);
  const g = cv.getContext('2d');
  g.scale(k, k);
  const [r, gr, b] = rgb(colorOf(name).hi), glow = `rgba(${r},${gr},${b},0.85)`;
  const x = pad + c * 0.05, w = c * 0.9, R = w * 0.2;         // 枠の四角（マスの 5% 内側・角の丸み 20%）
  const shadow = (blur, fill, draw) => {                       // 影だけを描く（形は画面の外へ逃がす）
    g.save();
    g.shadowColor = fill; g.shadowBlur = blur * k; g.shadowOffsetX = OFF * k; g.shadowOffsetY = 0;
    g.fillStyle = fill;
    g.translate(-OFF, 0);
    g.beginPath(); draw(); g.fill('evenodd');
    g.restore();
  };
  // 4 つの影は、後ろに書いたものが下になる: 外側のにじみ → 外側の細い白 → 内側のにじみ → 内側の白いふち
  g.save();                                                    // 外側のにじみ（0 0 11px 3px 光）: 枠の外だけに出す
  g.beginPath(); g.rect(0, 0, size, size); rr(g, x, x, w, w, R); g.clip('evenodd');
  shadow(11, glow, () => rr(g, x - 3, x - 3, w + 6, w + 6, R + 3));
  g.restore();
  g.fillStyle = 'rgba(255,255,255,.55)';                       // 外側の細い白（0 0 0 1px）
  g.beginPath(); rr(g, x - 1, x - 1, w + 2, w + 2, R + 1); rr(g, x, x, w, w, R); g.fill('evenodd');
  g.save();                                                    // 内側のにじみ（inset 0 0 9px 1px 光）: 枠の中だけに出す
  g.beginPath(); rr(g, x, x, w, w, R); g.clip();
  shadow(9, glow, () => { g.rect(-size, -size, size * 3, size * 3); rr(g, x + 1, x + 1, w - 2, w - 2, R - 1); });
  g.restore();
  g.fillStyle = '#fff';                                        // 内側の白いふち（inset 0 0 0 2.5px）
  g.beginPath(); rr(g, x, x, w, w, R); rr(g, x + 2.5, x + 2.5, w - 5, w - 5, R - 2.5); g.fill('evenodd');
  return { cv, size };
}

export class Rims {
  /** fx = ラインの光を描く canvas（fx2d.js の FxCanvas。盤面の座標で、ブロックの下の層に置く） */
  constructor(fx) {
    this.fx = fx;
    this.cell = 0;
    this.sprites = new Map();       // 色名 → 光の枠の絵
  }

  /** マスの大きさが変わったら、絵を作り直す（次に使うとき） */
  setCell(c) {
    if (c === this.cell) return;
    this.cell = c;
    this.sprites.clear();
  }

  clear() { this.fx.drop(this); }

  sprite(name) {
    const key = `${name}|${this.fx.k}`;
    let s = this.sprites.get(key);
    if (!s) { s = rimSprite(name, this.cell, this.fx.k); this.sprites.set(key, s); }
    return s;
  }

  /** (x, y) = 光らせるマスの左上（盤面の座標 px）。delay ms 後に RIM_MS だけ光る */
  flash(x, y, color = 'yellow', delay = 0) {
    if (!this.cell) return;
    const { cv, size } = this.sprite(color), cx = x + this.cell / 2, cy = y + this.cell / 2, start = this.fx.now() + delay;
    this.fx.add({
      owner: this, start, end: start + RIM_MS,
      draw: (g, now) => {
        const p = rimPose((now - start) / RIM_MS);
        if (p.opacity < 0.01) return;
        const d = size * p.scale;
        g.globalAlpha = p.opacity;
        g.drawImage(cv, cx - d / 2, cy - d / 2, d, d);
      },
    });
  }

  /** 光の枠の絵を先に作っておくための仕事（7色。起動後の空き時間に 1 つずつ） */
  warmJobs() { return ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'].map((name) => () => { if (this.cell) this.sprite(name); }); }
}

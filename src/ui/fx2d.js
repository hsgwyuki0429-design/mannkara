/**
 * 盤面の小さな演出（星・宝石のかけら・ラインの光の跡）を、要素ではなく canvas 1 枚に描く。
 *
 * 粒を 1 つずつ要素にして Web Animations で動かすと、ブロックを動かす requestAnimationFrame が回っている間は、
 * 動いている粒の数だけ毎フレーム、スタイルの計算と合成のやり直しがメインスレッドに来る（粒 40 個で、何も動かさないときの約 4 倍の仕事）。
 * canvas なら、粒の数にかかわらず、1 枚の層と drawImage の呼び出しだけで済む（同じ 40 個で 1/7 ほど）。
 * 何も描いていない間は canvas を画面から外す（hidden）ので、層は残らない。
 *
 * 粒は { start, end, draw(ctx, now), done?, owner? }。時刻は now()（ms）。draw は親の要素の座標（px）で描けばよい。
 * 一時停止（setPaused）の間は時計を止める。
 */

/** CSS の cubic-bezier(x1, y1, x2, y2) と同じ緩急（0..1 → 0..1） */
export function bezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {                                // ニュートン法
      const e = X(t) - x;
      if (Math.abs(e) < 1e-6) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;                                          // 傾きが小さいところは二分法
    t = x;
    for (let i = 0; i < 30; i++) {
      const e = X(t);
      if (Math.abs(e - x) < 1e-6) break;
      if (e < x) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}
/** CSS の ease-out */
export const easeOut = bezier(0, 0, 0.58, 1);

/**
 * GPU を使わない描画（ソフトウェア。仮想マシン・GPU が無効の端末など）か。そのとき canvas は、面積と密度の 2 乗に比例して毎フレームの
 * 仕事が重くなる（GPU なら、ほとんど変わらない）ので、描く細かさを下げる。WebGL の描画装置の名前で見分ける（取れなければ GPU ありとして扱う）
 */
export function softwareRendering() {
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (!gl) return false;
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const name = String(ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return /swiftshader|llvmpipe|softpipe|software|basic render/i.test(name);
  } catch { return false; }
}

export class FxCanvas {
  /**
   * parent の子に canvas を 1 枚足す（before があればその前に）。dprMax = 描く細かさの上限（画面の密度とこの小さいほう）
   */
  constructor(parent, { dprMax = 2, before = null } = {}) {
    this.el = document.createElement('canvas');
    this.el.className = 'fx-canvas';
    this.el.hidden = true;                          // 描くものがあるときだけ画面に出す（空の canvas が1枚あるだけで、毎フレームの合成が重くなる）
    parent.insertBefore(this.el, before ?? parent.firstChild ?? null);
    this.ctx = this.el.getContext('2d');
    this.dprMax = dprMax;
    this.k = 1;                                     // canvas の 1px あたりの CSS px の逆数（描く細かさ）
    this.x = 0; this.y = 0; this.w = 0; this.h = 0; // 覆う範囲（親の座標）
    this.items = [];
    this.raf = 0;
    this.every = 1;                                 // 何コマに 1 回描くか（ソフトウェア描画では 2。canvas の中身が変わるたびに画面 1 枚ぶんの写しが要るので、半分にする）
    this.sinceDraw = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.tick = () => this.frame();
    this.now = () => performance.now();
  }

  /** 覆う範囲を (x, y, w, h)（親の座標 px）にする。canvas の大きさ（画素数）が変わらなければ、canvas は作り直さない */
  fit(x, y, w, h) {
    const k = Math.min(this.dprMax, (typeof window !== 'undefined' && window.devicePixelRatio) || 1);
    const W = Math.max(1, Math.round(w * k)), H = Math.max(1, Math.round(h * k));
    Object.assign(this.el.style, { left: `${x}px`, top: `${y}px`, width: `${w}px`, height: `${h}px` });
    this.x = x; this.y = y; this.w = w; this.h = h; this.k = k;
    if (this.el.width !== W) this.el.width = W;     // 大きさを書くと中身が消える（描き直しは次のフレーム）
    if (this.el.height !== H) this.el.height = H;
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  /** 何コマに 1 回描くか（1 = 毎コマ）。粒の動きは時刻で決めるので、間引いても速さは変わらず、なめらかさだけが落ちる */
  setEvery(n) { this.every = Math.max(1, Math.round(n) || 1); }

  /** 描く細かさの上限を変える（覆う範囲はそのまま） */
  setDprMax(v) {
    if (v === this.dprMax) return;
    this.dprMax = v;
    if (this.w) this.fit(this.x, this.y, this.w, this.h);
  }

  get size() { return this.items.length; }

  add(item) {
    this.items.push(item);
    this.el.hidden = false;
    if (!this.raf && !this.paused) { this.sinceDraw = this.every; this.raf = requestAnimationFrame(this.tick); }      // 最初のコマはすぐ描く
  }

  /** owner の粒だけを捨てる（done は呼ばない） */
  drop(owner) {
    this.items = this.items.filter((it) => it.owner !== owner);
    if (!this.items.length) this.stop();
  }

  /** 全部捨てて、画面から外す */
  clear() {
    this.items.length = 0;
    this.stop();
  }

  stop() {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.el.width, this.el.height);
    this.el.hidden = true;
  }

  /** 一時停止（時計も止める）/ 再開（止めていた長さだけ、粒の時刻を後ろへずらす） */
  setPaused(on) {
    if (this.paused === on) return;
    this.paused = on;
    if (on) {
      this.pausedAt = this.now();
      cancelAnimationFrame(this.raf);
      this.raf = 0;
      return;
    }
    const dt = this.now() - this.pausedAt;
    for (const it of this.items) { it.start += dt; it.end += dt; }
    if (this.items.length && !this.raf) { this.sinceDraw = this.every; this.raf = requestAnimationFrame(this.tick); }
  }

  frame() {
    this.raf = 0;
    if (++this.sinceDraw < this.every) { this.raf = requestAnimationFrame(this.tick); return; }       // 間引くコマ: 何も書き換えない（canvas を更新しなければ、写しも要らない）
    this.sinceDraw = 0;
    const now = this.now(), g = this.ctx, items = this.items, k = this.k;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, this.el.width, this.el.height);
    let alive = 0;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (now >= it.end) { it.done?.(); continue; }
      items[alive++] = it;
      if (now < it.start) continue;                  // まだ始まっていない
      g.setTransform(k, 0, 0, k, -this.x * k, -this.y * k);
      g.globalAlpha = 1;
      it.draw(g, now);
    }
    items.length = alive;
    g.globalAlpha = 1;
    if (alive) this.raf = requestAnimationFrame(this.tick);
    else this.el.hidden = true;                      // この frame の頭で消してあるので、絵は残っていない
  }
}

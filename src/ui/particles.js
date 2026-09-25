/**
 * 演出の粒（光の粒・破片・衝撃波の輪・光の尾）を1枚の canvas にまとめて描く。
 * 粒を1つずつ DOM 要素にしてアニメーションさせると、長い連鎖で数百個が同時に動き、
 * 毎フレームのスタイル計算と描画が追いつかずに画面がカクつく。canvas なら何個あっても
 * 1つの requestAnimationFrame で描くだけで済む（粒が無い間はループを止める）。
 *
 * 座標は rotWrap 内の px（回転しない座標）。canvas は rotWrap より margin だけ大きく取り、
 * 盤面の外へ飛び出す粒も切れないようにする。毎フレーム消して描き直すのは、粒がいる範囲（前のフレームと
 * 今のフレームの外接四角）だけにする（canvas 全体を毎回塗り直すと、それだけで重い）。
 *
 * 形はすべて丸（線や細長い筋は使わない）。光るもの（光の玉・火の粉・光の尾）は加算合成で重ねて明るさを出す。
 * 形のある粒（色の粒・破片・輪）は普通に塗る。加算は光のにじみだけに使うので、青い背景の上でも色が濁らない。
 * 大きくて形の変わらない光（フレア・放射状の光線）はここでは描かない（renderer が DOM の1枚絵を
 * 拡大・回転・透明度だけで動かす。毎フレーム描き直さないので、大きくても軽い）。
 */
const MAX_PARTICLES = 700;
/** 加算合成で描く種類 */
const ADDITIVE = new Set(['orb', 'ember', 'trail']);
/** 花火などで使う7色（ブロックと同じ色） */
export const RAINBOW = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
const TAU = Math.PI * 2;
const easeOut2 = (t) => 1 - (1 - t) * (1 - t);        // CSS ease-out 相当
const easeOut3 = (t) => 1 - Math.pow(1 - t, 3);       // cubic-bezier(.2,.7,.3,1) 相当

export class Particles {
  constructor(parent) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'fx-canvas';
    parent.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.list = [];
    this.colors = new Map();
    this.sprites = new Map();
    this.raf = 0;
    this.margin = 0;
    this.dirty = null;       // 前のフレームで描いた範囲（canvas の px）
    this.frameMs = 16.7;     // 粒を描いている間の1フレームの時間（なめらかに平均）
    this.lastNow = 0;
  }

  /**
   * 演出の量の目安（1 = 全部出す … 0.25 = 最小限）。粒を描いている間のフレーム時間から決める。
   * 遅い端末や重い場面では自動で粒や光を減らし、画面がカクつかないようにする
   */
  get quality() {
    return Math.max(0.25, Math.min(1, 1 - (this.frameMs - 20) / 26));
  }

  /** rotWrap の大きさに合わせる（margin = はみ出してよい幅 px） */
  fit(w, h, margin) {
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);   // 粒はぼんやり光るだけなので高解像度は要らない（画素が多いほど重い）
    this.margin = margin;
    this.dpr = dpr;
    Object.assign(this.canvas.style, {
      left: -margin + 'px', top: -margin + 'px', width: w + 2 * margin + 'px', height: h + 2 * margin + 'px',
    });
    this.canvas.width = Math.round((w + 2 * margin) * dpr);
    this.canvas.height = Math.round((h + 2 * margin) * dpr);
    this.dirty = null;                          // 大きさを変えると canvas は空になる
  }

  clear() {
    this.list.length = 0;
    this.dirty = null;
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }

  /* ---------- 粒の種類 ---------- */
  /** 四方に散る光の粒（ゴール） */
  burst(x, y, color, n, cell) {
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = cell * (0.7 + Math.random() * 1.3);
      this.add({ kind: 'dot', x, y, dx: Math.cos(a) * dist, dy: Math.sin(a) * dist, life: 620, size: 7, color });
    }
  }
  /** 着地の小さな白い粒 */
  sparks(x, y, color, n, cell) {
    for (let k = 0; k < n; k++) {
      const a = (Math.PI * 2 * k) / n + Math.random() * 0.5;
      const dist = cell * (0.9 + Math.random() * 0.9);
      this.add({ kind: 'spark', x, y, dx: Math.cos(a) * dist, dy: Math.sin(a) * dist, life: 520, size: 5, color });
    }
  }
  /** 重力で落ちる破片 */
  shatter(x, y, color, n, cell) {
    for (let i = 0; i < n; i++) {
      this.add({
        kind: 'shard', x, y, color,
        size: cell * (0.18 + Math.random() * 0.2),
        vx: (Math.random() - 0.5) * cell * 5, vy: -cell * (2 + Math.random() * 3), g: cell * 11,
        rot: (Math.random() - 0.5) * 900, life: (0.7 + Math.random() * 0.25) * 1000,
      });
    }
  }
  /**
   * 丸い光の輪: 小さな光の玉が円に並んで外へ広がり、真ん中はふわっと光る（線の輪は使わない）
   * size は広がる前の直径
   */
  wave(x, y, color, cell, { n = 12, spread = 1.7, size } = {}) {
    const d = size ?? cell * 1.3;
    this.add({ kind: 'bloom', x, y, color, size: d * 1.6, life: 420 });
    this.halo(x, y, color, { n: Math.max(6, Math.round(n * this.quality)), r0: d * 0.3, r1: d * spread, dot: cell * 0.2, life: 560 });
  }
  /** 円に並んだ光の玉が r0 から r1 へ広がりながら小さくなって消える（放射状の光線の代わり） */
  halo(x, y, color, { n = 12, r0 = 10, r1 = 60, dot = 6, life = 600, spin = 0.6 } = {}) {
    const a0 = Math.random() * TAU;
    for (let i = 0; i < n; i++) {
      const a = a0 + (TAU * i) / n;
      this.add({ kind: 'haloDot', x, y, color, a, spin, r0, r1, size: dot * (i % 2 ? 0.75 : 1), life: life * (0.9 + (i % 3) * 0.08) });
    }
  }
  /** 流れるブロックが残す光の尾 */
  trail(x, y, color, cell) { this.add({ kind: 'trail', x, y, color, size: cell * 0.55, life: 340 }); }

  /**
   * 飛び散る光の玉（丸）。空気抵抗で減速しながら小さくなって消える。
   * dir を中心に spread の範囲へ飛ぶ（spread = TAU なら全方向）。speed はマス/秒、len は玉の大きさの倍率。
   */
  streaks(x, y, color, n, cell, { dir = 0, spread = TAU, speed = [5, 11], life = [380, 620], len = 1 } = {}) {
    for (let i = 0; i < n; i++) {
      const a = dir + (spread >= TAU ? (TAU * (i + Math.random() * 0.8)) / n : (Math.random() - 0.5) * spread);
      const v = cell * (speed[0] + Math.random() * (speed[1] - speed[0]));
      this.add({
        kind: 'orb', x, y, color, vx: Math.cos(a) * v, vy: Math.sin(a) * v, k: 4.5,
        size: cell * 0.42 * len * (0.7 + Math.random() * 0.6), life: life[0] + Math.random() * (life[1] - life[0]),
      });
    }
  }
  /** ゆらゆら立ちのぼる火の粉（範囲 x0〜x1, y0〜y1 の中から） */
  embers(x0, y0, x1, y1, color, n, cell) {
    for (let i = 0; i < n; i++) {
      this.add({
        kind: 'ember', x: x0 + Math.random() * (x1 - x0), y: y0 + Math.random() * (y1 - y0), color,
        rise: cell * (1.2 + Math.random() * 1.6), wob: cell * 0.25, ph: Math.random() * TAU,
        size: cell * (0.28 + Math.random() * 0.22), life: 900 + Math.random() * 700,
      });
    }
  }
  /** 花火: 光の玉 + 色の粒 + 丸い光の輪（フレアは renderer 側） */
  firework(x, y, color, cell) {
    const q = this.quality;
    this.streaks(x, y, color, Math.round(16 * q), cell, { speed: [6, 12], life: [520, 800], len: 1.1 });
    this.burst(x, y, color, Math.round(10 * q), cell);
    this.wave(x, y, color, cell);
  }

  add(p) {
    if (this.list.length >= MAX_PARTICLES) return;
    p.t0 = performance.now();
    this.list.push(p);
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /* ---------- 描画 ---------- */
  frame(now) {
    // 1回だけの大きな引っかかり（手駒の計算・タブの切り替えなど）は数えない。続けて遅いときだけ減らす
    if (this.lastNow) { const dt = now - this.lastNow; if (dt < 100) this.frameMs += (dt - this.frameMs) * 0.08; }
    this.lastNow = now;
    const { ctx, dpr, margin } = this;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (this.dirty) { const d = this.dirty; ctx.clearRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0); }
    ctx.setTransform(dpr, 0, 0, dpr, margin * dpr, margin * dpr);
    // 今のフレームで描く範囲（rotWrap の px）
    this.box = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    let alive = 0;
    for (const p of this.list) {
      p.t = Math.min(1, Math.max(0, (now - p.t0) / p.life));    // rAF の時刻は、直前に足した粒より前のことがある
      if (p.t >= 1) continue;
      this.list[alive++] = p;
    }
    this.list.length = alive;
    // 形のある粒を先に普通に塗り、光るものをその上に加算で重ねる
    ctx.globalCompositeOperation = 'source-over';
    for (const p of this.list) if (!ADDITIVE.has(p.kind)) this.draw(p, p.t);
    ctx.globalCompositeOperation = 'lighter';
    for (const p of this.list) if (ADDITIVE.has(p.kind)) this.draw(p, p.t);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
    const b = this.box, W = this.canvas.width, H = this.canvas.height;
    this.dirty = alive ? {
      x0: Math.max(0, Math.floor((b.x0 + margin) * dpr) - 2), y0: Math.max(0, Math.floor((b.y0 + margin) * dpr) - 2),
      x1: Math.min(W, Math.ceil((b.x1 + margin) * dpr) + 2), y1: Math.min(H, Math.ceil((b.y1 + margin) * dpr) + 2),
    } : null;
    this.raf = alive ? requestAnimationFrame((t) => this.frame(t)) : 0;
    if (!alive) this.lastNow = 0;
  }

  /** 中心 (x, y)・半径 r の範囲に描いたことを記録する */
  mark(x, y, r) {
    const b = this.box;
    if (x - r < b.x0) b.x0 = x - r;
    if (y - r < b.y0) b.y0 = y - r;
    if (x + r > b.x1) b.x1 = x + r;
    if (y + r > b.y1) b.y1 = y + r;
  }

  draw(p, t) {
    const ctx = this.ctx;
    const c = this.color(p.color);
    if (p.kind === 'dot' || p.kind === 'spark') {
      const e = p.kind === 'dot' ? easeOut2(t) : easeOut3(t);
      const s = p.size * (1 - e * (p.kind === 'dot' ? 0.6 : 0.7));
      const img = this.sprite(p.kind, p.color);
      const r = s * 2.4;                                    // 光のにじみを含めた大きさ
      const x = p.x + p.dx * e, y = p.y + p.dy * e;
      ctx.globalAlpha = 1 - e;
      ctx.drawImage(img, x - r / 2, y - r / 2, r, r);
      this.mark(x, y, r / 2);
    } else if (p.kind === 'shard') {
      const sec = (t * p.life) / 1000;
      const x = p.x + p.vx * sec, y = p.y + p.vy * sec + 0.5 * p.g * sec * sec;
      const s = p.size * (1 - 0.5 * t);
      ctx.globalAlpha = t < 0.625 ? 1 : 1 - (t - 0.625) / 0.375;
      const img = this.sprite('shard', p.color);            // 丸い宝石の粒（回転は見えないので回さない）
      ctx.drawImage(img, x - s * 0.8, y - s * 0.8, s * 1.6, s * 1.6);
      this.mark(x, y, s * 0.8);
    } else if (p.kind === 'bloom') {                        // ふわっと広がって消える丸い光
      const e = easeOut3(t), r = (p.size / 2) * (0.4 + 0.8 * e);
      ctx.globalAlpha = 0.75 * (1 - t) * (1 - t);
      ctx.drawImage(this.sprite('glow', p.color), p.x - r, p.y - r, r * 2, r * 2);
      this.mark(p.x, p.y, r);
    } else if (p.kind === 'haloDot') {                      // 円に並んで広がる光の玉
      const e = easeOut3(t), r = p.r0 + (p.r1 - p.r0) * e, a = p.a + p.spin * e;
      const x = p.x + Math.cos(a) * r, y = p.y + Math.sin(a) * r, s = p.size * (1 - 0.55 * t) * 2.2;
      ctx.globalAlpha = t < 0.1 ? t / 0.1 : 1 - (t - 0.1) / 0.9;
      ctx.drawImage(this.sprite('spark', p.color), x - s / 2, y - s / 2, s, s);
      this.mark(x, y, s / 2);
    } else if (p.kind === 'trail') {
      const e = easeOut2(t);
      const r = p.size * (1 - 0.8 * e);
      ctx.globalAlpha = 1 - e;
      ctx.drawImage(this.sprite('trail', p.color), p.x - r / 2, p.y - r / 2, r, r);
      this.mark(p.x, p.y, r / 2);
    } else if (p.kind === 'orb') {                          // 飛び散る光の玉
      const sec = (t * p.life) / 1000, f = Math.exp(-p.k * sec);
      const x = p.x + (p.vx * (1 - f)) / p.k, y = p.y + (p.vy * (1 - f)) / p.k;
      const r = p.size * (1 - 0.6 * t) * 1.6;
      ctx.globalAlpha = 1 - t * t;
      ctx.drawImage(this.sprite('trail', p.color), x - r / 2, y - r / 2, r, r);
      this.mark(x, y, r / 2);
    } else if (p.kind === 'ember') {
      const x = p.x + Math.sin(p.ph + t * 7) * p.wob, y = p.y - p.rise * t;
      const r = p.size * (1 - 0.4 * t);
      ctx.globalAlpha = Math.sin(Math.PI * t) * 0.9;
      ctx.drawImage(this.sprite('glow', p.color), x - r / 2, y - r / 2, r, r);
      this.mark(x, y, r / 2);
    }
  }

  /** 色名（red など）→ styles.css の .c-<色> に書かれた色 */
  color(name) {
    let c = this.colors.get(name);
    if (!c) {
      const probe = document.createElement('div');
      probe.className = `c-${name}`;
      probe.style.display = 'none';
      document.body.appendChild(probe);
      const cs = getComputedStyle(probe);
      const v = (k, d) => cs.getPropertyValue(k).trim() || d;
      c = { col: v('--col', '#fff'), hi: v('--hi', '#fff'), lo: v('--lo', '#888'), rim: v('--rim', '#fff') };
      probe.remove();
      this.colors.set(name, c);
    }
    return c;
  }

  /** 粒の見た目を小さな canvas に1回だけ描いておき、毎フレームはそれを貼るだけにする */
  sprite(kind, name) {
    const key = kind + ':' + name;
    let img = this.sprites.get(key);
    if (img) return img;
    const c = this.color(name);
    img = document.createElement('canvas');
    const S = kind === 'glow' ? 64 : 48;
    img.width = img.height = S;
    const g = img.getContext('2d');
    const glow = (inner, outer) => {
      const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, inner);
      grd.addColorStop(0.35, outer);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    };
    if (kind === 'dot') {                       // 色の丸い粒 + 同じ色のにじみ
      g.globalAlpha = 0.55; glow(c.col, c.col); g.globalAlpha = 1;
      g.fillStyle = c.col;
      g.beginPath(); g.arc(S / 2, S / 2, S * 0.2, 0, Math.PI * 2); g.fill();
    } else if (kind === 'spark') {              // 白い粒 + 色のにじみ
      g.globalAlpha = 0.8; glow(c.col, c.col); g.globalAlpha = 1;
      g.fillStyle = '#fff';
      g.beginPath(); g.arc(S / 2, S / 2, S * 0.16, 0, Math.PI * 2); g.fill();
    } else if (kind === 'shard') {              // 光る宝石の丸い粒（左上から光が当たる）
      g.globalAlpha = 0.45; glow(c.col, c.col); g.globalAlpha = 1;
      const grd = g.createRadialGradient(S * 0.4, S * 0.38, S * 0.02, S / 2, S / 2, S * 0.3);
      grd.addColorStop(0, c.hi); grd.addColorStop(0.55, c.col); grd.addColorStop(1, c.lo);
      g.fillStyle = grd;
      g.beginPath(); g.arc(S / 2, S / 2, S * 0.3, 0, Math.PI * 2); g.fill();
      g.fillStyle = 'rgba(255,255,255,.7)';
      g.beginPath(); g.arc(S * 0.41, S * 0.39, S * 0.07, 0, Math.PI * 2); g.fill();
    } else if (kind === 'glow') {               // 中心だけ白く、外側は色でぼんやり（フレア・火の粉）
      const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, 'rgba(255,255,255,.6)');         // 加算で重なっても真っ白に飛ばないよう控えめに
      grd.addColorStop(0.12, rgba(c.hi, 0.6));
      grd.addColorStop(0.35, rgba(c.col, 0.35));
      grd.addColorStop(1, rgba(c.col, 0));
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    } else if (kind === 'trail') {              // 中心が白い丸い光
      const grd = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
      grd.addColorStop(0, '#fff'); grd.addColorStop(0.45 / 0.7 * 0.5, c.col); grd.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = grd;
      g.fillRect(0, 0, S, S);
    }
    this.sprites.set(key, img);
    return img;
  }
}

/** '#rrggbb' → 'rgba(r,g,b,a)' */
function rgba(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) return `rgba(255,255,255,${a})`;
  return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
}

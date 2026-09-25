/**
 * 画面全体の演出（シーン）。盤面の外側まで使う、大きな色の変化のための層。
 *
 *  - 奥の canvas（#sceneBack, 盤面やトレイの後ろ）: 下からせり上がる海、泡、光の差し込み
 *  - #sceneStars（奥）: 立ちのぼる星・火の粉（小さな絵を transform と opacity だけで動かす）
 *  - 手前の canvas（#sceneFront, 盤面の前）: 文字の書かれた風船、風船が割れた破片、波の泡の線、衝撃波の輪
 *  - #sceneTint / #sceneBurst（奥）: 画面全体の色の変化と、回る光の放射。1回だけ描いた絵を
 *    transform と opacity だけで動かす（毎フレーム描き直さないので、画面いっぱいでも軽い）
 *
 * 何も動いていない間は requestAnimationFrame を止める。色はブロックの7色と、海の青緑だけを使う。
 */
const TAU = Math.PI * 2;
const RAINBOW = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
const easeOut3 = (t) => 1 - Math.pow(1 - t, 3);
const easeIn3 = (t) => t * t * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
/** 行き過ぎてから戻る（風船が浮かび上がって止まるとき） */
const easeOutBack = (t) => { const c = 1.4; return 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2); };

/** 海の色（上から: 水面の明るい青緑 → 中ほどの水色 → 深い青。背景の青と馴染む明るさ） */
const SEA = { surface: 'rgba(118,232,255,.92)', mid: 'rgba(40,178,236,.9)', deep: 'rgba(24,92,210,.94)', back: 'rgba(66,196,245,.55)' };

export class Scenes {
  constructor({ sfx, colorOf, quality = () => 1 } = {}) {
    this.sfx = sfx;
    this.colorOf = colorOf;                         // 色名 → { col, hi, lo, rim }
    this.quality = quality;                         // 演出の量（1 = 全部 … 0.25 = 最小限）
    this.reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const app = document.getElementById('app');
    const mk = (tag, id, before) => {
      const el = document.createElement(tag);
      el.id = id;
      if (before) document.body.insertBefore(el, before); else document.body.appendChild(el);
      return el;
    };
    this.tint = mk('div', 'sceneTint', app);
    this.burst = mk('div', 'sceneBurst', app);
    this.starLayer = mk('div', 'sceneStars', app);
    this.back = mk('canvas', 'sceneBack', app);
    this.front = mk('canvas', 'sceneFront');
    this.bctx = this.back.getContext('2d');
    this.fctx = this.front.getContext('2d');
    this.sprites = new Map();
    this.water = null;
    this.balloons = [];
    this.bits = [];          // 風船の破片・光の粒（手前）
    this.bubbles = [];       // 海の中の泡（奥）
    this.rings = [];         // 衝撃波の輪（手前）
    this.raf = 0;
    this.gen = 0;
    this.fit();
    window.addEventListener('resize', () => this.fit());
  }

  fit() {
    const W = window.innerWidth, H = window.innerHeight;
    this.W = W; this.H = H;
    // 奥の海はなめらかなグラデーションだけなので解像度 1 で十分（画素が多いほど重い）
    this.back.width = Math.round(W); this.back.height = Math.round(H);
    this.fdpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.front.width = Math.round(W * this.fdpr); this.front.height = Math.round(H * this.fdpr);
  }

  clear() {
    this.gen++;
    this.water = null;
    this.balloons.length = this.bits.length = this.bubbles.length = this.rings.length = 0;
    this.bctx.clearRect(0, 0, this.back.width, this.back.height);
    this.fctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fctx.clearRect(0, 0, this.front.width, this.front.height);
    for (const a of [this._tintAnim, this._burstAnim, this._tintSpin]) a?.cancel();
    this.starLayer.innerHTML = '';
  }

  /* =====================================================================
   * 演出の組み合わせ
   * ===================================================================== */

  /**
   * 全消し: 海が下からせり上がり、文字の風船（ALL CLEAR）が浮かんできて、ひとつずつ割れる。
   * 最後に海が引いていく（約3.8秒。ゲームは止めない）
   */
  allClear() {
    const now = performance.now();
    this.wash('sea', 3400, 0.5);
    this.sunburst('sea', 3200, 0.45);
    this.water = { t0: now, peak: 0.6, drainAt: 2750, end: 3850, ph: Math.random() * TAU, lastSplash: 0 };
    this.sfx?.wave?.();
    this.spell('ALL CLEAR', { at: 260, popAt: 2350, row: 0.2 });
    this.kick();
  }

  /** 新記録: 金色に色が変わり、風船の NEW BEST が浮かんで割れる */
  newBest() {
    this.wash('gold', 2600, 0.62);
    this.sunburst('gold', 2600, 0.5);
    this.spell('NEW BEST', { at: 120, popAt: 1900, row: 0.3 });
    this.rise('gold', 18);
    this.kick();
  }

  /**
   * 大きな連鎖（褒め言葉が Amazing 以上）: 画面全体の色が段階の色に染まり、光の放射が回って、
   * 下から星が立ちのぼる。Unbelievable（tier 5）は虹色で、衝撃波の輪も広がる
   */
  bigChain(tier, center) {
    const now = performance.now();
    if (now - (this._lastBig ?? -1e9) < 1100) return;       // 続けて重ならないように（長い連鎖で光りっぱなしにしない）
    this._lastBig = now;
    const kind = tier >= 5 ? 'rainbow' : 'amazing';
    // 画面いっぱいの半透明の層は、遅い端末では合成が重いので省く（演出の量 quality が下がっているとき）
    const q = this.quality();
    if (q >= 0.45) this.wash(kind, 1400, tier >= 5 ? 0.5 : 0.42);
    if (q >= 0.6) this.sunburst(kind, 1500, 0.55, center);
    this.rise(tier >= 5 ? 'rainbow' : 'purple', tier >= 5 ? 22 : 16);
    if (tier >= 5 && center) this.ring(center.x, center.y, 'yellow');
    this.kick();
  }

  /** コンボが5の倍数に届いた: 暖色に染まり、画面の下から火の粉が立ちのぼる */
  comboWave() {
    if (this.quality() >= 0.45) this.wash('warm', 1500, 0.6);
    this.rise('warm', 20);
    this.kick();
  }

  /* =====================================================================
   * 部品
   * ===================================================================== */

  /** 画面全体の色（kind ごとの1枚絵）を opacity だけで出して消す。rainbow はゆっくり回す */
  wash(kind, dur, alpha) {
    const el = this.tint;
    el.className = `t-${kind}`;
    el.style.backgroundImage = kind === 'rainbow' ? `url(${this.rainbowImage()})` : '';
    const k = (2 * Math.max(this.W, this.H)) / 400;          // 400px の絵を画面の2倍の大きさに拡大する
    el.style.transform = `scale(${k})`;
    this._tintAnim?.cancel();
    this._tintAnim = el.animate(
      [{ opacity: 0 }, { opacity: alpha, offset: 0.16 }, { opacity: alpha * 0.8, offset: 0.7 }, { opacity: 0 }],
      { duration: dur, easing: 'ease-out' });
    this._tintSpin?.cancel();
    if (kind === 'rainbow' && !this.reduced) {
      this._tintSpin = el.animate([{ transform: `scale(${k}) rotate(0deg)` }, { transform: `scale(${k}) rotate(200deg)` }],
        { duration: dur, easing: 'linear' });
    }
  }

  /** 回る光の放射（1回だけ描いた絵を拡大・回転）。center は画面座標。省略時は画面の中ほど */
  sunburst(kind, dur, alpha, center) {
    const el = this.burst;
    el.className = '';
    el.style.backgroundImage = `url(${this.burstImage(kind)})`;
    const x = center?.x ?? this.W / 2, y = center?.y ?? this.H * 0.45;
    const r0 = Math.random() * 360, k = (1.7 * Math.max(this.W, this.H)) / 400;
    const at = (rot, sc) => `translate(${x - 200}px,${y - 200}px) rotate(${rot}deg) scale(${sc * k})`;
    this._burstAnim?.cancel();
    this._burstAnim = el.animate([
      { opacity: 0, transform: at(r0, 0.6) },
      { opacity: alpha, transform: at(r0 + 12, 0.95), offset: 0.2 },
      { opacity: alpha * 0.7, transform: at(r0 + 40, 1.05), offset: 0.7 },
      { opacity: 0, transform: at(r0 + 60, 1.12) },
    ], { duration: this.reduced ? dur * 0.6 : dur, easing: 'cubic-bezier(.2,.7,.3,1)' });
  }

  /**
   * 画面の下から星（または火の粉）が立ちのぼる。星は1回だけ描いた小さな絵を transform と opacity だけで動かす
   * （画面いっぱいの canvas を毎フレーム描き直すより、ずっと軽い）
   */
  rise(kind, n) {
    n = Math.round(n * this.quality());
    const colors = kind === 'rainbow' ? RAINBOW : kind === 'warm' ? ['orange', 'yellow', 'red'] : kind === 'gold' ? ['yellow', 'orange'] : ['purple', 'red', 'cyan'];
    const gen = this.gen;
    for (let i = 0; i < n; i++) {
      const color = colors[i % colors.length], star = kind !== 'warm' && Math.random() < 0.6;
      const size = 20 + Math.random() * 28, life = 1300 + Math.random() * 900, delay = Math.random() * 500;
      const x = Math.random() * this.W, y = this.H * (0.72 + Math.random() * 0.35), rise = this.H * (0.35 + Math.random() * 0.35);
      const wob = (Math.random() < 0.5 ? -1 : 1) * (10 + Math.random() * 16);
      const d = document.createElement('div');
      d.className = 'scene-star';
      d.style.backgroundImage = `url(${this.spriteUrl(star ? 'star' : 'glow', color)})`;
      this.starLayer.appendChild(d);
      const tf = (dx, dy, sc) => `translate(${x - 32 + dx}px,${y - 32 + dy}px) scale(${(sc * size) / 64})`;
      d.animate([
        { opacity: 0, transform: tf(0, 0, 0.6) },
        { opacity: 1, transform: tf(wob, -rise * 0.35, 1), offset: 0.3 },
        { opacity: 0.7, transform: tf(-wob * 0.5, -rise * 0.75, 0.9), offset: 0.7 },
        { opacity: 0, transform: tf(wob * 0.3, -rise, 0.7) },
      ], { duration: life, delay, easing: 'ease-out', fill: 'backwards' }).onfinish = () => d.remove();
      if (gen !== this.gen) d.remove();
    }
  }

  /** 画面いっぱいに広がる衝撃波の輪 */
  ring(x, y, color) {
    this.rings.push({ t0: performance.now(), life: 800, x, y, color, r1: Math.hypot(this.W, this.H) * 0.7 });
  }

  /**
   * 文字を1つずつ風船にして、下から浮かび上がらせる（空白は間を空ける）。
   * at ms 後から少しずつずらして打ち上げ、popAt ms 後から左から順に割る。row は止まる高さ（画面の上からの割合）
   */
  spell(text, { at = 0, popAt = 2000, row = 0.22 } = {}) {
    const now = performance.now();
    const chars = [...text];
    const slot = Math.min(50, (Math.min(this.W, 560) - 24) / chars.length);
    const x0 = this.W / 2 - (slot * chars.length) / 2 + slot / 2;
    let k = 0;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      const color = RAINBOW[(k * 2 + 1) % RAINBOW.length];
      this.balloons.push({
        ch, color, x: x0 + i * slot, size: slot * 0.96,
        yT: this.H * row + (k % 2 ? 8 : -6),                // 少しジグザグに並べる
        t0: now + at + k * 70, popAt: now + popAt + k * 85, ph: Math.random() * TAU,
      });
      k++;
    });
  }

  /* =====================================================================
   * 描画
   * ===================================================================== */
  kick() { if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }

  frame(now) {
    this.raf = 0;
    now = Math.max(now, performance.now() - 1);        // rAF の時刻はフレームの始まりなので、直前に作った演出より前になることがある
    const b = this.bctx, f = this.fctx;
    // 前のフレームで何か描いた canvas だけを消す（何も無い canvas を毎フレーム消すと、それだけで画面全体の描き直しになる）
    if (this.backDirty) b.clearRect(0, 0, this.back.width, this.back.height);
    f.setTransform(1, 0, 0, 1, 0, 0);
    if (this.frontDirty) f.clearRect(0, 0, this.front.width, this.front.height);
    f.setTransform(this.fdpr, 0, 0, this.fdpr, 0, 0);
    this.backDirty = !!this.water;
    this.frontDirty = !!this.water || this.balloons.length + this.bits.length + this.rings.length > 0;

    let busy = false;
    if (this.water) busy = this.drawWater(now) || busy;
    busy = this.drawBalloons(now) || busy;
    busy = this.drawBits(now) || busy;
    busy = this.drawRings(now) || busy;
    b.globalAlpha = 1; f.globalAlpha = 1;
    b.globalCompositeOperation = f.globalCompositeOperation = 'source-over';
    if (busy) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  /** 海の水位（画面の高さに対する割合）。ばねのように行き過ぎて揺れ戻り、最後に引いていく */
  level(w, ms) {
    const p = ms / 1000;
    let lvl = w.peak * (1 - Math.exp(-4.5 * p) * Math.cos(6 * p));
    if (ms > w.drainAt) {
      const q = clamp01((ms - w.drainAt) / (w.end - w.drainAt - 100));
      lvl = lvl * (1 - easeIn3(q)) - 0.06 * q;
    }
    return lvl;
  }

  drawWater(now) {
    const w = this.water, ms = now - w.t0;
    if (ms > w.end) { this.water = null; return false; }
    const b = this.bctx, f = this.fctx, W = this.W, H = this.H, q = this.quality();
    const lvl = this.level(w, ms), prev = this.level(w, Math.max(0, ms - 16));
    const speed = Math.abs(lvl - prev) * 60;                  // 水位の変わる速さ（揺れの大きさに使う）
    const base = H * (1 - lvl);
    const amp = 7 + Math.min(18, speed * 60);
    const t = ms / 1000;
    const surf = (x, off = 0, a = amp) => base + off
      + a * Math.sin(x * 0.018 + t * 2.6 + w.ph) + a * 0.55 * Math.sin(x * 0.041 - t * 3.7 + w.ph * 2);
    const step = 14;

    // 奥の波（少し高く、薄い）
    b.beginPath();
    b.moveTo(0, H);
    for (let x = 0; x <= W + step; x += step) b.lineTo(x, surf(x, -12, amp * 0.8) + 4 * Math.sin(x * 0.03 + t * 5));
    b.lineTo(W, H);
    b.closePath();
    b.fillStyle = SEA.back;
    b.fill();

    // 手前の海
    const top = base - amp * 1.6;
    const g = b.createLinearGradient(0, top, 0, Math.max(top + 1, H));
    g.addColorStop(0, SEA.surface);
    g.addColorStop(0.28, SEA.mid);
    g.addColorStop(1, SEA.deep);
    b.beginPath();
    b.moveTo(0, H);
    for (let x = 0; x <= W + step; x += step) b.lineTo(x, surf(x));
    b.lineTo(W, H);
    b.closePath();
    b.fillStyle = g;
    b.fill();

    // 水の中に差し込む光の筋（ゆっくり左右に揺れる）
    if (q >= 0.5) {
      b.save();
      b.clip();
      b.globalCompositeOperation = 'lighter';
      for (let i = 0; i < 4; i++) {
        const cx = ((i + 0.5) / 4) * W + Math.sin(t * 0.7 + i * 1.7) * 30;
        const lg = b.createLinearGradient(0, base, 0, base + H * 0.5);
        lg.addColorStop(0, 'rgba(255,255,255,.16)');
        lg.addColorStop(1, 'rgba(255,255,255,0)');
        b.fillStyle = lg;
        b.beginPath();
        b.moveTo(cx - 14, base - 10);
        b.lineTo(cx + 22, base - 10);
        b.lineTo(cx + 70, base + H * 0.5);
        b.lineTo(cx - 10, base + H * 0.5);
        b.closePath();
        b.fill();
      }
      b.restore();
    }

    // 水面のきらめき（白い線）
    b.beginPath();
    for (let x = 0; x <= W + step; x += step) { const y = surf(x); if (x === 0) b.moveTo(x, y); else b.lineTo(x, y); }
    b.strokeStyle = 'rgba(255,255,255,.7)';
    b.lineWidth = 2.5;
    b.stroke();

    // 泡: 水の中で生まれて、ゆらゆら上がり、水面で消える
    if (lvl > 0.05 && Math.random() < 0.8 * q) {
      for (let k = 0; k < 1; k++) this.bubbles.push({ x: Math.random() * W, y: H + 10, r: 2 + Math.random() * 5, v: 70 + Math.random() * 110, ph: Math.random() * TAU, t0: now });
    }
    b.lineWidth = 1.3;
    let alive = 0;
    for (const bb of this.bubbles) {
      const s = (now - bb.t0) / 1000;
      const y = bb.y - bb.v * s, x = bb.x + Math.sin(bb.ph + s * 4) * 6;
      if (y < surf(x) + bb.r) continue;
      this.bubbles[alive++] = bb;
      b.strokeStyle = 'rgba(255,255,255,.6)';
      b.beginPath(); b.arc(x, y, bb.r, 0, TAU); b.stroke();
      b.fillStyle = 'rgba(255,255,255,.55)';
      b.beginPath(); b.arc(x - bb.r * 0.35, y - bb.r * 0.35, bb.r * 0.3, 0, TAU); b.fill();
    }
    this.bubbles.length = alive;

    // 波が盤面の上を通り過ぎる間だけ、手前にも泡の線を描く（せり上がる・引いていく勢いが見える）
    if (speed > 0.01) {
      const a = clamp01(speed * 40) * 0.55;
      f.globalAlpha = a;
      f.beginPath();
      for (let x = 0; x <= W + step; x += step) { const y = surf(x); if (x === 0) f.moveTo(x, y); else f.lineTo(x, y); }
      f.strokeStyle = '#fff';
      f.lineWidth = 3;
      f.stroke();
      const fg = f.createLinearGradient(0, base - amp, 0, base + 40);
      fg.addColorStop(0, 'rgba(160,240,255,.35)');
      fg.addColorStop(1, 'rgba(160,240,255,0)');
      f.lineTo(W, base + 40); f.lineTo(0, base + 40); f.closePath();
      f.fillStyle = fg;
      f.fill();
      f.globalAlpha = 1;
      // 勢いよく上がった直後の水しぶき
      if (speed > 0.02 && now - w.lastSplash > 70 && q >= 0.4) {
        w.lastSplash = now;
        for (let k = 0; k < 3; k++) {
          const x = Math.random() * W;
          this.bits.push({ kind: 'drop', t0: now, life: 650, x, y: surf(x), vx: (Math.random() - 0.5) * 120, vy: -(160 + Math.random() * 220), g: 900, size: 3 + Math.random() * 3, color: 'cyan' });
        }
      }
    }
    return true;
  }

  drawBalloons(now) {
    const f = this.fctx, H = this.H;
    let alive = 0;
    for (const bl of this.balloons) {
      if (now >= bl.popAt) { this.pop(bl, now); continue; }
      this.balloons[alive++] = bl;
      if (now < bl.t0) continue;
      const t = clamp01((now - bl.t0) / 1250);
      const y = H + bl.size + (bl.yT - H - bl.size) * easeOutBack(t) + Math.sin(now * 0.0032 + bl.ph) * 4 * t;
      const x = bl.x + Math.sin(now * 0.0021 + bl.ph) * 3;
      const rot = Math.sin(now * 0.0026 + bl.ph) * 0.07 + (1 - t) * 0.12 * Math.sin(bl.ph);
      const w = bl.size, h = w * 1.25;
      bl.cx = x; bl.cy = y;
      // ひも（下で少し遅れて揺れる）
      f.strokeStyle = 'rgba(255,255,255,.75)';
      f.lineWidth = 1.2;
      f.beginPath();
      const kx = x + Math.sin(rot) * h * 0.5, ky = y + h * 0.5;
      f.moveTo(kx, ky);
      f.quadraticCurveTo(kx + Math.sin(now * 0.004 + bl.ph) * 8, ky + h * 0.45, kx + Math.sin(now * 0.003 + bl.ph + 1) * 5, ky + h * 0.95);
      f.stroke();
      f.save();
      f.translate(x, y);
      f.rotate(rot);
      f.drawImage(this.balloon(bl.color, bl.ch), -w / 2, -h / 2, w, h);
      f.restore();
    }
    this.balloons.length = alive;
    return alive > 0;
  }

  /** 風船が割れる: 風船の色の破片と白い光が飛び散り、ポンと鳴る */
  pop(bl, now) {
    if (bl.cx == null) return;
    const q = this.quality(), n = Math.round(12 * q) + 4;
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n + Math.random() * 0.4, v = 180 + Math.random() * 240;
      this.bits.push({ kind: 'shard', t0: now, life: 700 + Math.random() * 300, x: bl.cx, y: bl.cy, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 700,
        size: bl.size * (0.1 + Math.random() * 0.12), rot: Math.random() * TAU, vr: (Math.random() - 0.5) * 16, color: bl.color });
    }
    this.bits.push({ kind: 'flash', t0: now, life: 260, x: bl.cx, y: bl.cy, size: bl.size * 1.4, color: bl.color });
    this.sfx?.pop?.(this._popIndex = ((this._popIndex ?? 0) + 1) % 8);
  }

  drawBits(now) {
    const f = this.fctx;
    let alive = 0;
    for (const p of this.bits) {
      const t = Math.max(0, (now - p.t0) / p.life);
      if (t >= 1) continue;
      this.bits[alive++] = p;
      const s = Math.max(0, now - p.t0) / 1000;
      const x = p.x + (p.vx ?? 0) * s, y = p.y + (p.vy ?? 0) * s + 0.5 * (p.g ?? 0) * s * s;
      const c = this.colorOf(p.color);
      if (p.kind === 'shard') {
        f.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        f.save();
        f.translate(x, y);
        f.rotate(p.rot + p.vr * s);
        f.fillStyle = c.col;
        f.fillRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.7);
        f.fillStyle = c.hi;
        f.fillRect(-p.size / 2, -p.size * 0.35, p.size, p.size * 0.22);
        f.restore();
      } else if (p.kind === 'drop') {
        f.globalAlpha = 1 - t;
        f.fillStyle = 'rgba(210,248,255,.95)';
        f.beginPath(); f.arc(x, y, p.size * (1 - 0.4 * t), 0, TAU); f.fill();
      } else if (p.kind === 'flash') {
        f.globalAlpha = (1 - t) * 0.9;
        const r = p.size * (0.4 + 0.8 * easeOut3(t));
        f.drawImage(this.sprite('glow', p.color), x - r, y - r, r * 2, r * 2);
      }
    }
    this.bits.length = alive;
    f.globalAlpha = 1;
    return alive > 0;
  }

  drawRings(now) {
    const f = this.fctx;
    let alive = 0;
    for (const r of this.rings) {
      const t = Math.max(0, (now - r.t0) / r.life);
      if (t >= 1) continue;
      this.rings[alive++] = r;
      const e = easeOut3(t), c = this.colorOf(r.color);
      f.globalAlpha = (1 - t) * 0.55;
      f.strokeStyle = c.rim;
      f.lineWidth = 14 * (1 - t) + 2;
      f.beginPath(); f.arc(r.x, r.y, 20 + r.r1 * e, 0, TAU); f.stroke();
      f.globalAlpha = (1 - t) * 0.3;
      f.strokeStyle = c.col;
      f.lineWidth = 30 * (1 - t) + 4;
      f.stroke();
    }
    this.rings.length = alive;
    f.globalAlpha = 1;
    return alive > 0;
  }

  /* =====================================================================
   * 1回だけ描いておく絵
   * ===================================================================== */

  /** 文字の書かれた風船（宝石と同じ、左上から光が当たる塗り） */
  balloon(color, ch) {
    const key = 'balloon:' + color + ':' + ch;
    let img = this.sprites.get(key);
    if (img) return img;
    const c = this.colorOf(color), S = 2, W = 64 * S, H = 80 * S;
    img = document.createElement('canvas');
    img.width = W; img.height = H;
    const g = img.getContext('2d');
    g.scale(S, S);
    // 本体
    const body = g.createRadialGradient(22, 22, 3, 32, 34, 36);
    body.addColorStop(0, c.hi);
    body.addColorStop(0.45, c.col);
    body.addColorStop(1, c.lo);
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(32, 66);
    g.bezierCurveTo(12, 58, 4, 42, 5, 30);
    g.bezierCurveTo(6, 13, 18, 3, 32, 3);
    g.bezierCurveTo(46, 3, 58, 13, 59, 30);
    g.bezierCurveTo(60, 42, 52, 58, 32, 66);
    g.fill();
    // ふちの明るい線（背景から浮かせる）
    g.strokeStyle = 'rgba(255,255,255,.35)';
    g.lineWidth = 1.2;
    g.stroke();
    // 結び目
    g.fillStyle = c.lo;
    g.beginPath(); g.moveTo(32, 64); g.lineTo(27.5, 71); g.lineTo(36.5, 71); g.closePath(); g.fill();
    // つや
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.beginPath(); g.ellipse(20, 19, 6.5, 9.5, -0.5, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.8)';
    g.beginPath(); g.ellipse(17.5, 14.5, 2.2, 3.2, -0.5, 0, TAU); g.fill();
    // 文字
    g.font = '900 31px Nunito, "M PLUS Rounded 1c", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.lineJoin = 'round';
    g.strokeStyle = 'rgba(40,20,90,.35)';
    g.lineWidth = 4;
    g.strokeText(ch, 32, 36);
    g.fillStyle = '#fff';
    g.fillText(ch, 32, 36);
    this.sprites.set(key, img);
    return img;
  }

  /**
   * 光の放射の絵（400px）: 中心から外へ向かって消えていく光の帯。中心の穴と外側の消え方まで描き込むので、
   * CSS の mask は使わない（mask は画面の合成を重くする）
   */
  burstImage(kind) {
    const key = 'burst:' + kind;
    if (this.sprites.has(key)) return this.sprites.get(key);
    const S = 400, R = S / 2, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const cols = { sea: ['rgba(200,250,255,'], gold: ['rgba(255,240,170,'], amazing: ['rgba(255,200,245,'],
      rainbow: ['rgba(255,120,150,', 'rgba(255,230,120,', 'rgba(120,240,255,'] }[kind] ?? ['rgba(255,255,255,'];
    const n = 18, w = (TAU / n) * 0.36;
    for (let i = 0; i < n; i++) {
      const c = cols[i % cols.length], a = (TAU * i) / n;
      const grd = g.createRadialGradient(R, R, 0, R, R, R);
      grd.addColorStop(0, c + '0)'); grd.addColorStop(0.08, c + '.55)'); grd.addColorStop(0.5, c + '.3)'); grd.addColorStop(1, c + '0)');
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(R, R); g.arc(R, R, R, a - w, a + w); g.closePath(); g.fill();
    }
    const url = cv.toDataURL();
    this.sprites.set(key, url);
    return url;
  }
  /** 虹色の絵（400px）: 色相の輪を、外側へ向かって透明にしたもの */
  rainbowImage() {
    if (this.sprites.has('rainbow')) return this.sprites.get('rainbow');
    const S = 400, R = S / 2, cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d');
    const hues = ['255,80,110', '255,176,40', '255,233,74', '77,230,136', '63,216,255', '120,110,255', '200,90,255'];
    const n = 84;
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n, c = hues[Math.floor((i / n) * hues.length)];
      const grd = g.createRadialGradient(R, R, 0, R, R, R);
      grd.addColorStop(0, `rgba(${c},.7)`); grd.addColorStop(0.45, `rgba(${c},.42)`); grd.addColorStop(1, `rgba(${c},0)`);
      g.fillStyle = grd;
      g.beginPath(); g.moveTo(R, R); g.arc(R, R, R, a, a + TAU / n + 0.02); g.closePath(); g.fill();
    }
    const url = cv.toDataURL();
    this.sprites.set('rainbow', url);
    return url;
  }

  /** ぼんやりした光（glow）と、4本の光の筋を持つ星（star） */
  sprite(kind, color) {
    const key = kind + ':' + color;
    let img = this.sprites.get(key);
    if (img) return img;
    const c = this.colorOf(color), S = 64, R = S / 2;
    img = document.createElement('canvas');
    img.width = img.height = S;
    const g = img.getContext('2d');
    const grd = g.createRadialGradient(R, R, 0, R, R, R);
    grd.addColorStop(0, 'rgba(255,255,255,.9)');
    grd.addColorStop(0.18, c.hi);
    grd.addColorStop(0.45, hexA(c.col, 0.35));
    grd.addColorStop(1, hexA(c.col, 0));
    g.fillStyle = grd;
    g.fillRect(0, 0, S, S);
    if (kind === 'star') {
      g.fillStyle = 'rgba(255,255,255,.9)';
      for (const [w, h] of [[2.4, R * 0.95], [R * 0.95, 2.4]]) {
        g.beginPath(); g.ellipse(R, R, w, h, 0, 0, TAU); g.fill();
      }
    }
    this.sprites.set(key, img);
    return img;
  }

  /** sprite を画像の URL にしたもの（DOM の背景に使う） */
  spriteUrl(kind, color) {
    const key = 'url:' + kind + ':' + color;
    let url = this.sprites.get(key);
    if (!url) { url = this.sprite(kind, color).toDataURL(); this.sprites.set(key, url); }
    return url;
  }

  /** 文字の風船の絵をフォントの読み込み後に作り直す（先に作ると別のフォントで描かれるため） */
  async warm() {
    try { await document.fonts?.load('900 31px Nunito'); } catch {}
    for (const k of [...this.sprites.keys()]) if (k.startsWith('balloon:')) this.sprites.delete(k);
  }
}

/** '#rrggbb' → 'rgba(r,g,b,a)' */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex).trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(255,255,255,${a})`;
}

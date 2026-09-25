/**
 * 画面全体の演出（シーン）。盤面の外側まで使う、大きな色の変化のための層。
 *
 *  - #sceneTint（奥）: 画面全体の色の変化。1回だけ描いた 400px の絵を拡大し、opacity と transform だけで動かす
 *  - #sceneFront（手前, 盤面の前）: 全消しの演出（海・シャボン玉・ガムボール・まんまる）、文字の風船や玉、はじけた粒
 *
 * 形はすべて丸（線・細長い光・光線は使わない）。色はブロックの7色と海の青緑だけ。
 * ぼんやり光る丸（光の玉・ぼかしの丸・フレア）は使わない（盤面の陰影と合わず浮いて見えるので）。
 * 何も動いていない間は requestAnimationFrame を止め、手前の canvas も描き直さない。
 */
const TAU = Math.PI * 2;
const RAINBOW = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
const easeIn3 = (t) => t * t * t;
const clamp01 = (t) => Math.max(0, Math.min(1, t));
/** 行き過ぎてから戻る（浮かび上がって止まる・ぽんと出てくる） */
const easeOutBack = (t, c = 1.4) => 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
/** 床で弾む（ガムボールが落ちて積もる） */
function easeOutBounce(t) {
  const n = 7.5625, d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75;
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375;
  return n * (t -= 2.625 / d) * t + 0.984375;
}

/** 海の色（上から: 水面の明るい青緑 → 中ほどの水色 → 深い青。背景の青と馴染む明るさ） */
const SEA = { surface: 'rgba(118,232,255,.93)', mid: 'rgba(40,178,236,.92)', deep: 'rgba(24,92,210,.95)', back: 'rgba(66,196,245,.6)' };
/** 「まんまる」の配色（どれもブロックの色の組み合わせ） */
const IRIS = [
  ['rgba(255,226,120,.97)', 'rgba(255,150,80,.96)', 'rgba(255,90,150,.96)'],       // 夕焼け
  ['rgba(150,245,215,.97)', 'rgba(60,210,255,.96)', 'rgba(70,110,255,.96)'],        // 南の海
  ['rgba(240,170,255,.97)', 'rgba(180,90,255,.96)', 'rgba(255,100,190,.96)'],       // ぶどう
];
const ALL_CLEAR_KINDS = ['sea', 'bubbles', 'gumballs', 'iris'];

export class Scenes {
  constructor({ sfx, colorOf } = {}) {
    this.sfx = sfx;
    this.colorOf = colorOf;                         // 色名 → { col, hi, lo, rim }
    this.frameMs = 16.7;                            // 演出を描いている間の1フレームの時間（なめらかに平均）
    this.lastNow = 0;
    this.reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const app = document.getElementById('app');
    const mk = (tag, id, before) => {
      const el = document.createElement(tag);
      el.id = id;
      if (before) document.body.insertBefore(el, before); else document.body.appendChild(el);
      return el;
    };
    this.tint = mk('div', 'sceneTint', app);
    // 盤面の前: まんまるの丸（DOM の丸を拡大するだけ）→ 海（解像度を下げた canvas）→ 文字や粒（canvas）の順に重ねる
    this.irisEl = mk('div', 'sceneIris');
    this.seaCanvas = mk('canvas', 'sceneSea');
    this.sctx = this.seaCanvas.getContext('2d');
    this.front = mk('canvas', 'sceneFront');
    this.fctx = this.front.getContext('2d');
    this.sprites = new Map();
    this.actors = [];        // 毎フレーム描くもの。draw(now) が false を返したら消える
    this.bits = [];          // はじけた粒・水しぶき（丸）
    this.raf = 0;
    this.gen = 0;
    this.last = null;        // 前回の全消しの演出（続けて同じものにしない）
    this.fit();
    window.addEventListener('resize', () => this.fit());
  }

  /**
   * 演出の量の目安（1 = 全部出す … 0.25 = 最小限）。演出を描いている間のフレーム時間から決める。
   * 遅い端末では自動で粒や層を減らし、画面がカクつかないようにする
   */
  quality() { return Math.max(0.25, Math.min(1, 1 - (this.frameMs - 20) / 26)); }

  fit() {
    const W = window.innerWidth, H = window.innerHeight;
    this.W = W; this.H = H;
    this.fdpr = Math.min(1.5, window.devicePixelRatio || 1);
    this.front.width = Math.round(W * this.fdpr); this.front.height = Math.round(H * this.fdpr);
    // 海はなめらかなグラデーションなので解像度 1 で十分（画面いっぱいを毎フレーム塗るので、画素が少ないほど軽い）
    this.seaCanvas.width = Math.round(W); this.seaCanvas.height = Math.round(H);
    this.dirty = true;
  }

  clear() {
    this.gen++;
    this.actors.length = this.bits.length = 0;
    this.fctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fctx.clearRect(0, 0, this.front.width, this.front.height);
    this.sctx.clearRect(0, 0, this.seaCanvas.width, this.seaCanvas.height);
    this._tintAnim?.cancel(); this._tintSpin?.cancel(); this._irisAnim?.cancel();
  }

  /* =====================================================================
   * 演出の組み合わせ
   * ===================================================================== */

  /**
   * 全消し: 4種類の演出から、前回と違うものを選ぶ（盤面の前に出る。ゲームは止めない。どれも約3.8秒）
   *  - sea      海が下からせり上がり、文字の風船が浮かんで割れ、海が引いていく
   *  - bubbles  虹色のシャボン玉がたくさん浮かび、文字のシャボン玉が割れて水滴になる
   *  - gumballs つやつやの玉が降ってきて弾みながら積もり、文字の玉が乗り、床が抜けて落ちていく
   *  - iris     盤面の中心から大きな丸が広がって画面が染まり、丸いシールの文字が弾んで出て、丸が縮んで戻る
   */
  allClear(center, kind) {
    const pool = ALL_CLEAR_KINDS.filter((k) => k !== this.last);
    kind ??= pool[Math.floor(Math.random() * pool.length)];
    this.last = kind;
    center ??= { x: this.W / 2, y: this.H * 0.5 };
    ({ sea: () => this.sea(), bubbles: () => this.bubbles(), gumballs: () => this.gumballs(), iris: () => this.iris(center) })[kind]();
    this.kick();
    return kind;
  }

  /** 新記録: 水色〜青紫に明るく染まり、風船の NEW BEST が浮かんで割れる */
  newBest() {
    this.wash('gold', 2600, 0.62);
    this.spell('NEW BEST', { style: 'balloon', at: 120, popAt: 1900, row: 0.3 });
    this.kick();
  }

  /** 大きな連鎖（褒め言葉が Amazing 以上）: 画面全体が段階の色に染まる。Unbelievable（tier 5）は虹色 */
  bigChain(tier) {
    const now = performance.now();
    if (now - (this._lastBig ?? -1e9) < 1100) return;       // 続けて重ならないように（長い連鎖で光りっぱなしにしない）
    this._lastBig = now;
    const kind = tier >= 5 ? 'rainbow' : 'amazing';
    // 画面いっぱいの半透明の層は、遅い端末では合成が重いので省く（演出の量 quality が下がっているとき）
    const q = this.quality();
    if (q >= 0.45) this.wash(kind, 1400, tier >= 5 ? 0.5 : 0.42);
  }

  /** コンボが5の倍数に届いた: 画面の下から桃〜青紫に染まる */
  comboWave() {
    if (this.quality() >= 0.45) this.wash('warm', 1500, 0.6);
  }

  /* =====================================================================
   * 全消し 1: 海
   * ===================================================================== */
  sea() {
    const t0 = performance.now(), gen = this.gen;
    const w = { t0, peak: 0.62, drainAt: 2750, end: 3850, ph: Math.random() * TAU, lastSplash: 0, bubbles: [] };
    this.wash('sea', 3400, 0.45);
    this.sfx?.wave?.();
    this.spell('ALL CLEAR', { style: 'balloon', at: 260, popAt: 2350, row: 0.2 });
    this.actors.push({ draw: (now) => gen === this.gen && this.drawSea(w, now) });
  }

  /** 海の水位（画面の高さに対する割合）。ばねのように行き過ぎて揺れ戻り、最後に引いていく */
  seaLevel(w, ms) {
    const p = ms / 1000;
    let lvl = w.peak * (1 - Math.exp(-4.5 * p) * Math.cos(6 * p));
    if (ms > w.drainAt) {
      const q = clamp01((ms - w.drainAt) / (w.end - w.drainAt - 100));
      lvl = lvl * (1 - easeIn3(q)) - 0.06 * q;
    }
    return lvl;
  }

  drawSea(w, now) {
    const ms = now - w.t0, f = this.sctx;
    f.clearRect(0, 0, this.seaCanvas.width, this.seaCanvas.height);
    if (ms > w.end) return false;
    const W = this.W, H = this.H, q = this.quality();
    const lvl = this.seaLevel(w, ms), prev = this.seaLevel(w, Math.max(0, ms - 16));
    const speed = Math.abs(lvl - prev) * 60;                  // 水位の変わる速さ（揺れの大きさに使う）
    const base = H * (1 - lvl), amp = 7 + Math.min(18, speed * 60), t = ms / 1000, step = 14;
    const surf = (x, off = 0, a = amp) => base + off
      + a * Math.sin(x * 0.018 + t * 2.6 + w.ph) + a * 0.55 * Math.sin(x * 0.041 - t * 3.7 + w.ph * 2);
    const fillWave = (off, a, style) => {
      f.beginPath();
      f.moveTo(0, H);
      for (let x = 0; x <= W + step; x += step) f.lineTo(x, surf(x, off, a) + (off ? 4 * Math.sin(x * 0.03 + t * 5) : 0));
      f.lineTo(W, H);
      f.closePath();
      f.fillStyle = style;
      f.fill();
    };
    // 奥の波（少し高く、薄い）と手前の海
    fillWave(-12, amp * 0.8, SEA.back);
    const top = base - amp * 1.6, g = f.createLinearGradient(0, top, 0, Math.max(top + 1, H));
    g.addColorStop(0, SEA.surface); g.addColorStop(0.28, SEA.mid); g.addColorStop(1, SEA.deep);
    fillWave(0, amp, g);

    // 水面の泡の列（白い線の代わりに、丸い泡が水面に沿って並ぶ）
    for (let x = 6; x <= W; x += 16) {
      const y = surf(x) + 1, r = 3 + 1.8 * Math.sin(x * 0.21 + t * 4);
      f.fillStyle = 'rgba(255,255,255,.75)';
      f.beginPath(); f.arc(x, y, Math.max(1.2, r), 0, TAU); f.fill();
    }

    // 泡: 水の中で生まれて、ゆらゆら上がり、水面で消える
    if (lvl > 0.05 && Math.random() < 0.8 * q) w.bubbles.push({ x: Math.random() * W, y: H + 10, r: 2 + Math.random() * 5, v: 70 + Math.random() * 110, ph: Math.random() * TAU, t0: now });
    let alive = 0;
    for (const bb of w.bubbles) {
      const s = (now - bb.t0) / 1000, y = bb.y - bb.v * s, x = bb.x + Math.sin(bb.ph + s * 4) * 6;
      if (y < surf(x) + bb.r) continue;
      w.bubbles[alive++] = bb;
      f.drawImage(this.bubble(), x - bb.r, y - bb.r, bb.r * 2, bb.r * 2);
    }
    w.bubbles.length = alive;

    // 勢いよく上がった直後の水しぶき（丸い水滴）
    if (speed > 0.02 && now - w.lastSplash > 70 && q >= 0.4) {
      w.lastSplash = now;
      for (let k = 0; k < 3; k++) {
        const x = Math.random() * W;
        this.bits.push({ kind: 'drop', t0: now, life: 650, x, y: surf(x), vx: (Math.random() - 0.5) * 120, vy: -(160 + Math.random() * 220), g: 900, size: 3 + Math.random() * 3 });
      }
    }
    return true;
  }

  /* =====================================================================
   * 全消し 2: シャボン玉
   * ===================================================================== */
  bubbles() {
    const t0 = performance.now(), gen = this.gen, q = this.quality();
    this.wash('bubble', 3500, 0.5);
    this.sfx?.bubbles?.();
    const list = [];
    const n = Math.round(46 * q) + 10;
    for (let i = 0; i < n; i++) {
      const r = 10 + Math.pow(Math.random(), 1.8) * 48;
      list.push({ x: Math.random() * this.W, r, t0: t0 + Math.random() * 2600, v: 90 + (60 - r) * 2.2 + Math.random() * 60,
        wob: 8 + Math.random() * 14, ph: Math.random() * TAU, popY: Math.random() < 0.3 ? this.H * (0.15 + Math.random() * 0.5) : -1e9 });
    }
    this.actors.push({ draw: (now) => gen === this.gen && this.drawBubbles(list, now) });
    this.spell('ALL CLEAR', { style: 'bubble', at: 180, popAt: 2400, row: 0.3 });
  }

  drawBubbles(list, now) {
    const f = this.fctx, H = this.H;
    let alive = 0;
    for (const b of list) {
      const s = (now - b.t0) / 1000;
      if (s < 0) { list[alive++] = b; continue; }
      const y = H + b.r - b.v * s, x = b.x + Math.sin(b.ph + s * 2.4) * b.wob;
      if (y < -b.r) continue;
      if (y < b.popY) { this.splash(x, y, b.r, 'cyan'); this.sfx?.blip?.(); continue; }   // ときどき途中でぱちんと割れる
      list[alive++] = b;
      const sq = 1 + 0.05 * Math.sin(s * 5 + b.ph);            // ふるふると形が揺れる
      f.drawImage(this.bubble(), x - b.r * sq, y - b.r / sq, b.r * 2 * sq, (b.r * 2) / sq);
    }
    list.length = alive;
    return alive > 0;
  }

  /* =====================================================================
   * 全消し 3: ガムボール
   * ===================================================================== */
  gumballs() {
    const t0 = performance.now(), gen = this.gen, q = this.quality(), W = this.W, H = this.H;
    this.wash('candy', 3600, 0.4);
    const R = Math.max(14, Math.min(30, W / 14)), dy = R * 1.72;
    const rows = Math.max(3, Math.round((H * 0.34) / dy)), balls = [];
    for (let row = 0; row < rows; row++) {
      const off = row % 2 ? R : 0;
      for (let x = R + off; x <= W - R + 1; x += R * 2) {
        if (q < 0.6 && Math.random() < 0.35) continue;
        balls.push({ x: x + (Math.random() - 0.5) * 2, y: H - R - row * dy, r: R * (0.92 + Math.random() * 0.1),
          color: RAINBOW[Math.floor(Math.random() * RAINBOW.length)], t0: t0 + row * 150 + Math.random() * 180,
          from: -R - Math.random() * H * 0.3, dur: 620 + Math.random() * 220, landed: false });
      }
    }
    const top = H - R - rows * dy;                            // 積もった玉のいちばん上
    const exitAt = t0 + 2750;
    this.actors.push({ draw: (now) => gen === this.gen && this.drawGumballs(balls, now, exitAt) });
    this.spell('ALL CLEAR', { style: 'ball', at: 700 + rows * 60, popAt: 2450, row: (top - R * 1.1) / H, drop: true });
    this.sfx?.rattle?.();
  }

  drawGumballs(balls, now, exitAt) {
    const f = this.fctx, H = this.H;
    let alive = 0, landedNow = 0;
    for (const b of balls) {
      if (now < b.t0) { balls[alive++] = b; continue; }
      let y;
      const p = clamp01((now - b.t0) / b.dur);
      y = b.from + (b.y - b.from) * easeOutBounce(p);
      if (p >= 1 && !b.landed) { b.landed = true; landedNow++; }
      if (now > exitAt) {                                    // 床が抜けて、左右の端から順に落ちていく
        const s = (now - exitAt - Math.abs(b.x - this.W / 2) * 0.6) / 1000;
        if (s > 0) y = b.y + 0.5 * 2600 * s * s;
      }
      if (y - b.r > H) continue;
      balls[alive++] = b;
      f.drawImage(this.ball(b.color), b.x - b.r, y - b.r, b.r * 2, b.r * 2);
    }
    balls.length = alive;
    if (landedNow) this.sfx?.tick?.(landedNow);
    return alive > 0;
  }

  /* =====================================================================
   * 全消し 4: まんまる（盤面の中心から丸が広がって画面が染まる）
   * ===================================================================== */
  iris(center) {
    const t0 = performance.now(), gen = this.gen, q = this.quality();
    const theme = IRIS[Math.floor(Math.random() * IRIS.length)];
    const rMax = Math.hypot(Math.max(center.x, this.W - center.x), Math.max(center.y, this.H - center.y)) + 30;
    // 大きな丸は 400px の DOM の丸を拡大するだけ（毎フレーム描き直さない）
    const el = this.irisEl, k = rMax / 200;
    el.style.background = `radial-gradient(circle,${theme[0]} 0,${theme[1]} 45%,${theme[2]} 100%)`;
    const at = (sc) => `translate(${center.x - 200}px,${center.y - 200}px) scale(${sc * k})`;
    this._irisAnim?.cancel();
    this._irisAnim = el.animate([
      { transform: at(0), easing: 'cubic-bezier(.3,1.35,.5,1)' },
      { transform: at(1), offset: 700 / 3650 },
      { transform: at(1.015), offset: 1500 / 3650 },
      { transform: at(1), offset: 2950 / 3650, easing: 'cubic-bezier(.55,0,.9,.4)' },
      { transform: at(0) },
    ], { duration: 3650 });
    const dots = Array.from({ length: Math.round(34 * q) + 8 }, (_, i) => ({
      a: Math.random() * TAU, r0: 20 + Math.random() * 60, v: 0.6 + Math.random() * 0.9, size: 3 + Math.random() * 7,
      color: i % 3 ? RAINBOW[i % RAINBOW.length] : 'white', t0: t0 + 250 + Math.random() * 1600,
    }));
    const it = { t0, cx: center.x, cy: center.y, dots, rMax };
    this.sfx?.swoosh?.();
    setTimeout(() => { if (gen === this.gen) this.sfx?.swoosh?.(true); }, 2950);
    this.actors.push({ draw: (now) => gen === this.gen && this.drawIris(it, now) });
    this.spell('ALL CLEAR', { style: 'sticker', at: 420, popAt: 2350, row: Math.max(0.22, (center.y - 110) / this.H) });
  }

  /** 丸の半径（DOM の丸のアニメーションと同じ動き。水玉をこの丸の中だけに描くため） */
  irisRadius(it, ms) {
    if (ms < 700) return it.rMax * easeOutBack(clamp01(ms / 700), 1.1);
    if (ms < 2950) return it.rMax;
    return it.rMax * (1 - easeIn3(clamp01((ms - 2950) / 650)));
  }

  /** くるくる外へ広がる水玉（丸の中だけ） */
  drawIris(it, now) {
    const ms = now - it.t0;
    if (ms > 3650) return false;
    const f = this.fctx, R = Math.max(0, this.irisRadius(it, ms));
    if (R < 1) return ms < 700;
    for (const d of it.dots) {
      const s = (now - d.t0) / 1000;
      if (s < 0 || s > 2.2) continue;
      const r = d.r0 + s * 140 * d.v, a = d.a + s * 1.4 * d.v;
      if (r > R) continue;
      const x = it.cx + Math.cos(a) * r, y = it.cy + Math.sin(a) * r * 0.9;
      f.globalAlpha = Math.min(1, s * 4) * (1 - s / 2.2);
      f.fillStyle = d.color === 'white' ? 'rgba(255,255,255,.95)' : this.colorOf(d.color).hi;
      f.beginPath(); f.arc(x, y, d.size, 0, TAU); f.fill();
    }
    f.globalAlpha = 1;
    return true;
  }

  /* =====================================================================
   * 文字（風船・シャボン玉・ガムボール・丸いシール）
   * ===================================================================== */

  /**
   * 文字を1つずつ丸いもの（style）にして並べる。空白は間を空ける。at ms 後から少しずつずらして出し、
   * popAt ms 後から左から順にはじける。row は止まる高さ（画面の上からの割合）。drop なら上から落ちてくる
   */
  spell(text, { style = 'balloon', at = 0, popAt = 2000, row = 0.22, drop = false } = {}) {
    const now = performance.now(), gen = this.gen;
    const chars = [...text];
    const slot = Math.min(50, (Math.min(this.W, 560) - 24) / chars.length);
    const x0 = this.W / 2 - (slot * chars.length) / 2 + slot / 2;
    const items = [];
    let k = 0;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      items.push({
        ch, color: RAINBOW[(k * 2 + 1) % RAINBOW.length], x: x0 + i * slot, size: slot * (style === 'balloon' ? 0.96 : 0.9),
        yT: this.H * row + (k % 2 ? 8 : -6), t0: now + at + k * 70, popAt: now + popAt + k * 85, ph: Math.random() * TAU, k,
      });
      k++;
    });
    this.actors.push({ draw: (t) => gen === this.gen && this.drawLetters(items, style, drop, t) });
    this.kick();
  }

  drawLetters(items, style, drop, now) {
    const f = this.fctx, H = this.H;
    let alive = 0;
    for (const it of items) {
      if (now >= it.popAt) { this.popLetter(it, style, now); continue; }
      items[alive++] = it;
      if (now < it.t0) continue;
      const t = clamp01((now - it.t0) / (style === 'sticker' ? 520 : drop ? 720 : 1250));
      const bob = Math.sin(now * 0.0032 + it.ph) * 4 * t;
      let x = it.x + Math.sin(now * 0.0021 + it.ph) * 3, y, sc = 1;
      if (style === 'sticker') { y = it.yT + bob; sc = easeOutBack(t, 2.2); }                 // その場でぽんと出る
      else if (drop) y = -it.size + (it.yT + it.size) * easeOutBounce(t);                   // 上から落ちて弾む
      else y = H + it.size + (it.yT - H - it.size) * easeOutBack(t) + bob;                  // 下から浮かんでくる
      if (drop) x = it.x;
      it.cx = x; it.cy = y;
      const w = it.size * sc;
      if (style === 'balloon') {
        const h = w * 1.25;
        // ひもの代わりに、小さな丸が3つ連なってぶら下がる
        for (let j = 1; j <= 3; j++) {
          const sw = Math.sin(now * 0.004 + it.ph + j * 0.6) * 3 * j;
          f.fillStyle = `rgba(255,255,255,${0.75 - j * 0.15})`;
          f.beginPath(); f.arc(x + sw, y + h * 0.52 + j * w * 0.16, w * (0.07 - j * 0.012), 0, TAU); f.fill();
        }
        f.drawImage(this.balloon(it.color, it.ch), x - w / 2, y - h / 2, w, h);
      } else if (style === 'bubble') {
        f.drawImage(this.letterBubble(it.color, it.ch), x - w / 2, y - w / 2, w, w);
      } else if (style === 'ball') {
        f.drawImage(this.letterBall(it.color, it.ch), x - w / 2, y - w / 2, w, w);
      } else {
        f.drawImage(this.sticker(it.color, it.ch), x - w / 2, y - w / 2, w, w);
      }
    }
    items.length = alive;
    return alive > 0;
  }

  /** 文字がはじける: 丸い粒が飛び散り、ふわっと光り、ポンと鳴る（割れるごとに音が上がる） */
  popLetter(it, style, now) {
    if (it.cx == null) return;
    this.splash(it.cx, it.cy, it.size * 0.5, style === 'bubble' ? 'cyan' : it.color, style === 'bubble');
    this.sfx?.pop?.(it.k);
  }

  /** 丸い粒をはじけさせる（water なら水滴、そうでなければ色の粒） */
  splash(x, y, r, color, water = false) {
    const now = performance.now(), n = Math.round(10 * this.quality()) + 4;
    for (let i = 0; i < n; i++) {
      const a = (TAU * i) / n + Math.random() * 0.4, v = 140 + Math.random() * 200 + r * 3;
      this.bits.push({ kind: water ? 'drop' : 'bead', t0: now, life: 650 + Math.random() * 300, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 700,
        size: Math.max(2, r * (0.12 + Math.random() * 0.12)), color });
    }
    this.kick();
  }

  /* =====================================================================
   * 部品（奥の層）
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

  /* =====================================================================
   * 描画ループ
   * ===================================================================== */
  kick() { if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t)); }

  frame(now) {
    this.raf = 0;
    // 1回だけの大きな引っかかり（手駒の計算・タブの切り替えなど）は数えない。続けて遅いときだけ減らす
    if (this.lastNow) { const dt = now - this.lastNow; if (dt < 100) this.frameMs += (dt - this.frameMs) * 0.08; }
    this.lastNow = now;
    now = Math.max(now, performance.now() - 1);        // rAF の時刻はフレームの始まりなので、直前に作った演出より前になることがある
    const f = this.fctx;
    // 前のフレームで何か描いたときだけ消す（何も無い canvas を毎フレーム消すと、それだけで画面全体の描き直しになる）
    f.setTransform(1, 0, 0, 1, 0, 0);
    if (this.dirty) f.clearRect(0, 0, this.front.width, this.front.height);
    f.setTransform(this.fdpr, 0, 0, this.fdpr, 0, 0);
    let alive = 0;
    for (const a of this.actors) if (a.draw(now)) this.actors[alive++] = a;
    this.actors.length = alive;
    const bits = this.drawBits(now);
    f.globalAlpha = 1;
    f.globalCompositeOperation = 'source-over';
    this.dirty = alive > 0 || bits;
    if (this.dirty) this.raf = requestAnimationFrame((t) => this.frame(t));
    else this.lastNow = 0;
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
      if (p.kind === 'bead') {                                  // 色の丸い粒（つやつや）
        f.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
        const r = p.size * (1 - 0.3 * t);
        f.drawImage(this.ball(p.color), x - r, y - r, r * 2, r * 2);
      } else if (p.kind === 'drop') {                           // 水滴
        f.globalAlpha = 1 - t;
        f.fillStyle = 'rgba(214,250,255,.95)';
        f.beginPath(); f.arc(x, y, Math.max(0.5, p.size * (1 - 0.4 * t)), 0, TAU); f.fill();
      }
    }
    this.bits.length = alive;
    f.globalAlpha = 1;
    return alive > 0;
  }

  /* =====================================================================
   * 1回だけ描いておく絵
   * ===================================================================== */

  cached(key, make) {
    let img = this.sprites.get(key);
    if (!img) { img = make(); this.sprites.set(key, img); }
    return img;
  }
  canvas(w, h = w) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }

  /** 宝石と同じ、左上から光が当たる丸い塗り */
  gem(g, cx, cy, r, c) {
    const body = g.createRadialGradient(cx - r * 0.32, cy - r * 0.36, r * 0.08, cx, cy, r);
    body.addColorStop(0, c.hi); body.addColorStop(0.5, c.col); body.addColorStop(1, c.lo);
    g.fillStyle = body;
    g.beginPath(); g.arc(cx, cy, r, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.55)';
    g.beginPath(); g.ellipse(cx - r * 0.38, cy - r * 0.42, r * 0.22, r * 0.32, -0.6, 0, TAU); g.fill();
    g.fillStyle = 'rgba(255,255,255,.85)';
    g.beginPath(); g.arc(cx - r * 0.45, cy - r * 0.52, r * 0.08, 0, TAU); g.fill();
  }
  letter(g, ch, cx, cy, size, fill = '#fff', stroke = 'rgba(40,20,90,.35)') {
    g.font = `900 ${size}px Nunito, "M PLUS Rounded 1c", sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle'; g.lineJoin = 'round';
    g.strokeStyle = stroke; g.lineWidth = size * 0.13;
    g.strokeText(ch, cx, cy);
    g.fillStyle = fill;
    g.fillText(ch, cx, cy);
  }

  /** 文字の書かれた風船 */
  balloon(color, ch) {
    return this.cached('balloon:' + color + ':' + ch, () => {
      const c = this.colorOf(color), S = 2, img = this.canvas(64 * S, 80 * S), g = img.getContext('2d');
      g.scale(S, S);
      const body = g.createRadialGradient(22, 22, 3, 32, 34, 36);
      body.addColorStop(0, c.hi); body.addColorStop(0.45, c.col); body.addColorStop(1, c.lo);
      g.fillStyle = body;
      g.beginPath();
      g.moveTo(32, 66);
      g.bezierCurveTo(12, 58, 4, 42, 5, 30);
      g.bezierCurveTo(6, 13, 18, 3, 32, 3);
      g.bezierCurveTo(46, 3, 58, 13, 59, 30);
      g.bezierCurveTo(60, 42, 52, 58, 32, 66);
      g.fill();
      g.fillStyle = c.lo;                                      // 結び目（丸）
      g.beginPath(); g.arc(32, 67, 3.2, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.beginPath(); g.ellipse(20, 19, 6.5, 9.5, -0.5, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.beginPath(); g.ellipse(17.5, 14.5, 2.2, 3.2, -0.5, 0, TAU); g.fill();
      this.letter(g, ch, 32, 36, 31);
      return img;
    });
  }

  /** シャボン玉: 中は透明で、ふちが虹色にうっすら光る。左上に窓の映り込み */
  bubble() {
    return this.cached('bubble', () => {
      const S = 128, R = S / 2, img = this.canvas(S), g = img.getContext('2d');
      const body = g.createRadialGradient(R, R, R * 0.2, R, R, R);
      body.addColorStop(0, 'rgba(255,255,255,.04)'); body.addColorStop(0.7, 'rgba(255,255,255,.1)');
      body.addColorStop(0.86, 'rgba(170,240,255,.5)'); body.addColorStop(0.94, 'rgba(255,190,245,.65)'); body.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = body;
      g.beginPath(); g.arc(R, R, R, 0, TAU); g.fill();
      // 虹色のうつろい（片側だけ黄緑、反対側は桃色）
      const iri = g.createLinearGradient(0, S, S, 0);
      iri.addColorStop(0, 'rgba(255,240,120,.22)'); iri.addColorStop(0.5, 'rgba(255,255,255,0)'); iri.addColorStop(1, 'rgba(120,200,255,.22)');
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = iri; g.fillRect(0, 0, S, S);
      g.globalCompositeOperation = 'source-over';
      g.fillStyle = 'rgba(255,255,255,.8)';
      g.beginPath(); g.ellipse(R * 0.62, R * 0.55, R * 0.16, R * 0.24, -0.7, 0, TAU); g.fill();
      g.fillStyle = 'rgba(255,255,255,.45)';
      g.beginPath(); g.arc(R * 1.38, R * 1.42, R * 0.08, 0, TAU); g.fill();
      return img;
    });
  }
  /** 文字の入ったシャボン玉（文字はブロックの色） */
  letterBubble(color, ch) {
    return this.cached('lbubble:' + color + ':' + ch, () => {
      const S = 128, img = this.canvas(S), g = img.getContext('2d');
      g.drawImage(this.bubble(), 0, 0, S, S);
      const c = this.colorOf(color);
      this.letter(g, ch, S / 2, S / 2 + 3, 62, c.col, 'rgba(255,255,255,.95)');
      return img;
    });
  }
  /** つやつやのガムボール */
  ball(color) {
    return this.cached('ball:' + color, () => {
      const S = 96, img = this.canvas(S), g = img.getContext('2d');
      this.gem(g, S / 2, S / 2, S / 2 - 1, this.colorOf(color));
      return img;
    });
  }
  /** 文字の入ったガムボール */
  letterBall(color, ch) {
    return this.cached('lball:' + color + ':' + ch, () => {
      const S = 128, img = this.canvas(S), g = img.getContext('2d');
      this.gem(g, S / 2, S / 2, S / 2 - 2, this.colorOf(color));
      this.letter(g, ch, S / 2, S / 2 + 4, 66);
      return img;
    });
  }
  /** 丸いシール: 白い丸に、ブロックの色の文字。ふちはブロックの色でふっくら */
  sticker(color, ch) {
    return this.cached('sticker:' + color + ':' + ch, () => {
      const S = 128, R = S / 2, img = this.canvas(S), g = img.getContext('2d'), c = this.colorOf(color);
      g.fillStyle = 'rgba(40,20,90,.18)';                      // 下にうっすら影
      g.beginPath(); g.arc(R, R + 5, R - 6, 0, TAU); g.fill();
      g.fillStyle = c.col;
      g.beginPath(); g.arc(R, R, R - 6, 0, TAU); g.fill();
      const face = g.createRadialGradient(R - 14, R - 18, 6, R, R, R - 13);
      face.addColorStop(0, '#fff'); face.addColorStop(1, '#f1f4ff');
      g.fillStyle = face;
      g.beginPath(); g.arc(R, R, R - 13, 0, TAU); g.fill();
      this.letter(g, ch, R, R + 3, 64, c.col, 'rgba(255,255,255,.9)');
      return img;
    });
  }

  /**
   * 虹色の絵（400px）: なめらかな色相の輪を、外側へ向かって透明にしたもの。
   * 扇形を並べるとつなぎ目が放射状の線に見えるので、conic グラデーション 1 枚で描き、丸いグラデーションで抜く
   */
  rainbowImage() {
    return this.cached('rainbow', () => {
      const S = 400, R = S / 2, cv = this.canvas(S), g = cv.getContext('2d');
      // 黄・橙は背景の青と混ざると灰色に濁るので、水色〜青緑〜青紫〜桃の範囲で1周させる
      const hues = ['63,216,255', '90,235,210', '110,160,255', '160,110,255', '225,100,235', '255,110,180', '63,216,255'];
      if (g.createConicGradient) {
        const cg = g.createConicGradient(0, R, R);
        hues.forEach((c, i) => cg.addColorStop(i / (hues.length - 1), `rgb(${c})`));
        g.fillStyle = cg;
      } else {
        const lg = g.createLinearGradient(0, 0, S, S);                   // conic が無い環境: 斜めの虹
        hues.forEach((c, i) => lg.addColorStop(i / (hues.length - 1), `rgb(${c})`));
        g.fillStyle = lg;
      }
      g.fillRect(0, 0, S, S);
      g.globalCompositeOperation = 'destination-in';
      const fade = g.createRadialGradient(R, R, 0, R, R, R);
      fade.addColorStop(0, 'rgba(0,0,0,.7)'); fade.addColorStop(0.45, 'rgba(0,0,0,.42)'); fade.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = fade;
      g.fillRect(0, 0, S, S);
      return cv.toDataURL();
    });
  }

  /** 文字の絵をフォントの読み込み後に作り直す（先に作ると別のフォントで描かれるため） */
  async warm() {
    try { await document.fonts?.load('900 31px Nunito'); } catch {}
    for (const k of [...this.sprites.keys()]) if (/^(balloon|lbubble|lball|sticker):/.test(k)) this.sprites.delete(k);
  }
}


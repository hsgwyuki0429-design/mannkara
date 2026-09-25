/**
 * 画面全体の演出（シーン）。盤面の外側まで使う、大きな色の変化のための層。
 *
 *  - #sceneTint（奥, 盤面の後ろ）: 画面全体の色の変化。1回だけ描いた 400px の絵を拡大し、opacity と transform だけで動かす
 *    （新記録・大きな連鎖・コンボで使う）
 *  - #sceneFront（手前, 盤面の前）: 新記録で浮かぶ文字の風船と、はじけた粒
 *
 * 全消しは画面を覆う演出を使わない（盤面の中だけ。renderer.allClearBlast）。
 * 形はすべて丸（線・細長い光・光線は使わない）。色はブロックの7色。
 * ぼんやり光る丸（光の玉・ぼかしの丸・フレア）は使わない（盤面の陰影と合わず浮いて見えるので）。
 * 何も動いていない間は requestAnimationFrame を止め、手前の canvas も描き直さない。
 */
const TAU = Math.PI * 2;
const RAINBOW = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
const clamp01 = (t) => Math.max(0, Math.min(1, t));
/** 行き過ぎてから戻る（浮かび上がって止まる） */
const easeOutBack = (t, c = 1.4) => 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);

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
    // 盤面の前: 新記録の風船と、はじけた粒
    this.front = mk('canvas', 'sceneFront');
    this.fctx = this.front.getContext('2d');
    this.sprites = new Map();
    this.actors = [];        // 毎フレーム描くもの。draw(now) が false を返したら消える
    this.bits = [];          // はじけた粒（丸）
    this.raf = 0;
    this.gen = 0;
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
    this.dirty = true;
  }

  clear() {
    this.gen++;
    this.actors.length = this.bits.length = 0;
    this.fctx.setTransform(1, 0, 0, 1, 0, 0);
    this.fctx.clearRect(0, 0, this.front.width, this.front.height);
    this._tintAnim?.cancel(); this._tintSpin?.cancel();
  }

  /* =====================================================================
   * 演出の組み合わせ
   * ===================================================================== */

  /** 新記録: 水色〜青紫に明るく染まり、風船の NEW BEST が浮かんで割れる */
  newBest() {
    this.wash('gold', 2600, 0.62);
    this.spell('NEW BEST', { at: 120, popAt: 1900, row: 0.3 });
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
   * 文字（新記録の風船）
   * ===================================================================== */

  /**
   * 文字を1つずつ風船にして、下からふわっと浮かんで並ぶ。空白は間を空ける。
   * at ms 後から少しずつずらして出し、popAt ms 後から左から順にはじける。row は止まる高さ（画面の上からの割合）
   */
  spell(text, { at = 0, popAt = 2000, row = 0.22 } = {}) {
    const now = performance.now(), gen = this.gen;
    const chars = [...text];
    const slot = Math.min(50, (Math.min(this.W, 560) - 24) / chars.length);
    const x0 = this.W / 2 - (slot * chars.length) / 2 + slot / 2;
    const items = [];
    let k = 0;
    chars.forEach((ch, i) => {
      if (ch === ' ') return;
      items.push({
        ch, color: RAINBOW[(k * 2 + 1) % RAINBOW.length], x: x0 + i * slot, size: slot * 0.96,
        yT: this.H * row + (k % 2 ? 8 : -6), t0: now + at + k * 70, popAt: now + popAt + k * 85, ph: Math.random() * TAU, k,
      });
      k++;
    });
    this.actors.push({ draw: (t) => gen === this.gen && this.drawLetters(items, t) });
    this.kick();
  }

  drawLetters(items, now) {
    const f = this.fctx, H = this.H;
    let alive = 0;
    for (const it of items) {
      if (now >= it.popAt) { this.popLetter(it, now); continue; }
      items[alive++] = it;
      if (now < it.t0) continue;
      const t = clamp01((now - it.t0) / 1250);
      const bob = Math.sin(now * 0.0032 + it.ph) * 4 * t;
      const x = it.x + Math.sin(now * 0.0021 + it.ph) * 3;
      const y = H + it.size + (it.yT - H - it.size) * easeOutBack(t) + bob;                  // 下から浮かんでくる
      it.cx = x; it.cy = y;
      const w = it.size, h = w * 1.25;
      // ひもの代わりに、小さな丸が3つ連なってぶら下がる
      for (let j = 1; j <= 3; j++) {
        const sw = Math.sin(now * 0.004 + it.ph + j * 0.6) * 3 * j;
        f.fillStyle = `rgba(255,255,255,${0.75 - j * 0.15})`;
        f.beginPath(); f.arc(x + sw, y + h * 0.52 + j * w * 0.16, w * (0.07 - j * 0.012), 0, TAU); f.fill();
      }
      f.drawImage(this.balloon(it.color, it.ch), x - w / 2, y - h / 2, w, h);
    }
    items.length = alive;
    return alive > 0;
  }

  /** 風船がはじける: 丸い粒が飛び散り、ポンと鳴る（割れるごとに音が上がる） */
  popLetter(it, now) {
    if (it.cx == null) return;
    this.splash(it.cx, it.cy, it.size * 0.5, it.color);
    this.sfx?.pop?.(it.k);
  }

  /** 丸い粒（風船が割れたときの紙吹雪）をはじけさせる */
  splash(x, y, r, color) {
    const n = Math.round(10 * this.quality()) + 4;
    for (let i = 0; i < n; i++) {
      const now = performance.now();
      const a = (TAU * i) / n + Math.random() * 0.4, v = 140 + Math.random() * 200 + r * 3;
      this.bits.push({ t0: now, life: 650 + Math.random() * 300, x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 60, g: 700,
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
    for (const p of this.bits) {                                // 色の丸い粒（つやつや、風船が割れたときの紙吹雪）
      const t = Math.max(0, (now - p.t0) / p.life);
      if (t >= 1) continue;
      this.bits[alive++] = p;
      const s = Math.max(0, now - p.t0) / 1000;
      const x = p.x + (p.vx ?? 0) * s, y = p.y + (p.vy ?? 0) * s + 0.5 * (p.g ?? 0) * s * s;
      f.globalAlpha = t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4;
      const r = p.size * (1 - 0.3 * t);
      f.drawImage(this.ball(p.color), x - r, y - r, r * 2, r * 2);
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

  /** つやつやの丸（風船が割れたときの紙吹雪） */
  ball(color) {
    return this.cached('ball:' + color, () => {
      const S = 96, img = this.canvas(S), g = img.getContext('2d');
      this.gem(g, S / 2, S / 2, S / 2 - 1, this.colorOf(color));
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
    for (const k of [...this.sprites.keys()]) if (/^balloon:/.test(k)) this.sprites.delete(k);
  }
}


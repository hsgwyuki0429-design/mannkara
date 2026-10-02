/**
 * 背景の色。ベースは今の青（styles.css の --bg / --bg-hi）。コンボ・連鎖・全消し・新記録で色が変わる。
 *
 * 白い文字・ボタン・スコアの色は変えないので、どの色になっても読めるように「明るさ」は今の青にそろえる
 * （OKLCH の L を固定して、色相だけをぐるりと回す。白との対比は、縁で 6〜7、中央の明るい所でも 5 前後。淡い段でも 4.3 以上）。
 * そのうえで、同じ色相の「淡い（soft）」「濃い（deep）」の2段を足す。
 *
 * 動かすのは opacity だけ: 色ごとに全面のグラデーションの層を1枚作り、新しい色の層を上に重ねて opacity 0 → 1
 * （合成だけで済み、毎フレームの描き直しは起きない）。遠い色へのグラデーションは、近い色どうしの小さな重ねを続けて行う
 * （遠い色を一度に混ぜると、間の色が灰色に濁るので）。「一気に変わる」ときは、短い重ね 1 回。
 */
const RAD = Math.PI / 180;
const lin = (v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const gam = (v) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const clamp01 = (v) => Math.min(1, Math.max(0, v));

/** '#rrggbb' → OKLCH（L = 明るさ, C = 鮮やかさ, h = 色相°） */
export function hexToOklch(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { L: 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s, C: Math.hypot(a, bb), h: (Math.atan2(bb, a) / RAD + 360) % 360 };
}

function oklchToLinear(L, C, h) {
  const a = C * Math.cos(h * RAD), b = C * Math.sin(h * RAD);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
const inGamut = (c) => c.every((v) => v >= -0.0005 && v <= 1.0005);

/** OKLCH → [r, g, b]（0〜255）。sRGB に収まらない鮮やかさは、明るさと色相を保ったまま収まるまで縮める */
export function oklchToRgb(L, C, h) {
  let c = oklchToLinear(L, C, h);
  if (!inGamut(c)) {
    let lo = 0, hi = C;
    for (let i = 0; i < 22; i++) { const mid = (lo + hi) / 2; if (inGamut(oklchToLinear(L, mid, h))) lo = mid; else hi = mid; }
    c = oklchToLinear(L, lo, h);
  }
  return c.map((v) => Math.round(clamp01(gam(clamp01(v))) * 255));
}
const toHex = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');
export const oklchToHex = (L, C, h) => toHex(oklchToRgb(L, C, h));

/** 白い文字との対比（WCAG のコントラスト比。大きい文字は 3、小さい文字は 4.5 以上が目安） */
export function contrastWithWhite(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 1.05 / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
}

export const wrapHue = (h) => ((h % 360) + 360) % 360;
/** from から to へ、近い方まわりで進む角度（-180〜180） */
export const hueDelta = (from, to) => ((((to - from) % 360) + 540) % 360) - 180;

/** 今の背景（styles.css の --bg と --bg-hi）。ここから明るさ・鮮やかさ・色相を読み取って、同じ明るさの色を作る */
export const ORIGIN = { lo: '#2451c4', hi: '#2e60d6' };
const O = hexToOklch(ORIGIN.lo), OH = hexToOklch(ORIGIN.hi);
export const BASE_HUE = O.h;
/** 3段の濃さ。base = 今の青と同じ明るさ / soft = 少し淡い / deep = 濃い。up = 中央の明るい所の明るさの差 */
export const TONES = {
  base: { L: O.L, C: O.C, up: OH.L - O.L },
  soft: { L: O.L + 0.045, C: O.C * 0.85, up: 0.035 },
  deep: { L: O.L - 0.083, C: O.C * 0.9, up: 0.04 },
};
/** 中央の明るい所でも、白い小さな文字（ラインの番号など）が読める下限 */
export const MIN_CONTRAST = 4.3;

const looks = new Map();
/** 色相 hue・濃さ tone の背景の色 { hue, tone, lo, hi, glow }。lo = 縁の色, hi = 中央の明るい色, glow = 同系色の明るい重ね色（'r,g,b'） */
export function ambientLook(hue, tone = 'base') {
  hue = wrapHue(hue);
  tone = TONES[tone] ? tone : 'base';
  const key = `${Math.round(hue * 10)}|${tone}`;
  let look = looks.get(key);
  if (look) return look;
  const t = TONES[tone];
  let lo, hi;
  if (tone === 'base' && Math.abs(hueDelta(hue, BASE_HUE)) < 0.05) { lo = ORIGIN.lo; hi = ORIGIN.hi; }      // 最初は今の背景そのもの
  else {
    let L = t.L;
    lo = oklchToHex(L, t.C, hue);
    hi = oklchToHex(L + t.up, t.C + 0.003, hue);
    while (contrastWithWhite(hi) < MIN_CONTRAST && L > 0.3) { L -= 0.005; lo = oklchToHex(L, t.C, hue); hi = oklchToHex(L + t.up, t.C + 0.003, hue); }
  }
  const glow = oklchToRgb(0.68, 0.15, hue).join(',');
  look = { hue, tone, lo, hi, glow };
  looks.set(key, look);
  return look;
}

/** 黄〜黄緑のあたりは同じ明るさだとオリーブ色に濁るので、色が落ち着く先にはしない（途中を通り過ぎるだけ） */
export const skipOlive = (h) => (h > 80 && h < 138 ? 142 : h);

const CALM_EVERY = 5, CALM_STEP = 27;                  // 発動しない手が 5 回続くたびに、色相を 27° 進める
const CALM_TONES = ['base', 'soft', 'base', 'deep'];
const COMBO_STEP = 34;                                 // コンボが 1 つ増えるたびに、色相を 34° 進める（5 の倍数ではさらに 60°）
const COMBO_TONES = ['soft', 'deep', 'base'];
const HOP = 40;                                        // 1 回の重ねで動かす色相の上限（°）
const MIN_FADE = 90;                                   // 「一気に」でも、これだけは重ねる（下の層を外した瞬間に下地がのぞかないように）
const LAYERS = 4;
const CALM_MS = 3000, COMBO_MS = 1400, SNAP_MS = 160;

/** コンボ streak のときの色（calm = ふだんの色） */
export function comboLook(calm, streak) {
  return {
    hue: skipOlive(wrapHue(calm.hue + COMBO_STEP * (streak - 1) + 60 * Math.floor(streak / 5))),
    tone: COMBO_TONES[(streak - 2) % COMBO_TONES.length],
  };
}
/** ふだんの色を進める（発動しない手が続いたとき） */
export function nextCalm(calm, count) {
  return { hue: skipOlive(wrapHue(calm.hue + CALM_STEP)), tone: CALM_TONES[count % CALM_TONES.length] };
}

export class Ambient {
  constructor({ doc = document, win = window } = {}) {
    this.doc = doc;
    this.reducedQuery = win.matchMedia?.('(prefers-reduced-motion: reduce)');
    this.root = doc.createElement('div');
    this.root.id = 'ambient';
    this.root.setAttribute('aria-hidden', 'true');
    this.layers = Array.from({ length: LAYERS }, () => {
      const el = doc.createElement('i');
      el.className = 'amb';
      this.root.append(el);
      return { el, anim: null, on: false, z: 0 };
    });
    doc.body.prepend(this.root);
    this.z = 0;
    this.hops = new Set();         // 遠い色へ向かう、続きの重ね（新しい色が決まったら捨てる）
    this.holdTimer = 0;
    this.now = () => performance.now();
    this.hue = BASE_HUE; this.tone = 'base';                    // いま向かっている（または着いた）色
    this.calm = { hue: BASE_HUE, tone: 'base' };                // ふだんの色。ゆっくり進む
    this.rest = this.calm;                                      // この場面で落ち着く先（コンボ中ならコンボの色）
    this.moves = 0;
    this.holdUntil = 0;
  }

  reduced() { return !!this.reducedQuery?.matches; }

  /** 手を置くたびに呼ぶ。発動しない手が続くと、ふだんの色がゆっくり進む。コンボは色相を進めていく（5 の倍数は一気に） */
  turn(turn) {
    this.moves++;
    const streak = turn.steps?.length ? turn.streak : 0;
    if (streak < 2 && this.moves % CALM_EVERY === 0) this.calm = nextCalm(this.calm, this.moves / CALM_EVERY);
    this.rest = streak >= 2 ? comboLook(this.calm, streak) : this.calm;
    if (this.now() < this.holdUntil) return;                  // お祝いの色を見せている間は、そのあとに落ち着く先だけ覚えておく
    const snap = streak >= 2 && streak % 5 === 0;
    this.go(this.rest.hue, this.rest.tone, snap ? SNAP_MS : streak >= 2 ? COMBO_MS : CALM_MS, { snap });
  }

  /** 大きな連鎖（Amazing 以上）: 一気に明るい別の色へ。少ししたら落ち着く先へ戻る */
  chain(tier) {
    if (tier < 4 || this.now() < this.holdUntil) return;
    this.hold(1500);
    this.go(this.hue + (tier >= 5 ? 180 : 110), 'soft', SNAP_MS, { snap: true });
  }

  /** 全消し（色相をぐるりと 1 周して、少し先の色へ）/ 新記録（一気に別の明るい色へ） */
  celebrate(kind) {
    if (kind === 'best' && this.now() < this.holdUntil) return;
    if (kind === 'clear') {
      this.calm = nextCalm(this.calm, this.moves);
      this.rest = this.calm;
      this.hold(2600);
      this.go(this.calm.hue, 'soft', 1900, { spin: 360 + hueDelta(this.hue, this.calm.hue) });
    } else {
      this.hold(1700);
      this.go(this.hue + 120, 'soft', SNAP_MS, { snap: true });
    }
  }

  /** 見せている色から、落ち着く先へゆっくり戻る（ゲームオーバーなど） */
  settle() {
    this.clearHold();
    this.go(this.rest.hue, this.rest.tone, 1800);
  }

  /** 新しいゲーム: 今の青へ戻す */
  reset() {
    this.moves = 0;
    this.calm = { hue: BASE_HUE, tone: 'base' };
    this.rest = this.calm;
    this.clearHold();
    this.go(BASE_HUE, 'base', 900);
  }

  /** ms のあいだ、ほかの色変えで上書きしない。過ぎたら落ち着く先へ戻る */
  hold(ms) {
    this.clearHold();
    this.holdUntil = this.now() + ms;
    this.holdTimer = setTimeout(() => { this.holdTimer = 0; this.holdUntil = 0; this.go(this.rest.hue, this.rest.tone, 2000); }, ms);
  }
  clearHold() { clearTimeout(this.holdTimer); this.holdTimer = 0; this.holdUntil = 0; }

  /**
   * 色相 hue・濃さ tone へ変わる。ms = 変わりきるまでの時間（グラデーション）/ snap = 一気に（短い重ね 1 回）/
   * spin = 色相を回す角度（省略 = 近い方まわり。360 なら 1 周）
   */
  go(hue, tone = this.tone, ms = COMBO_MS, { snap = false, spin } = {}) {
    for (const t of this.hops) clearTimeout(t);
    this.hops.clear();
    hue = wrapHue(hue);
    const delta = spin ?? hueDelta(this.hue, hue);
    if (spin === undefined && delta === 0 && tone === this.tone) return;
    const quiet = this.reduced();                               // 動きを減らす設定: 小さな重ね 1 回を、ゆっくり
    const n = snap || quiet ? 1 : Math.max(1, Math.min(10, Math.ceil(Math.abs(delta) / HOP)));
    const total = snap ? Math.max(MIN_FADE, ms) : quiet ? Math.max(ms, 700) : ms;
    const step = total / n, from = this.hue;
    for (let k = 1; k <= n; k++) {
      const look = ambientLook(from + (delta * k) / n, tone);
      const run = () => this.show(look, snap || n === 1 ? total : Math.max(MIN_FADE, step * 1.5));
      if (k === 1) run();
      else { const t = setTimeout(() => { this.hops.delete(t); run(); }, step * (k - 1)); this.hops.add(t); }
    }
    this.hue = hue; this.tone = tone;
  }

  /** 新しい色の層を一番上に重ねて、ms かけて opacity 0 → 1。重なり終わったら、下の層は外す */
  show(look, ms) {
    const layer = this.layers.find((l) => !l.on) ?? this.layers.reduce((a, b) => (a.z <= b.z ? a : b));
    const { el } = layer;
    layer.anim?.cancel();
    el.style.setProperty('--lo', look.lo);
    el.style.setProperty('--hi', look.hi);
    el.style.zIndex = String(layer.z = ++this.z);
    el.style.opacity = '0';
    el.style.display = 'block';
    layer.on = true;
    const anim = layer.anim = el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, easing: 'ease-in-out', fill: 'forwards' });
    anim.onfinish = () => { if (layer.anim === anim) this.cover(layer, look); };
    this.doc.documentElement.style.setProperty('--amb-glow', look.glow);   // 同系色の重ね（コンボ・ピンチの縁・色の変化）もこの色相へ
  }

  /** layer が全面を覆い終わった: それより下の層は見えないので外す。ブラウザの上のバーの色も合わせる */
  cover(layer, look) {
    layer.el.style.opacity = '1';
    layer.anim.cancel();
    layer.anim = null;
    for (const l of this.layers) if (l !== layer && l.z < layer.z) { l.anim?.cancel(); l.anim = null; l.on = false; l.el.style.display = 'none'; }
    try { (this.meta ??= this.doc.querySelector('meta[name="theme-color"]'))?.setAttribute('content', look.lo); } catch {}
  }
}

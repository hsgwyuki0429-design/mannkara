/**
 * 効果音の波形を作る（DOM・WebAudio に依存しない純粋な計算。sfx.js が AudioBuffer にして鳴らす）。
 *
 * どちらも「モーダル合成」: 叩かれたものは、いくつかの固有の振動（モード）が、それぞれの速さで消えながら鳴り続ける。
 * 打撃の短いノイズでモードを一斉に鳴らし、モードごとに（周波数・大きさ・消えるまでの時間）を決める。
 *  - ガラス: 薄いガラスの曲げ振動は 1 : 2.83 : 5.42 : 8.77 の整数でない比（金属のバーと同じ種類の比）になる。
 *    基本モードは完全には対称でなく、わずかにずれた 2 つに割れてうなる。テーブルに置かれたガラスは、接触で振動が抑えられて短く消える
 *  - バーチャイム（マークツリー）: 金属の細い棒の曲げ振動の部分音は 1 : 2.76 : 5.40 : 8.93（グロッケンのバーと同じ）。
 *    棒の長さ 8〜20cm（直径約 9.5mm のアルミ）で、基本の高さは 1〜7kHz。高い部分音ほど速く消え、ほぼ同じ高さの対がゆっくりうなる
 * 毎回同じ音になるよう乱数は固定シード。鳴らすたびに計算しないよう、AudioBuffer は 1 回だけ作って使い回す。
 */

/** 固定シードの乱数（xorshift32）。0〜1 */
export function rng(seed) {
  let s = (seed >>> 0) || 1;
  return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296; };
}

/**
 * 消えていく正弦波（モード）を out に足す。at 秒から、周波数 f Hz、最初の大きさ a、60dB 小さくなるまで t60 秒。
 * 2 極の共振の式 y[n] = 2r·cos(w)·y[n-1] − r²·y[n-2] で作る（毎サンプル sin を呼ばない）。
 * 位相は cos（打撃の瞬間が最大）。立ち上がりの段差は、attack 秒かけてなめらかにする（ガラスの接触は 0.1ms ほど、
 * ベルや鈴の立ち上がりは 0.3〜0.4ms。段差が残ると、低い音の「パチッ」というクリックに聞こえる）
 */
function addMode(out, sr, at, f, a, t60, attack = 0.0001) {
  if (!(f > 0) || f > sr * 0.45 || !(Math.abs(a) > 0)) return;
  const start = Math.round(at * sr);
  if (start >= out.length) return;
  const w = (2 * Math.PI * f) / sr, r = Math.pow(0.001, 1 / (t60 * sr)), c = 2 * r * Math.cos(w), r2 = r * r;
  let y1 = a;                                        // cos(0)
  let y2 = (a * Math.cos(-w)) / r;                   // 1 サンプル前
  const end = Math.min(out.length, start + Math.ceil(t60 * sr)), fade = Math.max(1, Math.round(attack * sr));
  for (let i = start; i < end; i++) {
    const k = i - start < fade ? (i - start + 1) / fade : 1;
    out[i] += y1 * k;
    const y0 = c * y1 - r2 * y2;
    y2 = y1; y1 = y0;
  }
}

/** 打撃の瞬間の短い雑音（tau 秒で消える）。1 次の差分で高域を強める */
function addClick(out, sr, at, tau, a, rand) {
  const start = Math.round(at * sr), n = Math.min(out.length - start, Math.ceil(tau * 8 * sr));
  let prev = 0;
  for (let i = 0; i < n; i++) {
    const x = (rand() * 2 - 1) * Math.exp(-i / (tau * sr));
    out[start + i] += a * (x - 0.9 * prev);
    prev = x;
  }
}

/** 全体に k を掛け、最後の 12ms をなめらかに 0 へ（再生の終わりでぷつっと鳴らないように） */
function scaleAndFade(out, sr, k) {
  const fade = Math.min(out.length, Math.round(sr * 0.012));
  for (let i = 0; i < out.length; i++) out[i] *= k;
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
}
/** 最大の振幅を peak にそろえる */
function finish(out, sr, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; }
  return scaleAndFade(out, sr, m > 0 ? peak / m : 0);
}
/**
 * 先頭 0.6 秒の RMS（音の大きさの目安）を rms にそろえる。高さやバーの数が違っても同じ大きさに聞こえるように。
 * ただし最大の振幅は peak まで（超えるときは、そのぶん小さくする）
 */
function finishLoud(out, sr, rms = 0.2, peak = 0.98) {
  let m = 0, e = 0;
  const n = Math.min(out.length, Math.round(sr * 0.6));
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; if (i < n) e += out[i] * out[i]; }
  const r = Math.sqrt(e / n);
  return scaleAndFade(out, sr, r > 0 && m > 0 ? Math.min(rms / r, peak / m) : 0);
}

/** 少し遅らせた小さなこだまを足す（きらめきの余韻）。delays 秒・gains 倍 */
function addEchoes(out, sr, delays, gains) {
  const dry = Float32Array.from(out);
  delays.forEach((d, j) => {
    const n = Math.round(d * sr);
    for (let i = n; i < out.length; i++) out[i] += dry[i - n] * gains[j];
  });
}

/* =====================================================================
 * ガラスを置く音
 * ===================================================================== */
export const GLASS_VARIANTS = 4;
/** コップごとの高さ（Hz）。1.5〜2.2kHz は、市販のコップの共鳴（約 0.6〜1.8kHz とその上の部分音）の高い側 */
const GLASS_PITCH = [1760, 1980, 1560, 2210];
/** [基本に対する周波数の比, 大きさ, 消えるまでの秒（60dB）]。1 : 2.83 : 5.42 : 8.77 は薄いガラスの曲げ振動 */
const GLASS_MODES = [
  [1.0, 1.0, 0.3],
  [1.006, 0.65, 0.26],        // 基本モードがわずかにずれて 2 つに割れる（うなり）
  [2.83, 0.8, 0.19],
  [5.42, 0.5, 0.11],
  [8.77, 0.2, 0.06],
  [1.52, 0.3, 0.2],           // 軸方向のモード（コップの縁と底の間）
  [4.1, 0.22, 0.12],
];

/**
 * ガラスのコップをテーブルに置く音（約 0.5 秒）。variant = 0〜3（コップの高さ違い）。
 * 縁の「カチッ」+ ガラスの共鳴 + 底がテーブルに当たる低い「コツ」+ ごく小さな再接触（置いたあとのわずかな揺れ）
 */
export function glassBuffer(sr, variant = 0) {
  const rand = rng(0x9e3779b1 + variant * 7919);
  const out = new Float32Array(Math.round(sr * 0.5));
  const f1 = GLASS_PITCH[variant % GLASS_PITCH.length];
  const strike = (at, g, detune) => {
    for (const [ratio, amp, t60] of GLASS_MODES) addMode(out, sr, at, f1 * ratio * detune, g * amp * 0.3, t60);
    addClick(out, sr, at, 0.0006, g * 0.35, rand);
  };
  strike(0, 1, 1);
  addMode(out, sr, 0, 185 + rand() * 25, 0.34, 0.055);             // 底がテーブルに当たる「コツ」
  strike(0.021 + rand() * 0.006, 0.3, 1.011);                       // 置いたあと、小さく再接触
  return finish(out, sr, 0.9);
}

/* =====================================================================
 * シャラン（バーチャイム = マークツリーの、高い金属のきらめき）
 * ===================================================================== */
/** 最後の（一番高い）バーの高さの基準（Hz）。鳴らすときは、連鎖ごとの高さで作り直す（sfx.js の shalanTop）。長さは高さによらず同じ */
export const SHALAN_TOP = 2217;
/** 一番低いバーの高さ（Hz）。バーチャイムの長いバー（約 20cm）の基本の高さ */
export const SHALAN_LOW = 1100;
/** 全体の長さ（秒。最後のバーは 1 秒で聞こえなくなる）。駆け上がる時間（約 0.15 秒）のあと、最後のバーが 60dB 小さくなるまで SHALAN_RING 秒 */
export const SHALAN_LENGTH = 1.3;
const SHALAN_RING = 0.85, SHALAN_SWEEP = 0.15;
/** 先頭 0.6 秒の RMS。高さによらず同じ大きさ（旧版のシャランと同じ、耳の感度で重み付けした大きさ） */
const SHALAN_RMS = 0.147;
/**
 * 金属のバー（アルミ・真鍮の細い棒）の部分音 [周波数の比, 大きさ, 消える速さ（基本に対する倍率）]。両端が自由な棒の曲げ振動の
 * 1 : 2.756 : 5.404 : 8.933（グロッケンのバーと同じ）。整数倍でないので、音の高さがはっきりしない「きらきら」になる
 */
const BAR_PARTS = [[1, 1, 1], [2.756, 0.35, 0.5], [5.404, 0.12, 0.25], [8.933, 0.04, 0.12]];
/** 最後のバーを主音としたとき、ペンタトニックの音になる半音の数（最後のバーから何半音下か、12 で割った余り）。ここは大きく、長く鳴らす */
const BAR_MAIN = [0, 3, 5, 8, 10];

/**
 * バー 1 本を叩く: 部分音 + わずかにずれた対（ゆっくりしたうなり = 金属のきらめき）+ 指がバーに触れた瞬間の「チッ」。
 * モードごとの向き（符号）は、打った場所での振動の向きがモードごとに違うので、ばらばらにする（そろえると、打った瞬間に全部が重なって
 * 鋭いピークになり、そのぶん全体の音量を上げられない）
 */
function barNote(out, sr, f, at, gain, t60, rand, click = 0.15) {
  const sign = () => (rand() < 0.5 ? -1 : 1);
  for (const [ratio, a, d] of BAR_PARTS) addMode(out, sr, at, f * ratio, gain * a * sign(), t60 * d, 0.0004);
  addMode(out, sr, at, f * (1.001 + rand() * 0.0007), gain * 0.55 * sign(), t60 * 0.95, 0.0004);
  addClick(out, sr, at, 0.0003, gain * click, rand);
}

/**
 * シャラン（1.3 秒）: バーチャイム（長さの違う金属のバーを並べて吊るした楽器）を指でなでたときの、高い音が駆け上がる
 * 「シャラーン」。一番低いバー（SHALAN_LOW）から top まで、半音ごとのバーを約 0.15 秒で順に叩き（だんだん強く）、
 * 最後の top のバーだけが長く響く。ペンタトニックの音のバーは大きく長く、間の半音のバーは小さく短く鳴らす
 * （最後にペンタトニックだけが残るので、ゴールの音と濁らない）。短いこだま 2 つ（83ms・151ms）を足す。
 * 高さが変わっても、長さ・駆け上がる時間・最後のバーの消え方は同じ
 */
export function shalanBuffer(sr, top = SHALAN_TOP) {
  const out = new Float32Array(Math.round(sr * SHALAN_LENGTH));
  const steps = Math.max(8, Math.round(12 * Math.log2(top / SHALAN_LOW)));      // 一番低いバーから最後のバーまでの半音の数
  for (let k = 0; k < steps; k++) {
    const below = steps - k, u = k / steps;                                       // 最後のバーから何半音下か / 0 → 1
    const rand = rng(0x2545f491 + below * 7919);                                  // バーごとに固定: 高さが違っても、同じ位置のバーは同じ鳴り方
    const main = BAR_MAIN.includes(below % 12);
    const at = SHALAN_SWEEP * u + (rand() - 0.5) * 0.003;
    const gain = (0.06 + 0.22 * u * u) * (main ? 1 : 0.4) * (0.8 + rand() * 0.4);
    barNote(out, sr, top * Math.pow(2, -below / 12), Math.max(0, at), gain, main ? 0.34 + 0.12 * u : 0.2 + 0.06 * u, rand);
  }
  barNote(out, sr, top, SHALAN_SWEEP + 0.012, 0.5 * Math.sqrt(steps / 12), SHALAN_RING, rng(0x51ed270b), 0.06);   // ラン: 最後のバー（バーが多いほど強く。埋もれずに、同じ長さに聞こえるように）
  addEchoes(out, sr, [0.083, 0.151], [0.22, 0.12]);
  return finishLoud(out, sr, SHALAN_RMS, 0.98);
}

/** 最大の振幅（テスト・音量合わせ用） */
export function peakOf(buf) { let m = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; } return m; }
/** 2 乗平均平方根（音の大きさの目安） */
export function rmsOf(buf, from = 0, to = buf.length) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

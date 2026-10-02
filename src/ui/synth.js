/**
 * 効果音の波形を作る（DOM・WebAudio に依存しない純粋な計算。sfx.js が AudioBuffer にして鳴らす）。
 *
 * どちらも「モーダル合成」: 叩かれたものは、いくつかの固有の振動（モード）が、それぞれの速さで消えながら鳴り続ける。
 * 打撃の短いノイズでモードを一斉に鳴らし、モードごとに（周波数・大きさ・消えるまでの時間）を決める。
 *  - ガラス: 薄いガラスの曲げ振動は 1 : 2.83 : 5.42 : 8.77 の整数でない比（金属のバーと同じ種類の比）になる。
 *    基本モードは完全には対称でなく、わずかにずれた 2 つに割れてうなる。テーブルに置かれたガラスは、接触で振動が抑えられて短く消える
 *  - ベル: 小さなベル（グロッケン・ハンドベル）の部分音は 1 : 2.76 : 5.40 : 8.93。高い部分音ほど速く消える。
 *    鈴（スレイベル）は、小さな鈴がまとめて揺れて、ランダムな打撃が 2.5〜6.5kHz の共振を次々に鳴らす（PhISEM の考え方）
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
  if (!(f > 0) || f > sr * 0.45 || !(a > 0)) return;
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

/** 最大の振幅を peak にそろえ、最後の 12ms をなめらかに 0 へ（再生の終わりでぷつっと鳴らないように） */
function finish(out, sr, peak = 0.9) {
  let m = 0;
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; }
  const k = m > 0 ? peak / m : 0, fade = Math.min(out.length, Math.round(sr * 0.012));
  for (let i = 0; i < out.length; i++) out[i] *= k;
  for (let i = 0; i < fade; i++) out[out.length - 1 - i] *= i / fade;
  return out;
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
 * シャラン（クリスマスのベルのような、きらめく音）
 * ===================================================================== */
/** シャランの基準の高さ（Hz）。最後の長く響く音（「ラン」）がこの高さ。鳴らすときは再生の速さで、連鎖ごとの音に合わせる */
export const SHALAN_TOP = 1414;
/** 小さなベルの部分音 [周波数の比, 大きさ, 消える速さ（基本に対する倍率）] */
const BELL_PARTS = [[1, 1, 1], [2, 0.3, 0.5], [2.756, 0.4, 0.45], [5.404, 0.15, 0.22], [8.933, 0.05, 0.1]];
/** 駆け上がる音階（最後の音からの半音の数）。最後の音を主音とした、長調のペンタトニック（どれも濁らない） */
const SHALAN_RUN = [-17, -15, -12, -10, -8, -5, -3, 0];
/** 小さな鈴の共振 [Hz, 大きさ, 消えるまでの秒]。スレイベルは 2.5〜6.5kHz に共振が集まる */
const JINGLES = [[2480, 1, 0.1], [3410, 0.8, 0.08], [4130, 0.7, 0.07], [5330, 0.55, 0.06], [6450, 0.4, 0.05]];

function bellNote(out, sr, f, at, gain, t60) {
  for (const [ratio, a, d] of BELL_PARTS) addMode(out, sr, at, f * ratio, gain * a, t60 * d, 0.0004);
  addMode(out, sr, at, f * 1.0045, gain * 0.5, t60 * 0.9, 0.0004);   // わずかにずれた対（うなり。ベルのきらめき）
}

/**
 * シャラン（約 1.7 秒）。鈴がまとめて揺れるシャ（0.2 秒ほど）→ ベルの音階が一気に駆け上がり（バーツリーのように）、
 * 最後の音が長く響くラン → 短いこだま。最後の音の高さは SHALAN_TOP
 */
export function shalanBuffer(sr) {
  const rand = rng(0x2545f491);
  const out = new Float32Array(Math.round(sr * 1.7));
  // シャ: 鈴のこすれる音。26 回の打撃が、共振を次々に鳴らす（だんだん間があき、弱くなる）
  const hits = 26;
  for (let i = 0; i < hits; i++) {
    const at = 0.004 + Math.pow(i / hits, 0.8) * 0.2 + rand() * 0.012;
    const g = (0.35 + rand() * 0.65) * (1 - (i / hits) * 0.6);
    for (const [f, amp, t60] of JINGLES) addMode(out, sr, at, f * (0.985 + rand() * 0.03), g * amp * 0.075, t60 * (0.6 + rand() * 0.8), 0.00025);
  }
  // ラン: ベルの音階が駆け上がる（高くなるほど強く、少し間隔を詰めて）。最後の音だけ長く響く
  SHALAN_RUN.forEach((semi, i) => {
    const at = 0.03 + i * 0.0145;
    bellNote(out, sr, SHALAN_TOP * Math.pow(2, semi / 12), at, 0.1 + 0.025 * i, 0.32 + 0.02 * i);
  });
  bellNote(out, sr, SHALAN_TOP, 0.03 + SHALAN_RUN.length * 0.0145 + 0.004, 0.42, 1.25);
  addEchoes(out, sr, [0.083, 0.151], [0.3, 0.16]);
  return finish(out, sr, 0.9);
}

/** 最大の振幅（テスト・音量合わせ用） */
export function peakOf(buf) { let m = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; } return m; }
/** 2 乗平均平方根（音の大きさの目安） */
export function rmsOf(buf, from = 0, to = buf.length) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

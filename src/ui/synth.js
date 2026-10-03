/**
 * 効果音の波形を作る（DOM・WebAudio に依存しない純粋な計算。sfx.js が AudioBuffer にして鳴らす）。
 *
 * どちらも「モーダル合成」: 叩かれたものは、いくつかの固有の振動（モード）が、それぞれの速さで消えながら鳴り続ける。
 * 打撃の短いノイズでモードを一斉に鳴らし、モードごとに（周波数・大きさ・消えるまでの時間）を決める。
 *  - ガラス: 薄いガラスの曲げ振動は 1 : 2.83 : 5.42 : 8.77 の整数でない比（金属のバーと同じ種類の比）になる。
 *    基本モードは完全には対称でなく、わずかにずれた 2 つに割れてうなる。テーブルに置かれたガラスは、接触で振動が抑えられて短く消える
 *  - バーチャイム（マークツリー）: 金属の細い棒の曲げ振動の部分音は 1 : 2.76 : 5.40 : 8.93（グロッケンのバーと同じ）。
 *    棒の長さ 8〜20cm（直径約 9.5mm のアルミ）で、基本の高さは 1〜7kHz。高い部分音ほど速く消え、ほぼ同じ高さの対がゆっくりうなる。
 *    硬く叩くと高い部分音が強く尖った音になり、棒どうしが擦れ合う「シャッ」（4〜9kHz の帯域雑音）が混ざる。指で 2 回なでて「シャン、シャン」
 * 毎回同じ音になるよう乱数は固定シード。鳴らすたびに計算しないよう、AudioBuffer は 1 回だけ作って使い回す。
 *
 * 音のセット（KITS）: ガラス（上の 3 つ）/ 木琴 / オルゴール。置く音・シャラン・鈴の 3 種類を、セットごとの楽器で作る
 * （スコアが一定ごとにセットが替わる。sfx.js）。木琴とオルゴールは、同じ「モーダル合成」で、その楽器の部分音の比と減衰を使う。
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
/** 2 次のローパス（RBJ。q = 1/√2 でバターワース）。x の新しい配列を返す */
function lowpass(x, sr, f0, q = Math.SQRT1_2) {
  const w0 = (2 * Math.PI * f0) / sr, cs = Math.cos(w0), al = Math.sin(w0) / (2 * q);
  const a0 = 1 + al, b0 = (1 - cs) / 2 / a0, b1 = (1 - cs) / a0, c1 = (-2 * cs) / a0, c2 = (1 - al) / a0;
  const y = new Float32Array(x.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const v = b0 * x[i] + b1 * x1 + b0 * x2 - c1 * y1 - c2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v;
  }
  return y;
}
/**
 * 先頭 secs 秒（既定 1 秒）の RMS（音の大きさの目安）を rms にそろえる。高さやバーの数が違っても同じ大きさに聞こえるように。
 * 大きさは、出口の 9.5kHz のローパス（sfx.js の bright）を通したあとで測る（それより上の部分音は聞こえないので数えない）。
 * ただし最大の振幅は peak まで（超えるときは、そのぶん小さくする）
 */
function finishLoud(out, sr, rms = 0.2, peak = 0.98, secs = 1) {
  let m = 0, e = 0;
  const n = Math.min(out.length, Math.round(sr * secs)), heard = lowpass(out.subarray(0, n), sr, Math.min(9500, sr * 0.45));
  for (let i = 0; i < out.length; i++) { const v = Math.abs(out[i]); if (v > m) m = v; }
  for (let i = 0; i < n; i++) e += heard[i] * heard[i];
  const r = Math.sqrt(e / n);
  return scaleAndFade(out, sr, r > 0 && m > 0 ? Math.min(rms / r, peak / m) : 0);
}

/**
 * 帯域雑音（「シャ」）を out に足す: at 秒から dur 秒、中心 f0 Hz（Q）の帯域だけを通した雑音。0.6ms で立ち上がり、指数で消える。
 * 音の高さのない、金属が擦れ合う・打ち合う「シャッ」という息の成分
 */
function addHiss(out, sr, at, dur, a, rand, f0 = 5200, q = 0.8) {
  const start = Math.round(at * sr), n = Math.min(out.length - start, Math.ceil(dur * sr));
  if (n <= 0 || !(a > 0)) return;
  const w0 = (2 * Math.PI * f0) / sr, al = Math.sin(w0) / (2 * q), a0 = 1 + al, g = al / a0, c1 = (-2 * Math.cos(w0)) / a0, c2 = (1 - al) / a0;
  const tau = (dur / 4.5) * sr, up = Math.max(1, Math.round(0.0006 * sr));
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < n; i++) {
    const x = (rand() * 2 - 1) * Math.exp(-i / tau) * (i < up ? (i + 1) / up : 1);
    const y = g * (x - x2) - c1 * y1 - c2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    out[start + i] += a * y;
  }
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
 * 鈴（音の高さのある「ピン」の音。ゴール・手駒の補充・コンボ・褒め言葉などの旋律に使う）
 * ===================================================================== */
/** 鈴 1 つの長さ（秒）。sfx.js が、鳴らす長さに合わせて途中から小さくして切る */
export const BELL_LENGTH = 1;
/** 先頭 0.4 秒の RMS（9.5kHz のローパスを通したあと）。高さによらず同じ大きさ */
const BELL_RMS = 0.1;
/**
 * 鈴の部分音 [周波数の比, 大きさ, 消える速さ（基本に対する倍率）]。
 *  - 0.5 = 胴の低い響き（ハム）。スマホの小さなスピーカーは低い音が出ないので、これだけに頼らず、上の部分音で厚みを出す
 *  - 1 = 打った音の高さ / 2 = オクターブ上（鐘の「ノミナル」）/ 3 = その 5 度上
 *  - 2.756・5.404・8.933 = 金属の曲げ振動の整数でない比（バーチャイムと同じ）。高いほど速く消えて、打った瞬間の「チン」になる
 * 純粋な正弦波 1 本の「ピン」は、細くて薄っぺらい。いくつもの部分音が違う速さで消えていくと、厚みのある金属の響きになる
 */
const BELL_PARTS = [[0.5, 0.3, 1.3], [1, 1, 1], [2, 0.8, 0.7], [2.756, 0.55, 0.45], [3, 0.3, 0.5], [5.404, 0.32, 0.25], [8.933, 0.12, 0.12]];
/**
 * 鈴の波形（1 秒）: 基本の高さ f（Hz）。部分音 + わずかにずれた対（ゆっくりしたうなり = 鈴のゆらぎ）+ 打った瞬間の「チッ」+
 * 短いこだま 2 つ（43ms・97ms。小さな部屋の響き）。響きの長さは高いほど短く（f ≈ 700Hz で基本が 0.62 秒で 60dB 小さくなる）。
 * 高さが違っても、同じ大きさ。f ごとに乱数を固定
 */
export function bellBuffer(sr, f = 700) {
  const out = new Float32Array(Math.round(sr * BELL_LENGTH));
  const rand = rng(0x6b1d5eed + Math.round(f) * 31);
  const sign = () => (rand() < 0.5 ? -1 : 1), t60 = 0.62 * Math.pow(700 / f, 0.35);
  for (const [ratio, a, d] of BELL_PARTS) addMode(out, sr, 0, f * ratio, a * sign(), t60 * d, 0.0004);
  addMode(out, sr, 0, f * (1.0028 + rand() * 0.0012), 0.55 * sign(), t60 * 0.92, 0.0004);          // 基本のずれた対
  addMode(out, sr, 0, f * 2 * (1.0035 + rand() * 0.001), 0.3 * sign(), t60 * 0.6, 0.0004);          // オクターブのずれた対
  addClick(out, sr, 0, 0.0004, 0.1, rand);
  addEchoes(out, sr, [0.043, 0.097], [0.16, 0.09]);
  return finishLoud(out, sr, BELL_RMS, 0.98, 0.4);
}

/* =====================================================================
 * シャラン（バーチャイム = マークツリーの、高い金属のきらめき）
 * ===================================================================== */
/** 最後の（一番高い）バーの高さの基準（Hz）。鳴らすときは、連鎖ごとの高さで作り直す（sfx.js の shalanTop）。長さは高さによらず同じ */
export const SHALAN_TOP = 2217;
/** 一番低いバーの高さ（Hz）。バーチャイムの長いバー（約 20cm）の基本の高さ */
export const SHALAN_LOW = 1100;
/** 全体の長さ（秒）。2 回目のなで上げのあと、最後のバーが 60dB 小さくなるまで SHALAN_RING 秒 */
export const SHALAN_LENGTH = 1.3;
const SHALAN_RING = 0.7;
/** 先頭 1 秒の RMS（9.5kHz のローパスを通したあと）。高さによらず同じ大きさ */
const SHALAN_RMS = 0.07;
/**
 * なで上げ（シャン）: 指でバーをなでる動き。at = 始まる時刻（秒）、dur = 駆け上がる時間（秒）、bars = 何半音ぶんのバーを叩くか
 * （null = 一番低いバーから）、level = 強さ、tail = 最後のバーの余韻の長さ（60dB・秒）、tailLevel = 最後のバーの強さ
 */
const FLICKS = [
  { at: 0, dur: 0.115, bars: null, level: 1, tail: 0.2, tailLevel: 0.34 },
  { at: 0.2, dur: 0.07, bars: 7, level: 0.85, tail: SHALAN_RING, tailLevel: 0.5 },
];
/**
 * 金属のバー（アルミ・真鍮の細い棒）の部分音 [周波数の比, 大きさ, 消える速さ（基本に対する倍率）]。両端が自由な棒の曲げ振動の
 * 1 : 2.756 : 5.404 : 8.933（グロッケンのバーと同じ）。整数倍でないので、音の高さがはっきりしない「きらきら」になる。
 * 硬いもの（金属の撥・指先の爪）で叩くと、高い部分音が強く、尖った音になる
 */
const BAR_PARTS = [[1, 1, 1], [2.756, 0.6, 0.55], [5.404, 0.4, 0.4], [8.933, 0.2, 0.25]];
/** 最後のバーを主音としたとき、ペンタトニックの音になる半音の数（最後のバーから何半音下か、12 で割った余り）。ここは大きく、長く鳴らす */
const BAR_MAIN = [0, 3, 5, 8, 10];
/** 叩いた瞬間の雑音（シャッ）の強さ（バーの大きさに対する倍率）と、その長さ（秒） */
const HISS = 2.4, HISS_LEN = 0.012;

/**
 * バー 1 本を叩く: 部分音 + わずかにずれた対（ゆっくりしたうなり = 金属のきらめき）+ 叩いた瞬間の「チッ」+ 雑音の「シャッ」。
 * モードごとの向き（符号）は、打った場所での振動の向きがモードごとに違うので、ばらばらにする（そろえると、打った瞬間に全部が重なって
 * 鋭いピークになり、そのぶん全体の音量を上げられない）
 */
function barNote(out, air, sr, f, at, gain, t60, rand, { click = 0.15, hiss = HISS, hissLen = HISS_LEN } = {}) {
  const sign = () => (rand() < 0.5 ? -1 : 1);
  for (const [ratio, a, d] of BAR_PARTS) addMode(out, sr, at, f * ratio, gain * a * sign(), t60 * d, 0.0004);
  addMode(out, sr, at, f * (1.001 + rand() * 0.0007), gain * 0.55 * sign(), t60 * 0.95, 0.0004);
  addClick(air, sr, at, 0.0003, gain * click, rand);
  addHiss(air, sr, at, hissLen, gain * hiss, rand);
}

/**
 * シャラン（1.3 秒）: バーチャイム（長さの違う金属のバーを並べて吊るした楽器）を指で 2 回なでたときの
 * 「シャン、シャン」。1 回目は一番低いバー（SHALAN_LOW）から top まで、半音ごとのバーを約 0.12 秒で順に叩き（だんだん強く）、
 * 2 回目は top の 7 半音下から top まで。top のバーは 2 回目のあとで長く響く。各バーの叩く瞬間には金属の「チッ」と、
 * 擦れ合う「シャッ」（帯域雑音）が付く。ペンタトニックの音のバーは大きく長く、間の半音のバーは小さく短く鳴らす
 * （最後にペンタトニックだけが残るので、ゴールの音と濁らない）。短いこだま 2 つ（83ms・151ms）を足す。
 * 高さが変わっても、長さ・駆け上がる時間・最後のバーの消え方は同じ
 */
export function shalanBuffer(sr, top = SHALAN_TOP) {
  const out = new Float32Array(Math.round(sr * SHALAN_LENGTH)), air = new Float32Array(out.length);   // 部分音 / 雑音（「シャッ」「チッ」）
  const steps = Math.max(8, Math.round(12 * Math.log2(top / SHALAN_LOW)));      // 一番低いバーから最後のバーまでの半音の数
  FLICKS.forEach((fl, j) => {
    const n = fl.bars ?? steps;
    for (let k = 0; k < n; k++) {
      const below = n - k, u = k / n;                                             // 最後のバーから何半音下か / 0 → 1
      const rand = rng(0x2545f491 + below * 7919 + j * 104729);                   // バーごとに固定: 高さが違っても、同じ位置のバーは同じ鳴り方
      const main = BAR_MAIN.includes(below % 12);
      const at = fl.at + fl.dur * u + (rand() - 0.5) * 0.003;
      const gain = (0.06 + 0.22 * u * u) * (main ? 1 : 0.34) * (0.8 + rand() * 0.4) * fl.level;
      barNote(out, air, sr, top * Math.pow(2, -below / 12), Math.max(0, at), gain, main ? 0.2 + 0.18 * u : 0.1 + 0.08 * u, rand);
    }
    // top のバー: 1 回目は短い「チン」、2 回目は長く響く「シャーン」（バーが多いほど強く。埋もれないように）
    barNote(out, air, sr, top, fl.at + fl.dur + 0.008, fl.tailLevel * Math.sqrt(steps / 12), fl.tail, rng(0x51ed270b + j * 7), { click: 0.3, hiss: 2.6, hissLen: 0.04 });
  });
  addEchoes(out, sr, [0.083, 0.151], [0.22, 0.12]);                               // 響きだけにこだまを足す（「シャッ」を重ねると、2 回が 5 回に聞こえてしまう）
  for (let i = 0; i < out.length; i++) out[i] += air[i];
  return finishLoud(out, sr, SHALAN_RMS, 0.98);
}

/* =====================================================================
 * 音のセット: 置く音（place）・シャラン（chime）・鈴（note）を、セットごとの楽器で
 * ===================================================================== */
/** セット 0 = ガラスのコップ + バーチャイム + 鈴（上の 3 つ）/ 1 = 木琴 / 2 = オルゴール */
export const KITS = ['glass', 'marimba', 'musicbox'];
export const PLACE_VARIANTS = GLASS_VARIANTS;
/** 置く音の大きさ: 先頭 0.25 秒の RMS（9.5kHz のローパスを通したあと）。ガラスと同じ耳への大きさになるよう、セットごとに耳の感度（A 特性）で合わせた */
const PLACE_RMS = { 1: [0.12, 0.111, 0.129, 0.105], 2: [0.099, 0.096, 0.106, 0.093] };

/* ---------------------------------------------------------------------
 * 木琴（マリンバ）: ローズウッドの棒をゴムや毛糸の撥で叩く。棒は中央を削って調律してあり、部分音が基本の 4 倍・10 倍付近になる
 * （普通の金属の棒の 2.756・5.404 倍ではなく、整数に近い比 → 音の高さがはっきりして、丸く温かい）。高い部分音ほど速く消え、
 * 共鳴管が基本をふくらませる。撥が木に当たる「コッ」が立ち上がりに付く
 * --------------------------------------------------------------------- */
const WOOD_PARTS = [[3.97, 0.34, 0.3], [9.8, 0.1, 0.1]];             // 基本のほかの部分音 [周波数の比, 大きさ, 消える速さ（基本に対する倍率）]
const WOOD_PITCH = [659.26, 783.99, 587.33, 880];                     // 置く音の高さ（ミ・ソ・レ・ラ。ペンタトニック）
/**
 * 木の棒 1 本を叩く: out に at 秒から、基本 f Hz・大きさ gain・基本が 60dB 小さくなるまで t60 秒。hard = 撥の硬さ（0〜1。硬いほど高い部分音が強い）
 */
function woodNote(out, sr, f, at, gain, t60, rand, hard = 0.5) {
  const sign = () => (rand() < 0.5 ? -1 : 1);
  addMode(out, sr, at, f, gain * sign(), t60, 0.0005);
  for (const [ratio, a, d] of WOOD_PARTS) addMode(out, sr, at, f * ratio, gain * a * (0.4 + hard) * sign(), t60 * d, 0.0005);
  addMode(out, sr, at, f * 1.0016, gain * 0.22 * sign(), t60 * 1.1, 0.0006);       // わずかにずれた対（木のゆらぎ）
  addMode(out, sr, at, f * 0.5, gain * 0.1, t60 * 0.7, 0.002);                     // 共鳴管の低い響き
  addHiss(out, sr, at, 0.007, gain * 0.9, rand, Math.min(3200, f * 2.4), 1.2);     // 撥が木に当たる「コッ」
}
/** 木琴の高さ f の基本が 60dB 消えるまでの秒数（低い棒ほど長く響く） */
const woodRing = (f) => Math.min(1.4, Math.max(0.25, 0.9 * Math.pow(523 / f, 0.55)));

/** 木琴を置く音（0.45 秒）: 棒を硬い撥で叩く「ポコッ」+ 底がテーブルに当たる低い「コツ」+ 小さな再接触 */
function marimbaPlace(sr, variant) {
  const rand = rng(0x3c6ef372 + variant * 7919), out = new Float32Array(Math.round(sr * 0.45));
  const f1 = WOOD_PITCH[variant % WOOD_PITCH.length];
  woodNote(out, sr, f1, 0, 1, 0.3, rand, 0.9);
  addMode(out, sr, 0, 175 + rand() * 25, 0.3, 0.05);
  woodNote(out, sr, f1 * 1.011, 0.024 + rand() * 0.006, 0.28, 0.12, rand, 1);
  return finishLoud(out, sr, PLACE_RMS[1][variant % PLACE_RMS[1].length], 0.98, 0.25);
}
/** 下から数えた半音の数（最後の棒が 0）。ペンタトニックの音だけを並べる（最後に鳴る音が、ゴールの音と濁らない） */
const RUN_BELOW = [22, 20, 17, 15, 12, 10, 8, 5, 3, 0];
/**
 * 木琴のなで上げ（1.3 秒）: 棒の並びを撥で「コロロン、コロン」と駆け上がる。1 回目は低い棒から top の棒まで約 0.15 秒で（だんだん強く）、
 * 2 回目は top の 1 オクターブ下から。top の棒は 2 回目のあとで長く響く。top は、バーチャイムの高さの 1 オクターブ下（木琴の音域）
 */
function marimbaRun(sr, top) {
  const out = new Float32Array(Math.round(sr * SHALAN_LENGTH)), top1 = top / 2;
  const flicks = [{ at: 0, dur: 0.15, seq: RUN_BELOW, level: 0.8, tail: 0.3 }, { at: 0.22, dur: 0.085, seq: RUN_BELOW.slice(5), level: 0.9, tail: 0.75 }];
  flicks.forEach((fl, j) => {
    fl.seq.forEach((below, k) => {
      const rand = rng(0x2f6b7a11 + below * 7919 + j * 104729), u = k / fl.seq.length;
      const f = top1 * Math.pow(2, -below / 12), last = below === 0;
      const at = Math.max(0, fl.at + (fl.dur * k) / (fl.seq.length - 1) + (rand() - 0.5) * 0.003);
      const gain = last ? 0.55 * fl.level : (0.12 + 0.3 * u * u) * (0.85 + rand() * 0.3) * fl.level;
      woodNote(out, sr, f, at, gain, last ? fl.tail : 0.1 + 0.18 * u, rand, 0.7);
    });
  });
  addEchoes(out, sr, [0.061, 0.137], [0.14, 0.08]);
  return finishLoud(out, sr, SHALAN_RMS, 0.98);
}
/** 木琴の 1 音（1 秒）: 毛糸の撥でやわらかく叩く。f = 基本の高さ（Hz）。高さが違っても同じ大きさ */
function marimbaNote(sr, f) {
  const out = new Float32Array(Math.round(sr * BELL_LENGTH)), rand = rng(0x1d872b41 + Math.round(f) * 31);
  woodNote(out, sr, f, 0, 1, woodRing(f), rand, 0.3);
  addEchoes(out, sr, [0.05, 0.11], [0.12, 0.07]);
  return finishLoud(out, sr, BELL_RMS, 0.98, 0.4);
}

/* ---------------------------------------------------------------------
 * オルゴール: 鋼のくしの歯（片持ち梁）を、回る円筒のピンが弾く。片持ち梁の曲げ振動の部分音は 1 : 6.27 : 17.55 : 34.4
 * （金属の棒の 2.756・5.404 倍より、上の部分音がずっと高く離れる）→ 基本が澄んで、ごく速く消える高い「チリン」が混ざる細い音。
 * ピンが歯を弾く「ぴっ」が立ち上がりに付き、木の箱が低い胴鳴りをつける
 * --------------------------------------------------------------------- */
const TINE_PARTS = [[6.267, 0.42, 0.22], [17.55, 0.14, 0.08], [34.4, 0.05, 0.04]];
const TINE_PITCH = [1046.5, 1174.7, 880, 1318.5];                     // 置く音の高さ（ド・レ・ラ・ミ。ペンタトニック）。2 番目の部分音（6.27 倍）が聞こえる帯域に入る高さ
/** 歯 1 本を弾く: out に at 秒から、基本 f Hz・大きさ gain・基本が 60dB 小さくなるまで t60 秒 */
function tineNote(out, sr, f, at, gain, t60, rand) {
  const sign = () => (rand() < 0.5 ? -1 : 1);
  addMode(out, sr, at, f, gain * sign(), t60, 0.0003);
  for (const [ratio, a, d] of TINE_PARTS) addMode(out, sr, at, f * ratio, gain * a * sign(), t60 * d, 0.0003);
  addMode(out, sr, at, f * (1.0021 + rand() * 0.0008), gain * 0.45 * sign(), t60 * 0.9, 0.0003);     // うなり
  addClick(out, sr, at, 0.0004, gain * 0.12, rand);                                                   // ピンが歯を弾く「ぴっ」
}
/** オルゴールの高さ f の基本が 60dB 消えるまでの秒数 */
const tineRing = (f) => Math.min(1.5, Math.max(0.35, 1.0 * Math.pow(700 / f, 0.4)));

/** オルゴールの置く音（0.5 秒）: 歯を 1 本弾く「ポロン」+ 箱が受け止める低い胴鳴り */
function musicBoxPlace(sr, variant) {
  const rand = rng(0x4a7c15f9 + variant * 7919), out = new Float32Array(Math.round(sr * 0.5));
  tineNote(out, sr, TINE_PITCH[variant % TINE_PITCH.length], 0, 1, 0.45, rand);
  addMode(out, sr, 0, 205 + rand() * 25, 0.4, 0.05);                  // 箱が受け止める低い胴鳴り
  addMode(out, sr, 0, 430 + rand() * 40, 0.16, 0.06);                 // 木の箱の胴の響き（広い共鳴）
  addMode(out, sr, 0, 790 + rand() * 60, 0.1, 0.045);
  return finishLoud(out, sr, PLACE_RMS[2][variant % PLACE_RMS[2].length], 0.98, 0.25);
}
/**
 * オルゴールのなで上げ（1.3 秒）: 円筒がくしの歯を駆け上がる「ティロリン、ティロリン」。1 回目は低い歯から top まで約 0.1 秒、2 回目は top の 1 オクターブ下から。
 * top の歯は 2 回目のあとで長く響く。top はバーチャイムと同じ高さ（2〜4.5kHz。連鎖が進むほど高い）。高い歯の上の部分音は、聞こえる帯域の外へ出る
 */
function musicBoxRun(sr, top) {
  const out = new Float32Array(Math.round(sr * SHALAN_LENGTH));
  const flicks = [{ at: 0, dur: 0.11, seq: RUN_BELOW, level: 0.8, tail: 0.35 }, { at: 0.2, dur: 0.065, seq: RUN_BELOW.slice(5), level: 0.9, tail: 0.8 }];
  flicks.forEach((fl, j) => {
    fl.seq.forEach((below, k) => {
      const rand = rng(0x6c2f8a35 + below * 7919 + j * 104729), u = k / fl.seq.length;
      const f = top * Math.pow(2, -below / 12), last = below === 0;
      const at = Math.max(0, fl.at + (fl.dur * k) / (fl.seq.length - 1) + (rand() - 0.5) * 0.002);
      const gain = last ? 0.5 * fl.level : (0.1 + 0.28 * u * u) * (0.85 + rand() * 0.3) * fl.level;
      tineNote(out, sr, f, at, gain, last ? fl.tail : 0.12 + 0.12 * u, rand);
    });
  });
  addEchoes(out, sr, [0.047, 0.109], [0.16, 0.09]);
  return finishLoud(out, sr, SHALAN_RMS, 0.98);
}
/** オルゴールの 1 音（1 秒）: 歯を 1 本弾く。f = 基本の高さ（Hz）。高さが違っても同じ大きさ */
function musicBoxNote(sr, f) {
  const out = new Float32Array(Math.round(sr * BELL_LENGTH)), rand = rng(0x5d3b9e27 + Math.round(f) * 31);
  tineNote(out, sr, f, 0, 1, tineRing(f), rand);
  addEchoes(out, sr, [0.047, 0.101], [0.14, 0.08]);
  return finishLoud(out, sr, BELL_RMS, 0.98, 0.4);
}

/** 置く音（kit: 0 = ガラスのコップ / 1 = 木琴 / 2 = オルゴール）。variant = 高さ違い（0〜3） */
export function placeBuffer(sr, variant = 0, kit = 0) {
  return kit === 1 ? marimbaPlace(sr, variant) : kit === 2 ? musicBoxPlace(sr, variant) : glassBuffer(sr, variant);
}
/** シャラン（kit 0 = バーチャイム / 1 = 木琴のなで上げ / 2 = オルゴールのなで上げ）。top = 最後の音の高さ（Hz） */
export function chimeBuffer(sr, top = SHALAN_TOP, kit = 0) {
  return kit === 1 ? marimbaRun(sr, top) : kit === 2 ? musicBoxRun(sr, top) : shalanBuffer(sr, top);
}
/** 旋律の 1 音（kit 0 = 鈴 / 1 = 木琴 / 2 = オルゴール）。f = 基本の高さ（Hz） */
export function noteBuffer(sr, f = 700, kit = 0) {
  return kit === 1 ? marimbaNote(sr, f) : kit === 2 ? musicBoxNote(sr, f) : bellBuffer(sr, f);
}

/** 最大の振幅（テスト・音量合わせ用） */
export function peakOf(buf) { let m = 0; for (let i = 0; i < buf.length; i++) { const v = Math.abs(buf[i]); if (v > m) m = v; } return m; }
/** 2 乗平均平方根（音の大きさの目安） */
export function rmsOf(buf, from = 0, to = buf.length) { let s = 0; for (let i = from; i < to; i++) s += buf[i] * buf[i]; return Math.sqrt(s / Math.max(1, to - from)); }

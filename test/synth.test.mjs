import test from 'node:test';
import assert from 'node:assert/strict';
import { glassBuffer, shalanBuffer, bellBuffer, placeBuffer, chimeBuffer, noteBuffer, KITS, PLACE_VARIANTS, rng, peakOf, rmsOf, GLASS_VARIANTS, SHALAN_LOW, SHALAN_LENGTH, BELL_LENGTH } from '../src/ui/synth.js?v=202610091208';

const SR = 48000;
/** 時刻 t0〜t1（秒）の、周波数 f（Hz）の成分の大きさ（Goertzel 法）。窓は Hann */
function power(x, f, t0, t1) {
  const a = Math.round(t0 * SR), b = Math.min(x.length, Math.round(t1 * SR)), n = b - a, w = (2 * Math.PI * f) / SR;
  let re = 0, im = 0;
  for (let i = 0; i < n; i++) { const v = x[a + i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1))); re += v * Math.cos(w * i); im -= v * Math.sin(w * i); }
  return Math.hypot(re, im) / n;
}
/** f の近く（±2%）で一番大きい成分（うなりや再生の速さのずれを許す） */
const near = (x, f, t0, t1) => Math.max(...[0.98, 0.99, 1, 1.01, 1.02].map((k) => power(x, f * k, t0, t1)));
const db = (a, b) => 20 * Math.log10(a / b);

test('乱数は固定シードで、同じ並びを返す', () => {
  const a = rng(5), b = rng(5), c = rng(6);
  const A = Array.from({ length: 5 }, a), B = Array.from({ length: 5 }, b), C = Array.from({ length: 5 }, c);
  assert.deepEqual(A, B); assert.notDeepEqual(A, C);
  assert.ok(A.every((v) => v >= 0 && v < 1));
});

test('ガラスを置く音: 有限で、音量がそろい、最後は 0 になり、毎回同じ波形。コップごとに違う', () => {
  const all = Array.from({ length: GLASS_VARIANTS }, (_, v) => glassBuffer(SR, v));
  for (const x of all) {
    assert.equal(x.length, SR * 0.5);
    assert.ok(x.every(Number.isFinite));
    assert.ok(Math.abs(peakOf(x) - 0.9) < 1e-6);
    assert.ok(Math.abs(x[x.length - 1]) < 1e-6, '最後はぷつっと鳴らない');
  }
  assert.deepEqual(glassBuffer(SR, 2), glassBuffer(SR, 2));
  for (let i = 1; i < all.length; i++) assert.notDeepEqual(all[0], all[i]);
});

test('ガラスを置く音: 速く消える短い音（0.35 秒以降はほぼ無音）で、立ち上がりに「カチッ」がある', () => {
  const x = glassBuffer(SR, 0);
  assert.ok(rmsOf(x, 0, SR * 0.1) > 20 * rmsOf(x, SR * 0.35, SR * 0.5), '余韻は 0.3 秒ほどで消える');
  const head = rmsOf(x, 0, SR * 0.002), body = rmsOf(x, SR * 0.1, SR * 0.2);
  assert.ok(head > body * 3, '接触の瞬間が、そのあとの響きより強い');
});

test('ガラスを置く音: 共鳴は整数倍でない部分音（1 : 2.83 : 5.42）で、高い部分音ほど速く消える', () => {
  const f1 = 1760, x = glassBuffer(SR, 0);
  const early = (f) => near(x, f, 0.003, 0.05);
  // 薄いガラスの曲げ振動の部分音は強く、整数倍（2 倍・3 倍）はほとんど無い
  assert.ok(db(early(f1 * 2.83), early(f1 * 2)) > 12, '2.83 倍は 2 倍よりずっと強い');
  assert.ok(db(early(f1 * 5.42), early(f1 * 3)) > 6 || early(f1 * 5.42) > early(f1 * 3), '5.42 倍は 3 倍より強い');
  assert.ok(db(early(f1), early(f1 * 5.42)) < 25, '高い部分音も聞こえる大きさで鳴る');
  // 基本は 0.1 秒後にもまだ鳴っているが、高い部分音は先に消える
  const late = (f) => near(x, f, 0.12, 0.2);
  assert.ok(db(late(f1), late(f1 * 2.83)) > db(early(f1), early(f1 * 2.83)) + 6, '2.83 倍は基本より速く消える');
  assert.ok(db(late(f1 * 2.83), late(f1 * 5.42)) > 6, '5.42 倍はさらに速く消える');
});

test('ガラスを置く音: 底がテーブルに当たる低い「コツ」（約 200Hz）が最初の数十 ms にだけある', () => {
  const x = glassBuffer(SR, 0);
  const tok = (t0, t1) => Math.max(...[170, 185, 200, 215].map((f) => power(x, f, t0, t1)));
  assert.ok(db(tok(0, 0.04), tok(0.1, 0.14)) > 20);
});

/** 高さ（最後のバーの Hz）。sfx.js の shalanTop が返す、連鎖 1〜6 の高さ */
const TOPS = [2220, 2492, 2797, 3326, 3734, 4440];
/** 20ms ごとの RMS の包絡で、最大から db 下がった最初の時刻（秒。最大より後） */
function fallTime(x, db) {
  const w = Math.round(SR * 0.02), env = [];
  for (let i = 0; i + w <= x.length; i += w) env.push(rmsOf(x, i, i + w));
  const pk = Math.max(...env), th = pk * Math.pow(10, -db / 20);
  for (let i = env.indexOf(pk); i < env.length; i++) if (env[i] < th) return (i * w) / SR;
  return Infinity;
}
/** バー（基本の高さ f）が鳴り始める時刻（秒）: f の成分が、そのあとの最大の 25% を初めて超える 10ms の窓 */
function onset(x, f, t1 = 0.4) {
  const max = Math.max(...Array.from({ length: 80 }, (_, i) => near(x, f, i * 0.005, i * 0.005 + 0.01)));
  for (let t = 0; t < t1; t += 0.002) if (near(x, f, t, t + 0.01) > max * 0.25) return t;
  return Infinity;
}
/** 窓（Hann）をかけた n サンプル（x[start〜]）の各周波数のパワー（0〜n/2 番目）。基数 2 の FFT */
function fftPower(x, start, n) {
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < n; i++) re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1)));
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j], re[i]]; }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  return Array.from({ length: n / 2 }, (_, k) => re[k] * re[k] + im[k] * im[k]);
}
/** 時刻 t（秒）からの約 10ms の窓の、f0 Hz 以上のパワー */
function bandFrom(x, t, f0) {
  const n = 512, p = fftPower(x, Math.round(t * SR), n);
  return p.slice(Math.ceil((f0 * n) / SR)).reduce((s, v) => s + v, 0);
}
const dbPower = (a, b) => 10 * Math.log10(a / b);
/** 先頭 t1 秒の、f0 Hz 以上にあるパワーの割合（4096 点の窓を半分ずつずらして平均） */
function shareAbove(x, f0, t1) {
  const n = 4096, total = new Array(n / 2).fill(0);
  for (let st = 0; st + n <= SR * t1; st += n / 2) fftPower(x, st, n).forEach((v, k) => { total[k] += v; });
  return total.slice(Math.ceil((f0 * n) / SR)).reduce((a, v) => a + v, 0) / total.reduce((a, v) => a + v, 0);
}

test('シャラン: 有限で、最後は 0 になり、毎回同じ波形。高さごとに違う。長さ（1.3 秒）は高さによらず同じ', () => {
  const all = TOPS.map((top) => shalanBuffer(SR, top));
  for (const x of all) {
    assert.equal(x.length, Math.round(SR * SHALAN_LENGTH));
    assert.ok(x.every(Number.isFinite));
    assert.ok(peakOf(x) <= 0.98 + 1e-6 && peakOf(x) > 0.3, `ピーク ${peakOf(x)}`);
    assert.ok(Math.abs(x[x.length - 1]) < 1e-6, '最後はぷつっと鳴らない');
  }
  assert.deepEqual(shalanBuffer(SR, 3326), shalanBuffer(SR, 3326));
  for (let i = 1; i < all.length; i++) assert.notDeepEqual(all[0], all[i]);
  assert.equal(shalanBuffer(SR).length, all[0].length, '既定の高さも同じ長さ');
});

test('シャラン: 高さによらず同じ大きさ（先頭 1 秒の RMS）と、同じ聞こえる長さ（−40dB まで 0.55〜0.95 秒）', () => {
  const rms = TOPS.map((top) => rmsOf(shalanBuffer(SR, top), 0, SR));
  const mean = rms.reduce((s, v) => s + v, 0) / rms.length;
  assert.ok(mean > 0.068 && mean < 0.082, `平均 ${mean.toFixed(4)}`);
  rms.forEach((v, i) => assert.ok(Math.abs(v / mean - 1) < 0.06, `${TOPS[i]}Hz: RMS ${v.toFixed(4)}（平均 ${mean.toFixed(4)}）`));
  for (const top of TOPS) {
    const t = fallTime(shalanBuffer(SR, top), 40);
    assert.ok(t >= 0.55 && t <= 0.95, `${top}Hz: −40dB まで ${t}s`);
  }
});

test('シャラン: 半音ごとのバーが低い方から約 0.12 秒で順に駆け上がり（1 回目）、最後のバーが主役になる', () => {
  const top = 2220, steps = 12;                        // 1.1kHz → 2.2kHz は 12 半音
  const bar = (below) => top * Math.pow(2, -below / 12);
  const times = [12, 9, 6, 3].map((b) => onset(shalanBuffer(SR, top), bar(b)));
  for (let i = 1; i < times.length; i++) assert.ok(times[i] > times[i - 1], `低いバーから順に: ${times.map((t) => t.toFixed(3)).join(' < ')}`);
  assert.ok(times[0] < 0.04 && times[3] < 0.11, '約 0.12 秒で駆け上がる');
  const last = onset(shalanBuffer(SR, top), top);
  assert.ok(Math.abs(last - (0.115 + 0.008)) < 0.012, `最後のバーは駆け上がりの直後: ${last}`);
  assert.equal(steps, Math.round(12 * Math.log2(top / SHALAN_LOW)));
  const x = shalanBuffer(SR, top);
  assert.ok(near(x, SHALAN_LOW, 0, 0.03) > near(x, SHALAN_LOW * 0.75, 0, 0.03) * 5, '一番低いバーは約 1.1kHz');
});

test('シャン、シャン: 4kHz 以上が約 0.12 秒と約 0.28 秒の 2 回はじけ、その間（0.16〜0.22 秒）は 12dB 以上静まる（どの高さでも）', () => {
  for (const top of [2220, 3326, 4440]) {
    const x = shalanBuffer(SR, top), hi = (t) => bandFrom(x, t, 4000);
    const grid = (a, b) => { const out = []; for (let t = a; t <= b + 1e-9; t += 0.004) out.push(hi(t)); return out; };
    const first = Math.max(...grid(0.105, 0.14)), second = Math.max(...grid(0.265, 0.3)), gap = Math.min(...grid(0.16, 0.22));
    assert.ok(dbPower(first, gap) > 12, `${top}Hz: 1 回目 ${dbPower(first, gap).toFixed(1)}dB`);
    assert.ok(dbPower(second, gap) > 12, `${top}Hz: 2 回目 ${dbPower(second, gap).toFixed(1)}dB`);
  }
});

test('耳に痛くない: 先頭 0.6 秒のパワーのうち 4kHz 以上は 2 割以下（高い部分音と「シャッ」の雑音を控えめにした。以前は 2 割以上で、尖りすぎた）', () => {
  for (const top of [2220, 2492, 2797, 3326, 3734]) {
    const hi = shareAbove(shalanBuffer(SR, top), 4000, 0.6);
    assert.ok(hi < 0.2, `${top}Hz: 4kHz 以上は ${hi.toFixed(2)}`);
  }
});

test('シャラン: 最後のバーだけが長く響き、金属のバーの部分音（2.756 倍・5.404 倍）が乗る。整数倍（2 倍・3 倍）は無い', () => {
  for (const top of [2220, 3326]) {
    const x = shalanBuffer(SR, top);
    const late = (f) => near(x, f, 0.35, 0.5);
    assert.ok(db(late(top), late(top * 1.19)) > 30, `${top}Hz: 最後のバーがはっきり主役`);
    assert.ok(late(top * 2.756) > late(top * 2) * 5 && late(top * 2.756) > late(top * 3) * 5, '2.756 倍は 2 倍・3 倍より強い');
    assert.ok(near(x, top * 5.404, 0.2, 0.3) > near(x, top * 5, 0.2, 0.3) * 2 || top * 5.404 > SR * 0.45);
    assert.ok(db(late(top), near(x, top, 0.8, 0.95)) > 15, '0.4 秒後から消えていく');
    assert.ok(rmsOf(x, Math.round(SR * 1.15), x.length) < rmsOf(x, Math.round(SR * 0.2), Math.round(SR * 0.4)) * 0.01, '最後は消えている');
  }
});

test('シャラン: ペンタトニックの音のバー（最後のバーの 3・5・8・10・12 半音下）は、隣の半音のバーより大きく長く鳴る（最後に残るのは濁らない音）', () => {
  const top = 2220, steps = 12, x = shalanBuffer(SR, top);
  // 叩かれた 0.015〜0.075 秒後の大きさ（叩かれる時刻は、駆け上がり 0.115 秒を 12 等分したもの。こだま（83ms 後）は除く）
  const level = (below) => { const t = (0.115 * (steps - below)) / steps; return near(x, top * Math.pow(2, -below / 12), t + 0.015, t + 0.075); };
  for (const [main, filler] of [[3, 2], [3, 4], [5, 4], [5, 6], [8, 7], [8, 9], [10, 9], [10, 11], [12, 11]]) {
    assert.ok(level(main) > level(filler) * 1.8, `${main} 半音下 ${level(main).toExponential(2)} > ${filler} 半音下 ${level(filler).toExponential(2)}`);
  }
});

/* ---- 鈴 ---- */
const BELLS = [440, 554, 740, 932, 1109, 1865];

test('鈴: 有限で、最後は 0 になり、毎回同じ波形。高さごとに違い、高さによらず同じ大きさ（先頭 0.4 秒の RMS）', () => {
  const all = BELLS.map((f) => bellBuffer(SR, f));
  for (const x of all) {
    assert.equal(x.length, Math.round(SR * BELL_LENGTH));
    assert.ok(x.every(Number.isFinite));
    assert.ok(peakOf(x) <= 0.98 + 1e-6 && peakOf(x) > 0.3, `ピーク ${peakOf(x)}`);
    assert.ok(Math.abs(x[x.length - 1]) < 1e-6, '最後はぷつっと鳴らない');
    assert.ok(Math.abs(rmsOf(x, 0, SR * 0.4) / 0.1 - 1) < 0.05, `RMS ${rmsOf(x, 0, SR * 0.4)}`);
  }
  assert.deepEqual(bellBuffer(SR, 554), bellBuffer(SR, 554));
  for (let i = 1; i < all.length; i++) assert.notDeepEqual(all[0], all[i]);
});

test('鈴: 正弦波 1 本ではなく、基本・オクターブ・金属の部分音（2.756 倍・5.404 倍）・胴の低い響き（0.5 倍）が重なる。基本が占めるのは 85% 以下', () => {
  for (const f of BELLS) {
    const x = bellBuffer(SR, f), early = (r) => near(x, f * r, 0.01, 0.06);
    assert.ok(db(early(2), early(1)) > -18, `${f}Hz: オクターブ上 ${db(early(2), early(1)).toFixed(1)}dB`);
    assert.ok(db(early(2.756), early(1)) > -20, `${f}Hz: 2.756 倍 ${db(early(2.756), early(1)).toFixed(1)}dB`);
    assert.ok(db(early(2.756), early(2.5)) > 12 && db(early(2.756), early(2.9)) > 8, `${f}Hz: 2.756 倍は、近くの整数倍より強い（整数でない金属の比）`);
    assert.ok(db(early(0.5), early(1)) > -20, `${f}Hz: 胴の低い響き ${db(early(0.5), early(1)).toFixed(1)}dB`);
    const n = 4096, tot = new Array(n / 2).fill(0);
    for (let st = 0; st + n <= SR * 0.3; st += n / 2) fftPower(x, st, n).forEach((v, k) => { tot[k] += v; });
    const k0 = Math.floor((f * 0.97 * n) / SR), k1 = Math.ceil((f * 1.03 * n) / SR);
    const main = tot.slice(k0, k1 + 1).reduce((a, v) => a + v, 0) / tot.reduce((a, v) => a + v, 0);
    assert.ok(main < 0.85, `${f}Hz: 基本が占める割合 ${main.toFixed(2)}`);
  }
});

test('鈴: 高い部分音ほど速く消え（基本 > オクターブ > 2.756 倍 > 5.404 倍）、高い鈴ほど短く響く（−40dB まで 0.25〜0.7 秒）', () => {
  for (const f of [440, 554, 932]) {
    const x = bellBuffer(SR, f), drop = (r) => db(near(x, f * r, 0.12, 0.2), near(x, f * r, 0.01, 0.06));
    assert.ok(drop(1) > drop(2) && drop(2) > drop(2.756) && drop(2.756) > drop(5.404), `${f}Hz: ${[1, 2, 2.756, 5.404].map((r) => drop(r).toFixed(1)).join(' > ')}`);
    assert.ok(drop(5.404) < -25, `${f}Hz: 5.404 倍は打った瞬間の「チン」だけ`);
  }
  const fall = BELLS.map((f) => fallTime(bellBuffer(SR, f), 40));
  fall.forEach((t, i) => assert.ok(t >= 0.25 && t <= 0.7, `${BELLS[i]}Hz: −40dB まで ${t}s`));
  assert.ok(fall[0] > fall[fall.length - 1] + 0.1, '低い鈴ほど長く響く');
});

test('鈴: スマホの小さなスピーカー（450Hz 以下が出ない）でも、パワーの 8 割以上が 450Hz より上にある（ゴールの音 555Hz〜。前の 277Hz の正弦波は 0）', () => {
  for (const f of [555, 740, 932, 1865]) assert.ok(shareAbove(bellBuffer(SR, f), 450, 0.4) > 0.8, `${f}Hz: ${shareAbove(bellBuffer(SR, f), 450, 0.4).toFixed(2)}`);
});

test('44.1kHz でも作れて、ナイキスト周波数を超える部分音は足さない（折り返しの雑音を出さない）', () => {
  for (const sr of [22050, 44100]) {
    for (const x of [glassBuffer(sr, 1), shalanBuffer(sr, 3326), bellBuffer(sr, 932)]) {
      assert.ok(x.every(Number.isFinite));
      assert.ok(peakOf(x) > 0.3 && peakOf(x) <= 0.98 + 1e-6);
    }
  }
});

/* =====================================================================
 * 音のセット: 木琴・オルゴール（置く音・シャラン・鈴）
 * ===================================================================== */
/** 先頭 secs 秒の、耳の感度（A 特性）で重みづけした大きさ（dB）。スマホの小さなスピーカー（350Hz 以下が弱い）と出口の 9.5kHz のローパスも掛ける */
function loudA(x, secs) {
  const n = 1 << Math.ceil(Math.log2(SR * secs)), re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < Math.min(x.length, Math.round(SR * secs)); i++) re[i] = x[i];
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) [re[i], re[j]] = [re[j], re[i]]; }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
  let e = 0;
  for (let k = 1; k < n / 2; k++) {
    const f = (k * SR) / n, f2 = f * f;
    let g = (12194 ** 2 * f2 * f2) / ((f2 + 20.6 ** 2) * Math.sqrt((f2 + 107.7 ** 2) * (f2 + 737.9 ** 2)) * (f2 + 12194 ** 2)) * Math.pow(10, 2 / 20);
    if (f > 9500) g *= Math.pow(9500 / f, 6);
    if (f < 350) g *= Math.pow(f / 350, 3);
    e += (re[k] ** 2 + im[k] ** 2) * g * g;
  }
  return 10 * Math.log10(e / (n * n) + 1e-30);
}
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

test('音のセット: ガラス・木琴・オルゴール。セット 0 は今までのガラス・バーチャイム・鈴と同じ波形で、範囲外のセットもガラスになる', () => {
  assert.deepEqual(KITS, ['glass', 'marimba', 'musicbox']);
  assert.equal(PLACE_VARIANTS, GLASS_VARIANTS);
  for (let v = 0; v < PLACE_VARIANTS; v++) assert.deepEqual(placeBuffer(SR, v, 0), glassBuffer(SR, v));
  assert.deepEqual(chimeBuffer(SR, 3326, 0), shalanBuffer(SR, 3326));
  assert.deepEqual(noteBuffer(SR, 700, 0), bellBuffer(SR, 700));
  assert.deepEqual(placeBuffer(SR, 1, 9), glassBuffer(SR, 1)); assert.deepEqual(noteBuffer(SR, 700, -1), bellBuffer(SR, 700));
  assert.deepEqual(placeBuffer(SR, 2), glassBuffer(SR, 2), '既定はガラス');
});

test('木琴・オルゴール: 置く音・シャラン・鈴は有限で、最後は 0 になり、毎回同じ波形（高さごと・セットごとに違う）。長さは既存と同じ', () => {
  for (const kit of [1, 2]) {
    const places = Array.from({ length: PLACE_VARIANTS }, (_, v) => placeBuffer(SR, v, kit));
    for (const x of places) {
      assert.equal(x.length, Math.round(SR * (kit === 1 ? 0.45 : 0.5)));
      assert.ok(x.every(Number.isFinite)); assert.ok(peakOf(x) > 0.3 && peakOf(x) <= 0.98 + 1e-6, `置く音 ${peakOf(x)}`);
      assert.ok(Math.abs(x[x.length - 1]) < 1e-6, '最後はぷつっと鳴らない');
      assert.ok(Math.abs(x.reduce((s, v) => s + v, 0) / x.length) < 1e-3, '直流が乗らない');
    }
    for (let i = 1; i < places.length; i++) assert.notDeepEqual(places[0], places[i]);
    assert.deepEqual(placeBuffer(SR, 2, kit), placeBuffer(SR, 2, kit));
    assert.notDeepEqual(placeBuffer(SR, 0, kit), placeBuffer(SR, 0, 0));
    const chimes = TOPS.map((top) => chimeBuffer(SR, top, kit));
    for (const x of chimes) {
      assert.equal(x.length, Math.round(SR * SHALAN_LENGTH));
      assert.ok(x.every(Number.isFinite)); assert.ok(peakOf(x) > 0.3 && peakOf(x) <= 0.98 + 1e-6, `シャラン ${peakOf(x)}`);
      assert.ok(Math.abs(x[x.length - 1]) < 1e-6);
    }
    for (let i = 1; i < chimes.length; i++) assert.notDeepEqual(chimes[0], chimes[i]);
    assert.deepEqual(chimeBuffer(SR, 3326, kit), chimeBuffer(SR, 3326, kit));
    const notes = BELLS.map((f) => noteBuffer(SR, f, kit));
    for (const x of notes) {
      assert.equal(x.length, Math.round(SR * BELL_LENGTH));
      assert.ok(x.every(Number.isFinite)); assert.ok(peakOf(x) > 0.2 && peakOf(x) <= 0.98 + 1e-6, `鈴 ${peakOf(x)}`);
      assert.ok(Math.abs(x[x.length - 1]) < 1e-6);
      assert.ok(Math.abs(rmsOf(x, 0, SR * 0.4) / 0.1 - 1) < 0.05, `RMS ${rmsOf(x, 0, SR * 0.4)}`);
    }
    for (let i = 1; i < notes.length; i++) assert.notDeepEqual(notes[0], notes[i]);
    assert.deepEqual(noteBuffer(SR, 554, kit), noteBuffer(SR, 554, kit));
  }
});

test('音のセットを替えても、置く音・シャラン・鈴の耳への大きさは同じ（A 特性。ガラスとの差が 1dB 以内、高さ違いの差も 1dB 以内）', () => {
  const place = (kit) => Array.from({ length: PLACE_VARIANTS }, (_, v) => loudA(placeBuffer(SR, v, kit), 0.25));
  const ref = mean(place(0));
  for (const kit of [1, 2]) {
    const l = place(kit);
    assert.ok(Math.abs(mean(l) - ref) < 1, `置く音 ${KITS[kit]}: ${mean(l).toFixed(1)} dB（ガラス ${ref.toFixed(1)}）`);
    for (const v of l) assert.ok(Math.abs(v - mean(l)) < 1, `高さ違いのばらつき ${l.map((x) => x.toFixed(1))}`);
  }
  const STEPS = Array.from({ length: 11 }, (_, k) => 392 * 2 ** (k / 4));          // 鈴の波形は、この 11 段の高さで作る（sfx.js）
  const chime = (kit) => TOPS.map((top) => loudA(chimeBuffer(SR, top, kit), 1));
  const note = (kit) => STEPS.map((f) => loudA(noteBuffer(SR, f, kit), 0.4));
  for (const kit of [1, 2]) {
    chime(kit).forEach((v, i) => assert.ok(Math.abs(v - chime(0)[i]) < 1.5, `シャラン ${KITS[kit]} ${TOPS[i]}Hz: ${v.toFixed(1)} dB（バーチャイム ${chime(0)[i].toFixed(1)}）`));
    note(kit).forEach((v, i) => assert.ok(Math.abs(v - note(0)[i]) < 1.5, `鈴 ${KITS[kit]} ${Math.round(STEPS[i])}Hz: ${v.toFixed(1)} dB（鈴 ${note(0)[i].toFixed(1)}）`));
  }
});

test('木琴: 部分音は基本の 1 : 約 4 : 約 10 倍（整数に近い比 = 音の高さがはっきり）。金属の棒の 2.756 倍・5.404 倍ではなく、胴の低い響き（0.5 倍）がある', () => {
  for (const f of [440, 700, 932]) {
    const x = noteBuffer(SR, f, 1), early = (r) => near(x, f * r, 0.004, 0.08);
    assert.ok(db(early(3.97), early(1)) > -32 && db(early(3.97), early(1)) < -8, `${f}Hz: 4 倍の部分音 ${db(early(3.97), early(1)).toFixed(1)}dB`);
    assert.ok(early(3.97) > early(2.756) * 4 && early(3.97) > early(3) * 3, `${f}Hz: 4 倍は、金属の 2.756 倍・整数の 3 倍より強い`);
    assert.ok(db(early(0.5), early(1)) > -30, `${f}Hz: 共鳴管の低い響き ${db(early(0.5), early(1)).toFixed(1)}dB`);
    assert.ok(db(early(1), near(x, f, 0.5, 0.6)) > 6, '基本はゆっくり消える');
    const late = (r) => near(x, f * r, 0.2, 0.3);
    assert.ok(db(early(3.97), late(3.97)) > db(early(1), late(1)) + 6, '高い部分音は基本より速く消える');
  }
  // 置く音の基本の高さ（ミ・ソ・レ・ラ）
  [659.26, 783.99, 587.33, 880].forEach((f, v) => {
    const x = placeBuffer(SR, v, 1);
    assert.ok(near(x, f, 0.01, 0.1) > near(x, f * 1.12, 0.01, 0.1) * 8 && near(x, f, 0.01, 0.1) > near(x, f * 0.89, 0.01, 0.1) * 8, `${f}Hz が主役`);
  });
});

test('オルゴール: くしの歯の部分音は基本の 1 : 6.27 : 17.55 倍（金属の棒の 2.756 倍より、ずっと高く離れる）。基本が澄んで、高い「チリン」はすぐ消える', () => {
  for (const f of [440, 700, 932]) {
    const x = noteBuffer(SR, f, 2), early = (r) => near(x, f * r, 0.003, 0.06);
    assert.ok(db(early(6.267), early(1)) > -30 && db(early(6.267), early(1)) < -6, `${f}Hz: 6.27 倍 ${db(early(6.267), early(1)).toFixed(1)}dB`);
    assert.ok(early(6.267) > early(2.756) * 6 && early(6.267) > early(5) * 3, `${f}Hz: 6.27 倍は 2.756 倍・5 倍より強い`);
    assert.ok(db(early(6.267), near(x, f * 6.267, 0.2, 0.3)) > db(early(1), near(x, f, 0.2, 0.3)) + 10, '高い部分音は基本よりずっと速く消える');
    assert.ok(db(early(1), near(x, f, 0.5, 0.6)) < 40, '基本は 0.5 秒すぎても鳴っている');
  }
  [1046.5, 1174.7, 880, 1318.5].forEach((f, v) => {
    const x = placeBuffer(SR, v, 2);
    assert.ok(near(x, f, 0.01, 0.1) > near(x, f * 1.12, 0.01, 0.1) * 8 && near(x, f, 0.01, 0.1) > near(x, f * 0.89, 0.01, 0.1) * 8, `${f}Hz が主役`);
    assert.ok(near(x, f * 6.267, 0.003, 0.05) > 0 && f * 6.267 < 9500, '上の部分音が出口のローパス（9.5kHz）より下に入る高さ');
  });
});

test('木琴・オルゴールの置く音: 底がテーブルに当たる低い胴鳴り（約 200Hz）が最初の数十 ms にだけあり、置く音は 0.35 秒以降ほぼ無音', () => {
  for (const kit of [1, 2]) for (let v = 0; v < PLACE_VARIANTS; v++) {
    const x = placeBuffer(SR, v, kit);
    const thud = (t0, t1) => Math.max(...[170, 190, 210, 230].map((f) => power(x, f, t0, t1)));
    assert.ok(db(thud(0, 0.04), thud(0.12, 0.16)) > 14, `${KITS[kit]} v${v}: 胴鳴り ${db(thud(0, 0.04), thud(0.12, 0.16)).toFixed(1)}dB`);
    assert.ok(rmsOf(x, 0, SR * 0.1) > 15 * rmsOf(x, SR * 0.35, x.length), '余韻は 0.3 秒ほどで消える');
  }
});

test('木琴・オルゴールのシャラン: 低い音から top まで駆け上がる 2 回のなで上げ（1 回目 → 2 回目）で、最後の音が長く響く。最後の音は連鎖ごとの高さ', () => {
  for (const [kit, fold] of [[1, 0.5], [2, 1]]) {
    for (const top of [2220, 3326]) {
      const x = chimeBuffer(SR, top, kit), last = top * fold;
      const t = (f, a, b) => near(x, f, a, b);
      assert.ok(db(t(last, 0.5, 0.8), t(last * 1.19, 0.5, 0.8)) > 14, `${KITS[kit]} ${top}: 最後の音が主役`);
      assert.ok(t(last, 0.5, 0.8) > t(last, 1.1, 1.25) * 2.5, '0.5 秒すぎから消えていく');
      assert.ok(rmsOf(x, Math.round(SR * 1.15), x.length) < rmsOf(x, Math.round(SR * 0.2), Math.round(SR * 0.4)) * 0.03, '最後は消えている');
      const o = (b) => onset(x, last * Math.pow(2, -b / 12), 0.35);
      assert.ok(o(22) < o(12) && o(12) < o(5) && o(5) < o(0), `${KITS[kit]} ${top}: 低い音から順に駆け上がる ${[22, 12, 5, 0].map((b) => o(b).toFixed(3)).join(' < ')}`);
      const second = rmsOf(x, Math.round(SR * 0.22), Math.round(SR * 0.32)), tail = rmsOf(x, Math.round(SR * 0.95), Math.round(SR * 1.05));
      assert.ok(second > tail * 8, '2 回目のなで上げのあとから、静かに消えていく');
    }
  }
});

test('木琴・オルゴールのシャラン: 5 回の高さ違い（連鎖 1〜6）でも同じ大きさ（先頭 1 秒の RMS）で、聞こえる長さがそろう', () => {
  for (const kit of [1, 2]) {
    const rms = TOPS.map((top) => rmsOf(chimeBuffer(SR, top, kit), 0, SR)), m = mean(rms);
    assert.ok(m > 0.068 && m < 0.082, `${KITS[kit]} 平均 ${m.toFixed(4)}`);
    rms.forEach((v, i) => assert.ok(Math.abs(v / m - 1) < 0.07, `${KITS[kit]} ${TOPS[i]}Hz: RMS ${v.toFixed(4)}`));
    for (const top of TOPS) { const t = fallTime(chimeBuffer(SR, top, kit), 40); assert.ok(t >= 0.5 && t <= 1, `${KITS[kit]} ${top}Hz: −40dB まで ${t}s`); }
  }
});

test('スマホの小さなスピーカー（450Hz 以下が出ない）でも、木琴・オルゴールの鈴は聞こえる（パワーの 7 割以上が 450Hz より上）', () => {
  for (const kit of [1, 2]) for (const f of [555, 740, 932, 1865]) assert.ok(shareAbove(noteBuffer(SR, f, kit), 450, 0.4) > 0.7, `${KITS[kit]} ${f}Hz: ${shareAbove(noteBuffer(SR, f, kit), 450, 0.4).toFixed(2)}`);
});

test('木琴・オルゴールも 44.1kHz / 22.05kHz で作れて、ナイキスト周波数を超える部分音は足さない', () => {
  for (const sr of [22050, 44100]) for (const kit of [1, 2]) {
    for (const x of [placeBuffer(sr, 1, kit), chimeBuffer(sr, 4440, kit), noteBuffer(sr, 1865, kit)]) {
      assert.ok(x.every(Number.isFinite));
      assert.ok(peakOf(x) > 0.2 && peakOf(x) <= 0.98 + 1e-6);
    }
  }
});

test('セットごとの音色の違い: 木琴は低く温かく（置く音の中心が約 1kHz 以下）、オルゴールは中間、ガラスは高い（約 2.5kHz 以上）', () => {
  const centroid = (x) => { const n = 4096, p = fftPower(x, Math.round(SR * 0.002), n); let a = 0, b = 0; p.forEach((v, k) => { a += v * ((k * SR) / n); b += v; }); return a / b; };
  const c = [0, 1, 2].map((kit) => mean(Array.from({ length: PLACE_VARIANTS }, (_, v) => centroid(placeBuffer(SR, v, kit)))));
  assert.ok(c[1] < 1100 && c[1] < c[2] && c[2] < c[0] && c[0] > 2500, `中心 ${c.map(Math.round)}`);
});

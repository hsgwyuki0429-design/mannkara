import test from 'node:test';
import assert from 'node:assert/strict';
import { glassBuffer, shalanBuffer, rng, peakOf, rmsOf, GLASS_VARIANTS, SHALAN_LOW, SHALAN_LENGTH } from '../src/ui/synth.js?v=202610021033';

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

test('尖った音: 先頭 0.6 秒のパワーの 2 割以上が 4kHz 以上にある（硬く叩いた高い部分音と、擦れ合う「シャッ」の雑音）', () => {
  for (const top of [2220, 2492, 2797]) {              // 最後のバーの基本が 3kHz より下の高さ。4kHz 以上は、部分音と雑音だけ
    const x = shalanBuffer(SR, top), n = 4096, total = new Array(n / 2).fill(0);
    for (let s = 0; s + n <= SR * 0.6; s += n / 2) fftPower(x, s, n).forEach((v, k) => { total[k] += v; });
    const hi = total.slice(Math.ceil((4000 * n) / SR)).reduce((a, v) => a + v, 0), all = total.reduce((a, v) => a + v, 0);
    assert.ok(hi / all > 0.2, `${top}Hz: 4kHz 以上は ${(hi / all).toFixed(2)}`);
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

test('44.1kHz でも作れて、ナイキスト周波数を超える部分音は足さない（折り返しの雑音を出さない）', () => {
  for (const sr of [22050, 44100]) {
    for (const x of [glassBuffer(sr, 1), shalanBuffer(sr, 3326)]) {
      assert.ok(x.every(Number.isFinite));
      assert.ok(peakOf(x) > 0.3 && peakOf(x) <= 0.98 + 1e-6);
    }
  }
});

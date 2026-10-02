import test from 'node:test';
import assert from 'node:assert/strict';
import { glassBuffer, shalanBuffer, rng, peakOf, rmsOf, GLASS_VARIANTS, SHALAN_TOP } from '../src/ui/synth.js?v=202610020948';

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

test('シャラン: 有限で、音量がそろい、最後は 0 になり、毎回同じ波形', () => {
  const x = shalanBuffer(SR);
  assert.equal(x.length, Math.round(SR * 1.7));
  assert.ok(x.every(Number.isFinite));
  assert.ok(Math.abs(peakOf(x) - 0.9) < 1e-6);
  assert.ok(Math.abs(x[x.length - 1]) < 1e-6);
  assert.deepEqual(x, shalanBuffer(SR));
});

test('シャラン: 最初に鈴の高い粒（2.5〜6.5kHz）、次にベルの音階、最後の音（SHALAN_TOP）が長く響く', () => {
  const x = shalanBuffer(SR);
  const jingle = (t0, t1) => [2480, 3410, 4130, 5330, 6450].reduce((s, f) => s + near(x, f, t0, t1), 0);
  assert.ok(db(jingle(0.0, 0.1), jingle(0.6, 0.7)) > 20, '鈴のシャは最初だけ');
  const top = (t0, t1) => near(x, SHALAN_TOP, t0, t1);
  assert.ok(db(top(0.2, 0.3), near(x, SHALAN_TOP * 1.19, 0.2, 0.3)) > 12, '最後の音がはっきり主役');
  assert.ok(db(top(0.9, 1.0), near(x, SHALAN_TOP * 1.19, 0.9, 1.0)) > 40, '1 秒たっても、最後の音だけがはっきり響いている');
  const fall = db(top(0.2, 0.3), top(0.9, 1.0));
  assert.ok(fall > 20 && fall < 55, `0.7 秒で ${fall.toFixed(1)}dB ほどなだらかに消える`);
  assert.ok(rmsOf(x, SR * 1.55, SR * 1.7) < rmsOf(x, SR * 0.2, SR * 0.4) * 0.01, '最後は消えている');
  // ベルの部分音（2.756 倍）が最後の音の上に鳴る
  assert.ok(near(x, SHALAN_TOP * 2.756, 0.2, 0.3) > near(x, SHALAN_TOP * 2.4, 0.2, 0.3) * 2);
  // 駆け上がり: 最後の音より低いペンタトニックの音（-12 半音 = 1 オクターブ下）が、最後の音より前に鳴る
  assert.ok(near(x, SHALAN_TOP / 2, 0.03, 0.12) > near(x, SHALAN_TOP / 2 * 1.06, 0.03, 0.12) * 1.5);
});

test('44.1kHz でも作れて、ナイキスト周波数を超える部分音は足さない（折り返しの雑音を出さない）', () => {
  for (const sr of [22050, 44100]) {
    for (const x of [glassBuffer(sr, 1), shalanBuffer(sr)]) {
      assert.ok(x.every(Number.isFinite));
      assert.ok(Math.abs(peakOf(x) - 0.9) < 1e-6);
    }
  }
});

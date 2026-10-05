import test from 'node:test';
import assert from 'node:assert/strict';
import {
  STRETCH_Y, CUBE, BEVEL, VIEW_ANGLE, localToB, bToLocal, eyeFor, projection, apply4, projectToClient, unprojectClient,
  keyframes, cubicBezier, EASE, platePolygon,
} from '../src/ui/cube3d-math.js?v=202610051321';
import { roundedCube } from '../src/ui/cube3d.js?v=202610051321';
import { ROTATION } from '../src/ui/renderer.js?v=202610051321';

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const VIEWS = [
  { vw: 390, vh: 844, cx: 195, cy: 330, cell: 33 },        // スマホ（縦）
  { vw: 1180, vh: 820, cx: 760, cy: 410, cell: 52 },       // タブレット（横）。盤面は右の列
  { vw: 1080, vh: 1350, cx: 540, cy: 742, cell: 60 },      // 結果カード
];
/** 2D の盤面（renderer.localToWrap と同じ 225° 回転 + 縦 1.04 倍）で、盤面の中心からのずれ */
function wrapOffset(lx, ly, W) {
  const a = (ROTATION * Math.PI) / 180, vx = lx - W / 2, vy = ly - W / 2;
  return { x: vx * Math.cos(a) - vy * Math.sin(a), y: (vx * Math.sin(a) + vy * Math.cos(a)) * STRETCH_Y };
}
const toClient = (view, c) => ({ x: (c[0] / c[3] + 1) * view.vw / 2, y: (1 - c[1] / c[3]) * view.vh / 2 });

test('盤面のローカル座標 → 3D の空間は、2D の盤面と同じ回転（縦に伸ばす前）で、行き来しても変わらない', () => {
  const W = 8 * 33;
  for (const [lx, ly] of [[0, 0], [W, 0], [0, W], [W / 2, W / 2], [17.5, 201.25], [W * 1.1, W * 0.95]]) {
    const b = localToB(lx, ly, W), o = wrapOffset(lx, ly, W);
    assert.ok(near(b.x, o.x) && near(-b.y * STRETCH_Y, o.y), `${lx},${ly}`);
    const back = bToLocal(b.x, b.y, W);
    assert.ok(near(back.x, lx) && near(back.y, ly));
  }
});

test('立方体の高さのまん中の面は、2D の盤面とまったく同じ位置に写る（DOM の重ね表示・当たり判定がそのまま合う）', () => {
  for (const view of VIEWS) {
    const eye = eyeFor(view.cell), P = projection(view, eye, 10, eye.ez + 4000), W = 8 * view.cell;
    for (let x = 0; x <= 9; x++) for (let r = 0; r <= 9; r++) {
      const lx = (x + 0.5) * view.cell, ly = (r + 0.5) * view.cell, b = localToB(lx, ly, W), o = wrapOffset(lx, ly, W);
      const c = toClient(view, apply4(P, b.x, b.y, eye.zRef));
      assert.ok(near(c.x, view.cx + o.x, 1e-6) && near(c.y, view.cy + o.y, 1e-6), `${x},${r}`);
      const d = projectToClient(view, eye, b.x, b.y, eye.zRef);
      assert.ok(near(d.x, c.x, 1e-6) && near(d.y, c.y, 1e-6));
    }
  }
});

test('目は盤面の下にあり、上の方の立方体ほど下の面が大きく見える（下から見上げる）', () => {
  for (const view of VIEWS) {
    const eye = eyeFor(view.cell), cube = CUBE * view.cell;
    assert.ok(eye.ey < 0 && eye.ez > 10 * cube);
    // 盤面の中心を見上げる角度
    assert.ok(near(Math.atan2(-eye.ey, eye.ez - eye.zRef), VIEW_ANGLE, 1e-9));
    // 立方体の手前の面（z = cube）は底（z = 0）より画面の上に写り、その差（＝見えている下の面の高さ）は上の方ほど大きい
    const lift = (y) => projectToClient(view, eye, 0, y, 0).y - projectToClient(view, eye, 0, y, cube).y;
    const low = lift(-5 * view.cell), mid = lift(0), high = lift(5 * view.cell);
    assert.ok(low > 0 && mid > low && high > mid, `${low} ${mid} ${high}`);
    assert.ok(high < cube * 0.6);                 // 見上げすぎない（立方体が縦に伸びて見えるほどにはしない）
  }
});

test('画面の点 → 3D の空間の点（どの高さの面でも）は、写し直すと同じ点に戻る', () => {
  for (const view of VIEWS) {
    const eye = eyeFor(view.cell);
    for (const [px, py] of [[10, 20], [view.vw / 2, view.vh / 2], [view.vw - 5, view.vh - 40]]) {
      for (const z of [0, eye.zRef, 3 * eye.zRef]) {
        const b = unprojectClient(view, eye, px, py, z), c = projectToClient(view, eye, b.x, b.y, b.z);
        assert.ok(near(c.x, px, 1e-6) && near(c.y, py, 1e-6));
      }
    }
  }
});

test('盤面が弾む・寄る・揺れる（画面上の拡大と平行移動）は、写したあとの画面座標にそのまま掛かる', () => {
  const view = VIEWS[0], eye = eyeFor(view.cell), img = [1.03, 0, 0, 1.03, -4, 7];
  const P = projection(view, eye, 10, 6000), Q = projection(view, eye, 10, 6000, img);
  for (const [x, y, z] of [[0, 0, 0], [40, -60, 10], [-120, 90, 30]]) {
    const a = toClient(view, apply4(P, x, y, z)), b = toClient(view, apply4(Q, x, y, z));
    assert.ok(near(b.x, 1.03 * a.x - 4, 1e-6) && near(b.y, 1.03 * a.y + 7, 1e-6));
  }
});

test('盤面の板の外形は階段形の三角形（8 段で 36 マス・18 頂点）で、角を丸める分だけ内側へ寄せられる', () => {
  const area = (poly) => poly.reduce((s, [x, y], i) => { const [qx, qy] = poly[(i + 1) % poly.length]; return s + x * qy - qx * y; }, 0) / 2;
  const plain = platePolygon(8, 0);
  assert.equal(plain.length, 18);
  assert.equal(Math.abs(area(plain)), 36);
  assert.equal(platePolygon(4, 0).length, 10);
  assert.equal(Math.abs(area(platePolygon(4, 0))), 10);
  // 内側へ寄せた多角形: 辺はすべて ρ だけ内側（出っ張った角は内へ、へこんだ角は外へ動く）
  const rho = 0.22, inset = platePolygon(8, rho);
  inset.forEach(([x, y], i) => {
    const [px, py] = plain[i];
    assert.ok(near(Math.abs(x - px), rho, 1e-9) && near(Math.abs(y - py), rho, 1e-9));
  });
  // 寄せた後の面積 = 元の面積 - 周の長さ × ρ + (出っ張った角 11 個 - へこんだ角 7 個) × ρ²
  assert.ok(near(Math.abs(area(inset)), 36 - 32 * rho + 4 * rho * rho, 1e-9));
});

test('動きの進み方: CSS の cubic-bezier と同じ形（はね返りのある形は 1 を超える）・キーフレームの補間', () => {
  for (const e of Object.values(EASE)) { assert.equal(e(0), 0); assert.equal(e(1), 1); }
  const lin = cubicBezier(0, 0, 1, 1);
  for (const t of [0.1, 0.37, 0.8]) assert.ok(near(lin(t), t, 1e-5));
  const back = cubicBezier(0.3, 1.6, 0.5, 1);
  let max = 0;
  for (let t = 0; t <= 1; t += 0.01) max = Math.max(max, back(t));
  assert.ok(max > 1.05);
  for (let t = 0.01; t <= 1; t += 0.01) assert.ok(EASE.inOut(t) >= EASE.inOut(t - 0.01));
  const f = [[0, [1.12, 0.8]], [0.5, [1, 1]], [1, [0.9, 1.2]]];
  assert.deepEqual(keyframes(f, 0), [1.12, 0.8]);
  assert.deepEqual(keyframes(f, 1), [0.9, 1.2]);
  const m = keyframes(f, 0.75);
  assert.ok(near(m[0], 0.95) && near(m[1], 1.1));
  assert.equal(keyframes([[0, 0], [0.16, 1.14], [1, 0]], 0.16), 1.14);
});

test('角を丸めた立方体: 頂点はすべて角の丸い箱の表面にあり、法線は外向きの単位ベクトルで、三角形は外を向く', () => {
  const g = roundedCube(), pos = g.attributes.position.array, nrm = g.attributes.normal.array, idx = g.index.array;
  const h = 0.5 - BEVEL;
  const sd = (p) => {
    const q = p.map((v) => Math.abs(v) - h);
    return Math.hypot(...q.map((v) => Math.max(v, 0))) + Math.min(Math.max(...q), 0) - BEVEL;
  };
  for (let i = 0; i < pos.length; i += 3) {
    const p = [pos[i], pos[i + 1], pos[i + 2]], n = [nrm[i], nrm[i + 1], nrm[i + 2]];
    assert.ok(Math.abs(sd(p)) < 1e-6, `頂点 ${i / 3} が表面にない`);
    assert.ok(near(Math.hypot(...n), 1, 1e-6));
    // 法線 = 表面からの距離が増える向き
    const e = 1e-4, out = sd(p.map((v, k) => v + n[k] * e)) - sd(p);
    assert.ok(out > e * 0.99);
  }
  for (let t = 0; t < idx.length; t += 3) {
    const [a, b, c] = [idx[t], idx[t + 1], idx[t + 2]].map((k) => [pos[k * 3], pos[k * 3 + 1], pos[k * 3 + 2]]);
    const u = b.map((v, k) => v - a[k]), v = c.map((w, k) => w - a[k]);
    const cr = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const mid = a.map((w, k) => (w + b[k] + c[k]) / 3);
    if (Math.hypot(...cr) < 1e-9) continue;          // 丸い角の先の、面積の無い三角形
    assert.ok(cr[0] * mid[0] + cr[1] * mid[1] + cr[2] * mid[2] > 0, `三角形 ${t / 3} が内を向いている`);
  }
});

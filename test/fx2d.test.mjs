import test from 'node:test';
import assert from 'node:assert/strict';
import { FxCanvas, bezier, easeOut, softwareRendering } from '../src/ui/fx2d.js?v=202610091243';
import { Sparkles, sparkPose } from '../src/ui/sparkles.js?v=202610091243';
import { Shards, shardPose } from '../src/ui/shards.js?v=202610091243';
import { Rims, rimPose, rimSprite, RIM_MS } from '../src/ui/rims.js?v=202610091243';

/* ---- 最小限の偽物: canvas の 2D コンテキスト（呼び出しを記録）と requestAnimationFrame（手でコマを進める） ---- */
function fakeCtx() {
  const calls = [], props = {};
  const ctx = new Proxy({}, {
    get: (_, k) => (k === 'calls' ? calls : k in props ? props[k] : (...a) => { calls.push([k, ...a]); return ctx; }),   // 描く呼び出しは記録して、グラデーションなどの戻り値には自分自身を返す
    set: (_, k, v) => { props[k] = v; return true; },
  });
  return ctx;
}
function fakeCanvas() {
  const ctx = fakeCtx();
  return { hidden: false, width: 0, height: 0, style: {}, className: '', getContext: () => ctx, ctx };
}
/** document の偽物。canvas は記録する偽物、それ以外は style・className・remove を持つ要素（色の読み取りに使う） */
function domStub(made) {
  return {
    createElement: (tag) => { if (tag === 'canvas') { const c = fakeCanvas(); made?.push(c); return c; } return { style: {}, className: '', children: [], remove() {} }; },
    body: { appendChild() {} },
  };
}
globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => ({ '--hi': '#ffa9c1', '--col': '#ff3f5c', '--lo': '#c0143c', '--rim': '#ffd0dc' }[k] ?? '') });
function setup({ dpr = 2 } = {}) {
  let id = 0; const frames = new Map();
  globalThis.window = { devicePixelRatio: dpr };
  globalThis.document = domStub();
  globalThis.requestAnimationFrame = (f) => { frames.set(++id, f); return id; };
  globalThis.cancelAnimationFrame = (i) => { frames.delete(i); };
  const parent = { children: [], insertBefore(c, ref) { this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, c); }, firstChild: null };
  let now = 0;
  const fx = new FxCanvas(parent);
  fx.now = () => now;
  return {
    fx, parent, frames,
    at: (t) => { now = t; },
    step: () => { const f = [...frames.entries()]; frames.clear(); for (const [, fn] of f) fn(now); },
    pending: () => frames.size,
  };
}

test('cubic-bezier: 両端と単調増加。CSS の ease-out（0, 0, .58, 1）と同じ形', () => {
  assert.equal(easeOut(0), 0); assert.equal(easeOut(1), 1);
  let prev = -1;
  for (let i = 0; i <= 100; i++) { const y = easeOut(i / 100); assert.ok(y >= prev - 1e-9, `${i}`); prev = y; }
  // 別の方法（曲線を細かく刻んで補間）と照らし合わせる
  const ref = (x) => {
    const N = 20000; let lastX = 0, lastY = 0;
    for (let i = 1; i <= N; i++) {
      const t = i / N, u = 1 - t;
      const px = 3 * u * t * t * 0.58 + t * t * t, py = 3 * u * u * t * 0 + 3 * u * t * t * 1 + t * t * t;
      if (px >= x) return lastY + ((py - lastY) * (x - lastX)) / (px - lastX || 1);
      lastX = px; lastY = py;
    }
    return 1;
  };
  for (const x of [0.05, 0.2, 0.3, 0.5, 0.6, 0.8, 0.95]) assert.ok(Math.abs(easeOut(x) - ref(x)) < 2e-4, `x=${x}: ${easeOut(x)} vs ${ref(x)}`);
  assert.ok(easeOut(0.3) > 0.3, 'ease-out は前半が速い');
  const linear = bezier(0, 0, 1, 1);
  for (const x of [0.1, 0.5, 0.9]) assert.ok(Math.abs(linear(x) - x) < 1e-5);
});

test('星の動き: 大きさ 0 から開いて（1.15）縮み（0.85）、小さくなって消える。回りながら上へ流れる', () => {
  const at0 = sparkPose(0, 50, 10), at1 = sparkPose(1, 50, 10);
  assert.deepEqual([at0.scale, at0.rot, at0.dy], [0, 0, 0]);
  assert.ok(Math.abs(at1.scale) < 1e-9 && Math.abs(at1.rot - 50) < 1e-9 && Math.abs(at1.dy + 10) < 1e-9, '最後は 回転 = spin、上へ rise');
  let peak = 0, prevRot = -1, prevDy = 1;
  for (let i = 0; i <= 200; i++) {
    const p = sparkPose(i / 200, 60, 12);
    assert.ok(p.scale >= -1e-9 && p.scale <= 1.15 + 1e-9, `大きさ ${p.scale}`);
    assert.ok(p.rot >= prevRot - 1e-9 && p.dy <= prevDy + 1e-9, '回転は進む一方・上へ流れる一方');
    prevRot = p.rot; prevDy = p.dy; peak = Math.max(peak, p.scale);
  }
  assert.ok(Math.abs(peak - 1.15) < 0.01, `いちばん開いたとき ${peak}`);
  assert.ok(sparkPose(0.5, -40, 6).rot < 0, '逆向きにも回る');
});

test('かけらの動き: 放物線で飛び、後半 45% で小さくなって消える（回さない）', () => {
  const T = 0.6;
  assert.deepEqual(shardPose(0, T, 100, -200, 600), { dx: 0, dy: 0, scale: 1 });
  const mid = shardPose(0.3, T, 100, -200, 600);
  assert.ok(Math.abs(mid.dx - 30) < 1e-9 && Math.abs(mid.dy - (-60 + 27)) < 1e-9 && mid.scale === 1);
  assert.ok(Math.abs(shardPose(T * 0.55, T, 0, 0, 0).scale - 1) < 1e-9);
  assert.ok(shardPose(T * 0.8, T, 0, 0, 0).scale < 1 && shardPose(T * 0.8, T, 0, 0, 0).scale > 0);
  assert.ok(shardPose(T, T, 0, 0, 0).scale < 1e-9);
  assert.ok(shardPose(T * 1.2, T, 0, 0, 0).scale >= 0, '負にならない');
});

test('光の跡の動き: 0.8 倍から開いて濃くなり（1.06 倍）、薄く引く。0 → 濃い → 引く', () => {
  assert.deepEqual([rimPose(0).opacity, rimPose(0).scale], [0, 0.8]);
  const a = rimPose(0.14), b = rimPose(0.45), c = rimPose(1);
  assert.ok(Math.abs(a.opacity - 1) < 1e-9 && Math.abs(a.scale - 1.06) < 1e-9);
  assert.ok(Math.abs(b.opacity - 0.55) < 1e-9 && Math.abs(b.scale - 1.02) < 1e-9);
  assert.ok(Math.abs(c.opacity) < 1e-9 && Math.abs(c.scale - 1) < 1e-9);
  for (let i = 0; i <= 100; i++) { const p = rimPose(i / 100); assert.ok(p.opacity >= -1e-9 && p.opacity <= 1 + 1e-9); }
  assert.ok(rimPose(0.07).opacity > 0 && rimPose(0.07).opacity < 1, '開いている途中');
  assert.ok(rimPose(0.3).opacity < 1 && rimPose(0.3).opacity > 0.55, '引いている途中');
  assert.ok(RIM_MS <= 320);
});

test('FxCanvas: 粒があるときだけ画面に出て、終わった粒は消え、全部終わったら外れる', () => {
  const t = setup();
  const { fx } = t;
  assert.equal(fx.el.hidden, true, '最初は画面から外れている');
  fx.fit(-10, -20, 100, 50);
  assert.deepEqual([fx.el.width, fx.el.height], [200, 100], '画面の密度 2 の細かさ');
  assert.equal(fx.el.style.left, '-10px'); assert.equal(fx.el.style.width, '100px');
  const drawn = [], done = [];
  fx.add({ start: 0, end: 100, draw: (g, now) => drawn.push(['a', now]), done: () => done.push('a') });
  fx.add({ start: 50, end: 200, draw: (g, now) => drawn.push(['b', now]), done: () => done.push('b') });
  assert.equal(fx.el.hidden, false); assert.equal(t.pending(), 1);
  t.at(10); t.step();
  assert.deepEqual(drawn, [['a', 10]], 'b はまだ始まっていない');
  t.at(60); t.step();
  assert.deepEqual(drawn.slice(1), [['a', 60], ['b', 60]]);
  t.at(120); t.step();
  assert.deepEqual(done, ['a']); assert.equal(fx.size, 1);
  assert.equal(fx.el.hidden, false);
  t.at(250); t.step();
  assert.deepEqual(done, ['a', 'b']); assert.equal(fx.size, 0);
  assert.equal(fx.el.hidden, true, '全部終わったら外れる'); assert.equal(t.pending(), 0, '次のコマも頼まない');
  // 描く前に、画面の密度と覆う範囲の原点を合わせた変換が掛かる
  const first = fx.ctx.calls.find((c) => c[0] === 'setTransform' && c[1] === 2 && c[5] === 20);
  assert.deepEqual(first.slice(1), [2, 0, 0, 2, 20, 40]);
});

test('FxCanvas: 一時停止の間は時計も止まり、再開すると残りの長さを続ける', () => {
  const t = setup(), { fx } = t, drawn = [];
  fx.fit(0, 0, 10, 10);
  fx.add({ start: 0, end: 100, draw: (g, now) => drawn.push(now), done: () => drawn.push('done') });
  t.at(40); t.step();
  fx.setPaused(true); assert.equal(t.pending(), 0, '止めたらコマを頼まない');
  t.at(500); fx.setPaused(false);
  t.step();
  assert.deepEqual(drawn, [40, 500], '止めていた 460ms は進まない（終わりが 560 へずれる）');
  t.at(540); t.step();
  assert.equal(drawn.at(-1), 540);
  t.at(570); t.step();
  assert.equal(drawn.at(-1), 'done');
  fx.setPaused(false); assert.equal(fx.paused, false);
});

test('FxCanvas: owner ごとに捨てられる。全部捨てると外れる', () => {
  const t = setup(), { fx } = t, A = {}, B = {};
  fx.fit(0, 0, 10, 10);
  fx.add({ owner: A, start: 0, end: 100, draw() {} }); fx.add({ owner: B, start: 0, end: 100, draw() {} });
  fx.drop(A);
  assert.equal(fx.size, 1); assert.equal(fx.el.hidden, false);
  fx.drop(B);
  assert.equal(fx.size, 0); assert.equal(fx.el.hidden, true);
  fx.add({ owner: A, start: 0, end: 100, draw() {} }); fx.clear();
  assert.equal(fx.size, 0); assert.equal(fx.el.hidden, true); assert.equal(t.pending(), 0);
});

test('Sparkles: 同時に MAX（36）個まで。終わったら数が戻る。clear で自分の粒だけ捨てる', () => {
  const t = setup(), { fx } = t, sp = new Sparkles(fx);
  Math.random = () => 0.3;
  fx.fit(0, 0, 100, 100);
  let ok = 0; for (let i = 0; i < 50; i++) if (sp.twinkle(10, 10, { life: 100, delay: 0 })) ok++;
  assert.equal(ok, 36); assert.equal(sp.count, 36);
  t.at(10); t.step();
  assert.ok(fx.ctx.calls.some((c) => c[0] === 'drawImage'), '星を貼る');
  t.at(200); t.step();
  assert.equal(sp.count, 0, '終わったら数が戻る'); assert.equal(fx.el.hidden, true);
  sp.twinkle(1, 1, { life: 100 }); fx.add({ owner: 'other', start: 0, end: 1e9, draw() {} });
  sp.clear();
  assert.equal(sp.count, 0); assert.equal(fx.size, 1, 'ほかの粒は残る');
  assert.equal(sp.twinkle(1, 1, { color: 'red' }), true);
});

test('Shards: cap までしか出さない。放物線でかけらを貼る', () => {
  const t = setup(), { fx } = t, sh = new Shards(fx);
  fx.fit(0, 0, 400, 400);
  sh.burst(100, 100, ['red', 'blue'], 30, 20, 200);
  assert.equal(sh.count, 14, '同時に 14 個まで');
  sh.burst(100, 100, ['red'], 40, 20, 200, { cap: 42 });
  assert.equal(sh.count, 42, '全消しのような見せ場は cap を広げる');
  t.at(100); t.step();
  const draws = fx.ctx.calls.filter((c) => c[0] === 'drawImage');
  assert.ok(draws.length > 0);
  for (const d of draws) assert.ok(d[2] <= 400 && d[2] >= -200, `位置 ${d[2]}`);
  t.at(2000); t.step();
  assert.equal(sh.count, 0); assert.equal(fx.el.hidden, true);
});

test('Rims: マスの大きさが変わったら絵を作り直す。光の跡は delay 後に RIM_MS だけ貼る', () => {
  const t = setup(), { fx } = t, rims = new Rims(fx);
  const made = [];
  globalThis.document = domStub(made);
  fx.fit(-20, -20, 340, 340);
  rims.flash(0, 0, 'red', 0);                          // マスの大きさが未設定のうちは何もしない
  assert.equal(fx.size, 0);
  rims.setCell(35);
  rims.flash(70, 35, 'red', 120);
  rims.flash(105, 35, 'red', 160);
  assert.equal(fx.size, 2); assert.equal(made.length >= 1, true);
  const n = made.length;
  rims.flash(35, 35, 'red', 0);
  assert.equal(made.length, n, '同じ色・同じ大きさの絵は使い回す');
  t.at(50); t.step();
  assert.equal(fx.ctx.calls.filter((c) => c[0] === 'drawImage').length, 1, '始まったものだけ（delay 0 の 1 つ）');
  t.at(140); t.step();
  assert.ok(fx.ctx.calls.filter((c) => c[0] === 'drawImage').length >= 2);
  rims.setCell(40);
  rims.flash(0, 0, 'red', 0);
  assert.ok(made.length > n, 'マスの大きさが変わったら作り直す');
  rims.clear();
  assert.equal(fx.size, 0);
});

test('rimSprite: 外側のにじみ・外側の細い白・内側のにじみ・内側の白いふちの 4 つを 1 枚に描く（要素の box-shadow と同じ重ね順）', () => {
  globalThis.document = domStub();
  const { cv, size } = rimSprite('red', 35, 2);
  assert.equal(size, 35 + 2 * Math.ceil(35 * 0.5)); assert.equal(cv.width, Math.ceil(size * 2));
  const names = cv.ctx.calls.map((c) => c[0]);
  assert.equal(names.filter((n) => n === 'fill').length, 4 + 0, '影 2 つ + 細い白 + 白いふち');
  assert.equal(names.filter((n) => n === 'clip').length, 2, '外側のにじみは枠の外だけ、内側のにじみは枠の中だけ');
});

test('FxCanvas.setEvery: 2 コマに 1 回だけ描く（最初のコマはすぐ描く）。粒の動きは時刻で決まるので間引いても速さは同じで、終わったら外れる', () => {
  const t = setup(), { fx } = t, drawn = [];
  fx.fit(0, 0, 10, 10);
  assert.equal(fx.every, 1);
  fx.setEvery(2); assert.equal(fx.every, 2);
  fx.setEvery(0); assert.equal(fx.every, 1, '1 より小さい・数でない値は 1'); fx.setEvery('x'); assert.equal(fx.every, 1);
  fx.setEvery(2.4); assert.equal(fx.every, 2);
  fx.add({ start: 0, end: 100, draw: (g, now) => drawn.push(now), done: () => drawn.push('done') });
  const clear0 = fx.ctx.calls.filter((c) => c[0] === 'clearRect').length;
  for (let i = 0; i < 6; i++) { t.at(10 + i * 16); t.step(); }
  assert.deepEqual(drawn, [10, 42, 74], '1・3・5 コマ目だけ描く');
  assert.equal(fx.ctx.calls.filter((c) => c[0] === 'clearRect').length - clear0, 3, '間引くコマは canvas を書き換えない（消しもしない）');
  assert.equal(t.pending(), 1, '間引いても、次のコマは頼む');
  t.at(120); t.step(); t.at(136); t.step();                    // 1 コマ目で終わりを見つけて、done を呼ぶ
  assert.equal(drawn.at(-1), 'done'); assert.equal(fx.el.hidden, true); assert.equal(t.pending(), 0);
  fx.add({ start: 200, end: 300, draw: (g, now) => drawn.push(now) });                    // 空いたあとの最初のコマも、すぐ描く
  t.at(210); t.step();
  assert.equal(drawn.at(-1), 210);
});

test('softwareRendering: WebGL の描画装置の名前でソフトウェア描画（SwiftShader・llvmpipe など）を見分ける。分からなければ GPU ありとして扱う', () => {
  const withRenderer = (name, { ext = true, lose = [] } = {}) => {
    globalThis.document = {
      createElement: () => ({
        getContext: () => ({
          RENDERER: 0x1f01, UNMASKED_RENDERER_WEBGL: 0x9246,
          getExtension: (n) => (n === 'WEBGL_debug_renderer_info' ? (ext ? { UNMASKED_RENDERER_WEBGL: 0x9246 } : null) : n === 'WEBGL_lose_context' ? { loseContext: () => lose.push(1) } : null),
          getParameter: () => name,
        }),
      }),
    };
  };
  for (const soft of ['ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Software Rasterizer', 'Microsoft Basic Render Driver']) {
    withRenderer(soft); assert.equal(softwareRendering(), true, soft);
  }
  for (const hard of ['Adreno (TM) 740', 'Mali-G78', 'Apple GPU', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'ANGLE (Intel, Intel(R) UHD Graphics 620)', 'AMD Radeon Pro 5500M OpenGL Engine']) {
    withRenderer(hard); assert.equal(softwareRendering(), false, hard);
  }
  const lost = []; withRenderer('Mali-G78', { lose: lost }); softwareRendering(); assert.equal(lost.length, 1, '調べ終わったら WebGL のコンテキストを手放す');
  withRenderer('SwiftShader', { ext: false }); assert.equal(softwareRendering(), true, '描画装置の情報が出せない環境でも、通常の名前で見分ける');
  globalThis.document = { createElement: () => ({ getContext: () => null }) };
  assert.equal(softwareRendering(), false, 'WebGL が使えない（取れない）ときは GPU ありとして扱う');
  globalThis.document = { createElement: () => { throw new Error('unavailable'); } };
  assert.equal(softwareRendering(), false);
});

test('FxCanvas.setDprMax: 描く細かさの上限を下げると、覆う範囲はそのまま canvas が粗くなる', () => {
  const t = setup({ dpr: 3 }), { fx } = t;
  fx.fit(-10, -20, 100, 50);
  assert.deepEqual([fx.el.width, fx.el.height, fx.k], [200, 100, 2], '密度 3 でも上限 2');
  fx.setDprMax(1);
  assert.deepEqual([fx.el.width, fx.el.height, fx.k], [100, 50, 1]);
  assert.equal(fx.el.style.left, '-10px'); assert.equal(fx.el.style.width, '100px');
  fx.setDprMax(4);
  assert.deepEqual([fx.el.width, fx.k], [300, 3], '上限を上げても、画面の密度より細かくはしない');
  const w = fx.el.width; fx.setDprMax(4); assert.equal(fx.el.width, w, '同じ値なら何もしない');
});

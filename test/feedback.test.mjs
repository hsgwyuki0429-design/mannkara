import test from 'node:test';
import assert from 'node:assert/strict';
import { Sfx, note, voicedFrequency, shalanTop } from '../src/ui/sfx.js?v=202610021033';
import { Renderer } from '../src/ui/renderer.js?v=202610021033';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) };
class Param {
  value = 0;
  setValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}
class AudioNode {
  gain = new Param(); frequency = new Param(); Q = new Param(); playbackRate = new Param();
  threshold = new Param(); knee = new Param(); ratio = new Param(); attack = new Param(); release = new Param();
  disconnected = false; stopped = false;
  connect() {}
  disconnect() { this.disconnected = true; }
  start(at) { this.started = at; }
  stop(at) { if (at === undefined) this.stopped = true; this.stopAt = at; }
}
class Context {
  state = 'running'; currentTime = 10; sampleRate = 8000; destination = new AudioNode(); sources = [];
  createGain() { return new AudioNode(); }
  createBiquadFilter() { return new AudioNode(); }
  createDynamicsCompressor() { return new AudioNode(); }
  createOscillator() { const n = new AudioNode(); this.sources.push(n); return n; }
  createBufferSource() { return this.createOscillator(); }
  createBuffer(c, len) { return { getChannelData: () => new Float32Array(len) }; }
  resume() { this.state = 'running'; return Promise.resolve(); }
  close() { this.state = 'closed'; return Promise.resolve(); }
}
const audio = () => {
  storage.clear();
  const s = new Sfx(); s.ctx = new Context(); s.connect();
  return s;
};

test('連鎖の10音が上限で同じ周波数につぶれず、聴きやすい範囲に収まる', () => {
  const pitches = Array.from({ length: 10 }, (_, i) => voicedFrequency(note(i, 330)));
  assert.equal(new Set(pitches).size, 10);
  for (const f of pitches) assert.ok(f >= 45 && f <= 1760);
  assert.equal(voicedFrequency(2640), 1320);
  assert.equal(note(24), note(4));
});

test('ミュートは予約した和音も止め、設定を次の起動へ残す', () => {
  const s = audio(); s.allClear();
  assert.ok(s.voices.size > 5);
  s.enabled = false;
  assert.equal(s.voices.size, 0);
  assert.ok(s.ctx.sources.every((n) => n.stopped && n.disconnected));
  assert.equal(new Sfx().enabled, false);
  const count = s.ctx.sources.length;
  s.place(4); assert.equal(s.ctx.sources.length, count);
  s.enabled = true; s.place(4); assert.ok(s.voices.size > 0);
  s.stop();
});

test('一時停止で予約音を捨て、再開後は新しい操作音だけを出す', () => {
  const s = audio(); s.praise(5); s.setPaused(true);
  assert.equal(s.voices.size, 0);
  s.goal(4); assert.equal(s.voices.size, 0);
  s.setPaused(false); s.goal(4); assert.ok(s.voices.size > 0);
  s.stop();
});

test('タブが隠れた後は古い音を再開時へ持ち越さない', () => {
  const s = audio(); s.allClear(); s.markStale();
  assert.equal(s.voices.size, 0);
  s.place(); assert.equal(s.voices.size, 0);
  globalThis.window = { AudioContext: Context };
  const old = s.ctx; s.unlock(true);
  assert.notEqual(s.ctx, old); assert.equal(old.state, 'closed');
  s.place(); assert.ok(s.voices.size > 0); s.stop();
});

test('高速ホバーと同時着地をまとめ、次の時刻の接触音は鳴らす', () => {
  const s = audio();
  for (let i = 0; i < 50; i++) s.hover();
  assert.equal(s.ctx.sources.length, 1);
  s.ctx.currentTime += 0.06; s.hover();
  assert.equal(s.ctx.sources.length, 2);
  for (let i = 0; i < 8; i++) s.settle(i);
  assert.equal(s.ctx.sources.length, 4);
  s.stop();
});

test('同時発音数に上限があり、装飾音より配置音を優先する', () => {
  const s = audio();
  for (let i = 0; i < 40; i++) s.tone(440, { priority: 0 });
  const old = [...s.ctx.sources];
  s.place(9);
  assert.equal(s.voices.size, 40);
  assert.ok(old.some((n) => n.stopped));
  assert.ok([...s.voices].some((v) => v.priority === 3));
  s.stop();
  for (let i = 0; i < 40; i++) s.tone(440, { priority: 3 });
  const high = [...s.voices]; s.tone(880, { priority: 0 });
  assert.deepEqual([...s.voices], high);
  s.stop();
});

test('終了した発音ノードとノイズノードは接続を切って解放する', () => {
  const s = audio(); s.place();
  for (const n of s.ctx.sources) n.onended();
  assert.equal(s.voices.size, 0);
  assert.ok(s.ctx.sources.every((n) => n.disconnected));
});

test('AudioContext を作れない環境でもゲーム入力を壊さない', () => {
  storage.clear();
  globalThis.window = {};
  const s = new Sfx(); assert.doesNotThrow(() => s.unlock(true));
  window.AudioContext = class { constructor() { throw new Error('unavailable'); } };
  assert.doesNotThrow(() => s.unlock(true));
  s.ctx = new Context(); s.ctx.state = 'suspended';
  s.stuckSince = performance.now() - 2000;
  assert.doesNotThrow(() => s.unlock(true));
  assert.equal(s.ctx, null);
});

test('置く音はガラスの波形を 1 ボイスで鳴らし、4 種のコップを順に使い、鳴り終わったら接続を切る', () => {
  const s = audio();
  for (let i = 0; i < 5; i++) { s.place(4); s.ctx.currentTime += 0.2; }
  const glass = s.ctx.sources.filter((n) => n.buffer);
  assert.equal(glass.length, 5, '1 回の配置で波形は 1 つ（和音の数だけ発音の枠を使わない）');
  assert.equal(new Set(glass.map((n) => n.buffer)).size, 4);
  assert.equal(glass[4].buffer, glass[0].buffer);
  assert.ok(glass.every((n) => n.playbackRate.value > 0.8 && n.playbackRate.value < 1.05));
  assert.ok(glass.every((n) => n.started >= 10 && n.stopAt > n.started));
  for (const n of s.ctx.sources) n.onended();
  assert.equal(s.voices.size, 0);
  assert.ok(s.ctx.sources.every((n) => n.disconnected));
});

test('置く音は大きいピースほど低く（重く）、置く音の優先度は装飾音より高い', () => {
  const s = audio();
  s.place(1); s.ctx.currentTime += 1; s.place(9);
  const [light, heavy] = s.ctx.sources.filter((n) => n.buffer);
  assert.ok(heavy.playbackRate.value < light.playbackRate.value * 0.95);
  assert.ok([...s.voices].some((v) => v.priority === 3));
  s.stop();
});

test('ミュートは明るい出口も止める（ガラス・シャランが残らず、戻せば鳴る）', () => {
  const s = audio(); s.place(3); s.shalan(2);
  assert.ok(s.voices.size >= 3);
  s.enabled = false;
  assert.equal(s.voices.size, 0);
  assert.equal(s.master.gain.value, 0); assert.equal(s.bright.gain.value, 0);
  const n = s.ctx.sources.length; s.shalan(3); s.glass(); s.place(2);
  assert.equal(s.ctx.sources.length, n);
  s.enabled = true;
  assert.equal(s.bright.gain.value, 0.32);
  s.ctx.currentTime += 1; s.shalan(3); assert.ok(s.voices.size > 0);
  s.stop();
});

test('シャランの最後のバーは、ゴールの音と同じ音階の高さ（バーチャイムの 2〜4.5kHz）で、連鎖が進むほど高い', () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(shalanTop), [2220, 2492, 2797, 3326, 3734, 4440]);
  for (let c = 1; c <= 12; c++) {
    const top = shalanTop(c), goal = note(c - 1, 330) * Math.pow(2, -3 / 12);        // ゴールの音（tone は 3 半音下げて鳴らす）
    assert.ok(top >= 2000 && top < 4500, `連鎖 ${c}: ${top}Hz`);
    const octaves = Math.log2(top / goal);
    assert.ok(Math.abs(octaves - Math.round(octaves)) < 2e-3, `連鎖 ${c}: ゴールの音のオクターブ違いの高さ`);
  }
  const ups = [1, 2, 3, 4, 5, 6].map(shalanTop);
  assert.ok(ups.every((f, i) => i === 0 || f > ups[i - 1]), '6 連鎖までは、連鎖が進むほど高い');
  assert.equal(shalanTop(7), shalanTop(2), '7 連鎖目からは 2 連鎖目と同じ高さに戻る（上限を超えるので 1 オクターブ下げる）');
});

test('シャランは連鎖ごとの高さの波形（長さは同じ）を、再生の速さをほぼ変えずに鳴らす。同時の連打は 1 つにまとめる', () => {
  const s = audio();
  for (let c = 1; c <= 8; c++) { s.shalan(c); s.ctx.currentTime += 0.2; }
  const used = s.ctx.sources.filter((n) => n.buffer);
  assert.equal(used.length, 8);
  assert.equal(new Set(used.slice(0, 6).map((n) => n.buffer)).size, 6, '6 連鎖までは別の波形（別の高さ）');
  assert.equal(used[6].buffer, used[1].buffer, '7 連鎖目は 2 連鎖目と同じ');
  for (let c = 1; c <= 8; c++) assert.ok(s.waves.has(`shalan:${shalanTop(c)}`));
  assert.ok(used.every((n) => Math.abs(n.playbackRate.value - 1) <= 0.011), '高さは再生の速さでなく、波形で変える（速さを変えると長さも変わる）');
  assert.ok(used.every((n) => n.stopAt - n.started < 1.4), '長さは約 1.3 秒');
  const n = s.ctx.sources.length; s.shalan(1); s.shalan(1);
  assert.equal(s.ctx.sources.length, n + 1);
  s.stop();
});

test('全消しは「シャラン、シャラン」の 2 回（2 回目は高い）、新記録のファンファーレは 1 回', () => {
  const shalans = (x) => x.ctx.sources.filter((n) => n.buffer && [...x.waves].some(([k, w]) => k.startsWith('shalan:') && w.buf === n.buffer));
  let s = audio(); s.allClear();
  const two = shalans(s);
  assert.equal(two.length, 2);
  assert.ok(two[1].started - two[0].started > 0.3);
  assert.notEqual(two[0].buffer, two[1].buffer);
  assert.ok(s.waves.has(`shalan:${shalanTop(1)}`) && s.waves.has(`shalan:${shalanTop(4)}`), '1 回目は 1 連鎖の高さ、2 回目は 4 連鎖の高さ');
  s.stop();
  s = audio(); s.fanfare();
  assert.equal(shalans(s).length, 1);
  s.stop();
});

test('波形は 1 回だけ作って使い回し、warm で 1 つずつ先に作れる。AudioContext を作り直したら作り直す', () => {
  const s = audio();
  assert.equal(s.waves.size, 0);
  let more = true, calls = 0;
  while (more) { more = s.warm(); assert.ok(++calls <= 10); }
  assert.equal(s.waves.size, 10, 'ガラス 4 種 + シャラン（高さ 6 種）');
  const glass1 = s.waves.get('glass1');
  s.glass(1); assert.equal(s.waves.get('glass1'), glass1);
  s.ctx = new Context(); s.connect();
  assert.equal(s.waves.size, 0);
  assert.equal(s.warm(), true);
  s.stop();
});

test('波形を作れない環境でも、置く音で入力を壊さない（低い胴鳴りだけは鳴る）', () => {
  const s = audio(); s.ctx.createBuffer = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => { s.place(3); s.glass(); s.shalan(2); });
  assert.ok(s.voices.size >= 1);
  assert.equal(s.ctx.sources.filter((n) => n.buffer).length, 0);
  s.stop();
});

/* ---- ラインの光（lineGlow / trail / goalSparkle）。DOM は最小限の偽物 ---- */
function fakeDom() {
  const el = (tag) => {
    const e = {
      tag, className: '', children: [], anims: [], removed: false, style: { setProperty(k, v) { e.style[k] = v; } },
      appendChild(c) { e.children.push(c); return c; }, remove() { e.removed = true; },
      animate(frames, opts) { const a = { frames, opts, onfinish: null }; e.anims.push(a); return a; },
    };
    return e;
  };
  globalThis.document = { createElement: el, body: el('body'), head: el('head') };
  globalThis.getComputedStyle = () => ({ getPropertyValue: (k) => ({ '--hi': '#ffa9c1', '--col': '#ff3f5c' }[k] ?? '') });
  return el;
}
function glowRenderer({ reduced = false, frameMs = 16.7, rush = false } = {}) {
  const el = fakeDom();
  globalThis.window = { matchMedia: () => ({ matches: reduced }) };
  const calls = { stars: [], shalan: [] };
  const r = Object.assign(Object.create(Renderer.prototype), {
    fxLayer: el('layer'), cell: 35, W: 280, wrapW: 390, topY: 300, frameMs, rush,
    fxTimers: new Set(), pausedAnimations: new Set(), fxPaused: false, gen: 0,
    sparkLayer: { twinkle: (x, y, o) => { calls.stars.push({ x, y, ...o }); return true; }, clear() { calls.cleared = true; } },
    sfx: { shalan: (...a) => calls.shalan.push(a) },
  });
  r.done = () => { for (const t of [...r.fxTimers]) r.cancelFxTimer(t); };
  return { r, calls };
}

test('満杯の縦ラインは、その列の枠が光る（位置・大きさ・光の帯・星・シャランの音）', () => {
  const { r, calls } = glowRenderer();
  r.lineGlow('col', 3, 'red', 1);
  const [frame] = r.fxLayer.children;
  assert.equal(r.fxLayer.children.length, 1);
  assert.equal(frame.className, 'line-glow col');
  assert.match(frame.style.cssText, /translate\(175px,0px\);width:35px;height:105px;--g:rgba\(255,169,193,0\.85\)/);
  assert.equal(frame.children[0].className, 'lg-shine');
  assert.equal(frame.anims.length, 1);                                        // 枠は opacity と scale だけ
  assert.ok(frame.anims[0].frames.every((f) => Object.keys(f).every((k) => ['opacity', 'scale', 'offset', 'easing'].includes(k))));
  const [down] = frame.children[0].anims;                                    // 光の帯は流れる向き（縦なら下）へ
  assert.deepEqual(down.frames.map((f) => f.translate), ['0 -100%', '0 100%']);
  assert.equal(calls.stars.length, 5, '星は 3 マスなら 5 つ');
  assert.ok(calls.stars.every((s, i) => s.delay >= i * 30 && s.size >= 35 * 0.55 && s.size <= 35 * 0.9), '順にまたたく・見やすい大きさ');
  assert.deepEqual(calls.shalan, [[1, { size: 0.65 }]]);
  r.done();
});

test('横ラインは縦と左右対称（枠・光の帯の向き）。連鎖の 2 番目以降は少し大きなシャラン', () => {
  const { r, calls } = glowRenderer();
  r.lineGlow('row', 5, 'cyan', 3);
  const frame = r.fxLayer.children[0];
  assert.equal(frame.className, 'line-glow row');
  assert.match(frame.style.cssText, /translate\(0px,105px\);width:175px;height:35px/);
  assert.deepEqual(frame.children[0].anims[0].frames.map((f) => f.translate), ['-100% 0', '100% 0']);
  assert.deepEqual(calls.shalan, [[3, { size: 0.8 }]]);
  r.done();
});

test('溜めと発動の始まりで、同じラインに二重に出さない（別のラインなら出す）', () => {
  const { r, calls } = glowRenderer();
  r.lineGlow('col', 4, 'red', 1); r.lineGlow('col', 4, 'red', 1);
  assert.equal(r.fxLayer.children.length, 1); assert.equal(calls.shalan.length, 1);
  r.lineGlow('row', 4, 'red', 2);
  assert.equal(r.fxLayer.children.length, 2); assert.equal(calls.shalan.length, 2);
  r.done();
});

test('早送り中は光も音も出さない。層が無いときは何もしない', () => {
  const { r, calls } = glowRenderer({ rush: true });
  r.lineGlow('col', 3, 'red', 1); r.trail('col', 3, 'red', 540); r.goalSparkle(['red'], 2);
  assert.equal(r.fxLayer.children.length, 0); assert.equal(calls.shalan.length, 0);
  const bare = Object.create(Renderer.prototype);
  assert.doesNotThrow(() => { bare.lineGlow('col', 3); bare.trail('col', 3); });
});

test('動きを減らす設定では、枠がふわっと光って消えるだけ（帯・星・跡は出さない）。音は鳴る', () => {
  const { r, calls } = glowRenderer({ reduced: true });
  r.lineGlow('col', 3, 'red', 1);
  const [frame] = r.fxLayer.children;
  assert.equal(frame.anims.length, 1);
  assert.ok(frame.anims[0].frames.every((f) => Object.keys(f).every((k) => ['opacity', 'offset'].includes(k))), 'scale を動かさない');
  assert.equal(frame.children[0].anims.length, 0);
  assert.equal(calls.stars.length, 0); assert.equal(calls.shalan.length, 1);
  r.trail('col', 3, 'red', 540); r.goalSparkle(['red'], 2);
  assert.equal(r.fxLayer.children.length, 1); assert.equal(calls.stars.length, 0);
  r.done();
});

test('遅い端末では、星（品質 0.6 未満）→ 跡の光（0.5 未満）の順に減らす', () => {
  const mid = glowRenderer({ frameMs: 31 });                                  // 品質 ≈ 0.58
  mid.r.lineGlow('col', 3, 'red', 1); mid.r.trail('col', 3, 'red', 540); mid.r.goalSparkle(['red'], 2);
  assert.equal(mid.calls.stars.length, 0, '星は出さない');
  assert.equal(mid.r.fxLayer.children.length, 1 + 9, '枠 1 + 跡 9');
  const slow = glowRenderer({ frameMs: 60 });                                 // 品質 0.25
  slow.r.lineGlow('col', 3, 'red', 1); slow.r.trail('col', 3, 'red', 540);
  assert.equal(slow.r.fxLayer.children.length, 1, '枠だけ');
  mid.r.done(); slow.r.done();
});

test('通過した跡: 列車の後ろが抜けた順に、ラインの外の通路の入り口までの 9 マスが光る。星は交互に白とブロックの色', () => {
  const { r, calls } = glowRenderer();
  r.trail('col', 3, 'green', 540);
  const flashes = r.fxLayer.children;
  assert.equal(flashes.length, 9);
  assert.ok(flashes.every((f) => f.className === 'rim-flash' && f.anims.length === 1));
  const delays = flashes.map((f) => f.anims[0].opts.delay);
  assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]), '抜けた順に点る');
  assert.ok(delays[0] > 0 && delays[8] <= 540 + 1e-6, '列車が通り終える（9 マス）までに全部点る');
  assert.ok(flashes.every((f) => f.anims[0].opts.fill === 'backwards' && f.anims[0].opts.duration <= 320), 'ほんの少しだけ光る');
  assert.deepEqual(calls.stars.map((s) => s.color), ['white', 'green', 'white', 'green', 'white', 'green', 'white', 'green', 'white']);
  flashes[0].anims[0].onfinish(); assert.equal(flashes[0].removed, true);
  r.done();
});

test('横ラインの跡は縦と同じ時刻・左右対称の位置。ゴールでは星がはじける', () => {
  const a = glowRenderer(), b = glowRenderer();
  a.r.trail('col', 4, 'red', 600); b.r.trail('row', 4, 'red', 600);
  const da = a.r.fxLayer.children.map((f) => f.anims[0].opts.delay), db = b.r.fxLayer.children.map((f) => f.anims[0].opts.delay);
  assert.deepEqual(da, db);
  const swap = (s) => s.match(/translate\(([\d.]+)px,([\d.]+)px\)/).slice(1).map(Number);
  a.r.fxLayer.children.forEach((f, i) => { const [x, y] = swap(f.style.cssText), [x2, y2] = swap(b.r.fxLayer.children[i].style.cssText); assert.ok(Math.abs(x - y2) < 1e-6 && Math.abs(y - x2) < 1e-6, `${i}: (${x},${y}) ↔ (${x2},${y2})`); });
  a.r.goalSparkle(['red', 'blue'], 2);
  assert.equal(a.calls.stars.length, 9 + 6);                                  // 跡 9 + ゴール 6
  assert.ok(a.calls.stars.slice(9).every((s) => s.size >= 35 * 0.5 && s.delay <= 6 * 22));
  a.r.done(); b.r.done();
});

test('リセットで星も全部消す', () => {
  const { r, calls } = glowRenderer();
  Object.assign(r, { gen: 0, sfx: { stop() {} }, clearCelebration() {}, wrap: { getAnimations: () => [] }, waiters: new Set(), shardLayer: { clear() {} }, fx2: { innerHTML: 'x' },
    blockLayer: { innerHTML: 'x' }, hintLayer: { innerHTML: 'x' }, tints: new Map(), clearAnnotations() {}, setFever() {}, setDanger() {}, els: new Map(), manual: new Set(),
    setRush() {}, clearPreview() {} });
  r.fxLayer.innerHTML = 'x';
  r.reset();
  assert.equal(calls.cleared, true); assert.equal(r.fxLayer.innerHTML, '');
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timerRenderer = () => Object.assign(Object.create(Renderer.prototype), {
  fxTimers: new Set(), pausedAnimations: new Set(), fxPaused: false, gen: 0,
  wrap: { getAnimations: () => [] },
});

test('演出を止めている間は遅延音が発火せず、再開時に残りの時間を待つ', async () => {
  const r = timerRenderer(); let fired = 0;
  r.later(() => fired++, 60); r.setPaused(true);
  await wait(85); assert.equal(fired, 0);
  r.setPaused(false); await wait(20); assert.equal(fired, 0);
  await wait(65); assert.equal(fired, 1); assert.equal(r.fxTimers.size, 0);
});

test('リスタート前の世代の演出を新しい盤面に出さない', async () => {
  const r = timerRenderer(); let fired = 0;
  r.later(() => fired++, 5); r.gen++;
  await wait(20); assert.equal(fired, 0); assert.equal(r.fxTimers.size, 0);
  const t = r.later(() => fired++, 5); r.cancelFxTimer(t);
  await wait(20); assert.equal(fired, 0); assert.equal(r.fxTimers.size, 0);
});

test('動きを減らす設定ではラインの揺れや飛び散りを生成しない', () => {
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  const r = timerRenderer();
  r.shake = () => assert.fail('shake'); r.punch = () => assert.fail('punch');
  assert.doesNotThrow(() => r.lineBlast('col', 8, 'cyan', 12));
});

test('列から動き出すブロックと盤面に拡縮・揺れを掛けない', () => {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const r = timerRenderer(), classes = new Set(['pop-in', 'fit-in', 'charging']);
  const el = {
    classList: { remove: (...names) => names.forEach((n) => classes.delete(n)) },
    animate: () => assert.fail('座標を持つブロックに拡縮を掛けた'),
  };
  r.els = new Map([[1, el]]); r.frameMs = 16.7;
  r.shake = () => assert.fail('移動開始時に盤面を揺らした');
  r.punch = () => assert.fail('移動開始時に盤面を拡縮した');
  r.lineBlast('col', 8, 'cyan', 12, [{ id: 1 }]);
  assert.equal(classes.size, 0);
});

test('溜めは座標を持つ親要素を拡縮せず、移動前に面の縮みを解除する', async () => {
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  const r = timerRenderer(), classes = new Set();
  const el = {
    classList: { add: (n) => classes.add(n), remove: (n) => classes.delete(n) },
    style: { setProperty() {} },
    animate: () => assert.fail('溜めでブロックの座標を拡縮した'),
  };
  r.els = new Map([[1, el]]);
  r.wait = async () => assert.ok(classes.has('charging'));
  await r.charge('col', 3, [{ id: 1 }]);
  assert.equal(classes.has('charging'), false);
});

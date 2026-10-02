import test from 'node:test';
import assert from 'node:assert/strict';
import { Sfx, note, voicedFrequency } from '../src/ui/sfx.js?v=202610020836';
import { Renderer } from '../src/ui/renderer.js?v=202610020836';

const storage = new Map();
globalThis.localStorage = { getItem: (k) => storage.get(k), setItem: (k, v) => storage.set(k, v) };
class Param {
  value = 0;
  setValueAtTime(v) { this.value = v; }
  setTargetAtTime(v) { this.value = v; }
  exponentialRampToValueAtTime(v) { this.value = v; }
}
class AudioNode {
  gain = new Param(); frequency = new Param(); Q = new Param();
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

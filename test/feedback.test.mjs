import test from 'node:test';
import assert from 'node:assert/strict';
import { Sfx, note, voicedFrequency, shalanTop, bellPitch, kitForScore, KIT_EVERY } from '../src/ui/sfx.js?v=202610100522';
import { KITS, glassBuffer } from '../src/ui/synth.js?v=202610100522';
import { Renderer } from '../src/ui/renderer.js?v=202610100522';
import { RIM_MS } from '../src/ui/rims.js?v=202610100522';

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
  gains = [];
  createGain() { const g = new AudioNode(); this.gains.push(g); return g; }
  createBiquadFilter() { return new AudioNode(); }
  createDynamicsCompressor() { return new AudioNode(); }
  createOscillator() { const n = new AudioNode(); this.sources.push(n); return n; }
  createBufferSource() { return this.createOscillator(); }
  createBuffer(c, len) { const data = new Float32Array(len); return { getChannelData: () => data }; }
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

test('シャランの最後のバーは、ゴールの音と同じ音階の高さ（バーチャイムの 2〜3.8kHz。以前は 4.5kHz までで尖りすぎたので、上限を下げた）で、連鎖が進むほど高い', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(shalanTop), [2220, 2492, 2797, 3326, 3734]);
  for (let c = 1; c <= 12; c++) {
    const top = shalanTop(c), goal = note(c - 1, 330) * Math.pow(2, -3 / 12);        // ゴールの音（tone は 3 半音下げて鳴らす）
    assert.ok(top >= 2000 && top < 3800, `連鎖 ${c}: ${top}Hz`);
    const octaves = Math.log2(top / goal);
    assert.ok(Math.abs(octaves - Math.round(octaves)) < 2e-3, `連鎖 ${c}: ゴールの音のオクターブ違いの高さ`);
  }
  const ups = [1, 2, 3, 4, 5].map(shalanTop);
  assert.ok(ups.every((f, i) => i === 0 || f > ups[i - 1]), '5 連鎖までは、連鎖が進むほど高い');
  assert.equal(shalanTop(6), shalanTop(1), '6 連鎖目からは 1 連鎖目と同じ高さに戻る（上限を超えるので 1 オクターブ下げる）');
  assert.equal(shalanTop(7), shalanTop(2));
});

test('シャランは連鎖ごとの高さの波形（長さは同じ）を、再生の速さをほぼ変えずに鳴らす。同時の連打は 1 つにまとめる', () => {
  const s = audio();
  for (let c = 1; c <= 8; c++) { s.shalan(c); s.ctx.currentTime += 0.2; }
  const used = s.ctx.sources.filter((n) => n.buffer);
  assert.equal(used.length, 8);
  assert.equal(new Set(used.slice(0, 5).map((n) => n.buffer)).size, 5, '5 連鎖までは別の波形（別の高さ）');
  assert.equal(used[5].buffer, used[0].buffer, '6 連鎖目は 1 連鎖目と同じ');
  for (let c = 1; c <= 8; c++) assert.ok(s.waves.has(`chime:0:${shalanTop(c)}`));
  assert.ok(used.every((n) => Math.abs(n.playbackRate.value - 1) <= 0.011), '高さは再生の速さでなく、波形で変える（速さを変えると長さも変わる）');
  assert.ok(used.every((n) => n.stopAt - n.started < 1.4), '長さは約 1.3 秒');
  const n = s.ctx.sources.length; s.shalan(1); s.shalan(1);
  assert.equal(s.ctx.sources.length, n + 1);
  s.stop();
});

test('全消しは「シャラン、シャラン」の 2 回（2 回目は高い）、新記録のファンファーレは 1 回', () => {
  const shalans = (x) => x.ctx.sources.filter((n) => n.buffer && [...x.waves].some(([k, w]) => k.startsWith('chime:') && w.buf === n.buffer));
  let s = audio(); s.allClear();
  const two = shalans(s);
  assert.equal(two.length, 2);
  assert.ok(two[1].started - two[0].started > 0.3);
  assert.notEqual(two[0].buffer, two[1].buffer);
  assert.ok(s.waves.has(`chime:0:${shalanTop(1)}`) && s.waves.has(`chime:0:${shalanTop(4)}`), '1 回目は 1 連鎖の高さ、2 回目は 4 連鎖の高さ');
  s.stop();
  s = audio(); s.fanfare();
  assert.equal(shalans(s).length, 1);
  s.stop();
});

/** 鳴らした鈴（波形 note:セット:k を再生の速さで合わせたもの）の高さ（Hz）。鈴でない発音は null */
function bellHz(s, n) {
  for (const [key, w] of s.waves) if (key.startsWith('note:') && w.buf === n.buffer) return 392 * 2 ** (+key.split(':')[2] / 4) * n.playbackRate.value;
  return null;
}
const bells = (s) => s.ctx.sources.map((n) => bellHz(s, n)).filter((f) => f !== null);

test('鈴の高さ: ゴールの音を 1 オクターブ上げて鈴の音域（359〜2418Hz）へ。連鎖が進むほど高く、10 連鎖までは折り返さない', () => {
  const goal = Array.from({ length: 10 }, (_, i) => bellPitch(note(i, 330), 1));
  assert.ok(Math.abs(goal[0] - 330 * Math.pow(2, -3 / 12) * 2) < 1e-9, `連鎖 1: ${goal[0]}`);
  assert.ok(goal.every((f, i) => i === 0 || f > goal[i - 1]), '連鎖が進むほど高い');
  for (let i = 0; i < 10; i++) assert.ok(Math.abs(goal[i] - voicedFrequency(note(i, 330) * Math.pow(2, -3 / 12)) * 2) < 1e-6, `連鎖 ${i + 1}: ゴールの音のちょうど 1 オクターブ上`);
  for (const f of [20, 100, 261.63, 784, 1760, 3000, 9000]) for (const oct of [0, 1, 2]) {
    const b = bellPitch(f, oct);
    assert.ok(b >= 392 * 2 ** (-1.5 / 12) - 1e-9 && b < 392 * 2 ** (31.5 / 12), `${f}Hz oct ${oct} → ${b}`);
    const o = Math.log2(b / (voicedFrequency(f * Math.pow(2, -3 / 12)) * 2 ** oct));
    assert.ok(Math.abs(o - Math.round(o)) < 1e-9, '折りたたむのはオクターブ単位（音名は変わらない）');
  }
});

test('ゴールは鈴の根音 + 5 度（4 連鎖から 3 度も）+ 低い着地音。ゴールの音の高さを再生の速さ ±9% 以内で合わせ、連鎖が進むほど強く、同時の発音は 1 回につき 3〜4 ボイス', () => {
  const s = audio(); s.goal(1, 1);
  const f = bells(s);
  assert.equal(f.length, 2); assert.ok(Math.abs(f[0] - 555) < 1, `根音 ${f[0]}`); assert.ok(Math.abs(f[1] / f[0] - 1.5) < 0.002, `5 度 ${f[1] / f[0]}`);
  assert.equal(s.voices.size, 3, '根音・5 度・低い着地音');
  for (const n of s.ctx.sources.filter((x) => x.buffer)) assert.ok(n.playbackRate.value > 0.91 && n.playbackRate.value < 1.092, `速さ ${n.playbackRate.value}`);
  s.stop();
  const t = audio(); t.goal(4, 1);
  const g = bells(t);
  assert.equal(g.length, 3); assert.ok(Math.abs(g[2] / g[0] - 1.25) < 0.002, '4 連鎖から 3 度');
  assert.equal(t.voices.size, 4);
  t.stop();
  const low = audio(), high = audio(), a = low.ctx.gains.length;
  low.goal(1, 1); high.goal(10, 1);
  const level = (x) => Math.max(...x.ctx.gains.slice(a).map((n) => n.gain.value));                    // 鈴の強さは、出口の前のゲインで決まる
  assert.ok(level(high) > level(low) * 1.5, `連鎖が進むほど大きい ${level(low)} → ${level(high)}`);
  low.stop(); high.stop();
});

test('鈴は 1 回の発音で 1 ボイス。響きは重ねた減衰で切り、聞こえなくなるころにボイスを止める（鳴り終わったら接続を切る）', () => {
  const s = audio(); s.goal(2, 1);
  const bellSources = s.ctx.sources.filter((n) => n.buffer);
  assert.equal(bellSources.length, 2);
  for (const n of bellSources) assert.ok(n.stopAt - n.started > 0.2 && n.stopAt - n.started < 0.75, `${n.stopAt - n.started}`);
  for (const n of s.ctx.sources) n.onended();
  assert.equal(s.voices.size, 0);
  assert.ok(s.ctx.sources.every((n) => n.disconnected));
});

test('手駒の補充は上がる 3 つの鈴、ぴったりは「カチッ」+ 上がる 2 つの鈴、砕ける音は 3 つの鈴、コンボ・褒め言葉は和音の鈴（段階が進むほど音が増える）', () => {
  const run = (f) => { const s = audio(); f(s); const out = bells(s); s.stop(); return out; };
  const refill = run((s) => s.refill());
  assert.equal(refill.length, 3); assert.ok(refill[0] < refill[1] && refill[1] < refill[2]);
  assert.equal(run((s) => s.fit()).length, 2);
  assert.equal(run((s) => s.shatter()).length, 3);
  assert.equal(run((s) => s.combo(3)).length, 3);
  assert.deepEqual([1, 2, 3, 4, 5].map((t) => run((s) => s.praise(t)).length), [3, 4, 5, 5, 5], '段階が上がるほど和音が厚い（最大 5 音）');
  const c = run((s) => s.combo(2));
  assert.ok(Math.abs(c[1] / c[0] - 1.25) < 0.002 && Math.abs(c[2] / c[0] - 1.5) < 0.002, '根音・3 度・5 度');
  assert.equal(run((s) => s.fanfare()).length, 4);
  assert.equal(run((s) => s.allClear()).length, 6);
});

test('鈴もミュートで止まり（予約した音も残さない）、波形を作れない環境でも入力を壊さない（鈴以外の音は鳴る）', () => {
  const s = audio(); s.allClear();
  assert.ok(bells(s).length >= 6);
  s.enabled = false;
  assert.equal(s.voices.size, 0);
  const n = s.ctx.sources.length; s.goal(3); s.refill(); assert.equal(s.ctx.sources.length, n);
  s.enabled = true; s.ctx.currentTime += 1; s.goal(3); assert.ok(s.voices.size > 0);
  s.stop();
  const t = audio(); t.ctx.createBuffer = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => { t.goal(5, 2); t.refill(); t.combo(4); t.praise(5); t.fit(); t.fanfare(); });
  assert.ok(t.voices.size >= 1, '低い着地音などは鳴る');
  assert.equal(t.ctx.sources.filter((x) => x.buffer).length, 0);
  t.stop();
});

test('波形は 1 回だけ作って使い回し、warm で 1 つずつ先に作れる。AudioContext を作り直したら作り直す', () => {
  const s = audio();
  assert.equal(s.waves.size, 0);
  let more = true, calls = 0;
  while (more) { more = s.warm(); assert.ok(++calls <= 40); }
  assert.equal(s.waves.size, 40, 'いまのセットと次のセットの、置く音 4 種 + シャラン（高さ 5 種）+ 鈴（高さ 11 段）');
  const glass1 = s.waves.get('place:0:1');
  s.glass(1); assert.equal(s.waves.get('place:0:1'), glass1);
  s.ctx = new Context(); s.connect();
  assert.equal(s.waves.size, 0);
  assert.equal(s.warm(), true);
  s.stop();
});

/* ---- 音のセット（ガラス → 木琴 → オルゴール）をスコアでローテーション ---- */
test('音のセットはスコアが KIT_EVERY 点進むごとに順に替わり、最後まで行ったら最初へ戻る（0 点〜は最初のガラス）', () => {
  assert.deepEqual(KITS, ['glass', 'marimba', 'musicbox']);
  assert.equal(KIT_EVERY, 1000);
  assert.deepEqual([0, 1, 999, 1000, 1999, 2000, 2999, 3000, 3999, 4000, 6000].map(kitForScore), [0, 0, 0, 1, 1, 2, 2, 0, 0, 1, 0]);
  for (const bad of [-5, NaN, undefined, null, Infinity]) assert.equal(kitForScore(bad), 0, `${bad}`);
  assert.equal(kitForScore(964022), Math.floor(964022 / 1000) % 3, '大きなスコアでも順番に回る');
  for (let sc = 0; sc < 20000; sc += 137) assert.ok([0, 1, 2].includes(kitForScore(sc)));
});

test('音のセットを替えると、置く音・シャラン・鈴がそのセットの波形に替わる。短い操作の音は変わらない', () => {
  const kinds = (s) => s.ctx.sources.filter((n) => n.buffer).map((n) => [...s.waves].find(([, w]) => w.buf === n.buffer)?.[0]);
  for (const kit of [0, 1, 2]) {
    const s = audio(); s.setKit(kit);
    s.place(3); s.ctx.currentTime += 1; s.shalan(2); s.ctx.currentTime += 1; s.goal(2, 1);
    const keys = kinds(s);
    assert.match(keys[0], new RegExp(`^place:${kit}:\\d$`), 'placing');
    assert.match(keys[1], new RegExp(`^chime:${kit}:\\d+$`));
    assert.ok(keys.slice(2).length === 2 && keys.slice(2).every((k) => new RegExp(`^note:${kit}:\\d+$`).test(k)), '鈴（ゴールの根音と 5 度）');
    s.stop();
  }
  // どのセットでも同じ操作の音（持ち上げ・置けない）は、波形ではなく短い音で、セットに関係なく鳴る
  for (const kit of [0, 1, 2]) { const s = audio(); s.setKit(kit); s.pick(); s.invalid(); assert.equal(s.ctx.sources.filter((n) => n.buffer).length, 0); s.stop(); }
});

test('place(cells, kit): ターンの音のセットを指定すると、いまのセットが先に替わっていても、そのターンの楽器で置く音が鳴る', () => {
  const s = audio(); s.setKit(2);
  s.place(2, 0); s.ctx.currentTime += 1; s.place(2, 1); s.ctx.currentTime += 1; s.place(2);
  const keys = s.ctx.sources.filter((n) => n.buffer).map((n) => [...s.waves].find(([, w]) => w.buf === n.buffer)[0]);
  assert.deepEqual(keys.map((k) => +k.split(':')[1]), [0, 1, 2]);
  assert.equal(s.kit, 2, '指定しても、いまのセットは変わらない');
  s.stop();
});

test('ガラス盤面はスコアや待機ターンの指定に関係なく既存のガラス波形を使う', () => {
  const s = audio(); s.warmSoon = () => {};
  s.setKit(2); s.setBoardTheme('glass');
  for (const score of [0, 999, 1000, 1999, 2000, 3000, 7466, 943475]) {
    const queuedKit = kitForScore(score);
    s.setKit(queuedKit);
    s.place(4, queuedKit); s.glass(1, .3, queuedKit);
    s.ctx.currentTime += 1; s.shalan(2); s.goal(2);
    assert.equal(s.kit, 0);
    const keys = s.ctx.sources.filter((n) => n.buffer).map((n) => [...s.waves].find(([, w]) => w.buf === n.buffer)?.[0]);
    assert.ok(keys.length >= 5 && keys.every((k) => /^glass:[0-3]$/.test(k)), `score ${score}`);
    s.stop(); s.ctx.sources = [];
  }
});

test('ガラス解除は進行中のターンの楽器へ戻り、固定中は不要な次の楽器を先読みしない', () => {
  const s = audio(); s.warmSoon = () => {};
  while (s.warm()) {}
  s.setBoardTheme('glass');
  while (s.warm()) {}
  assert.deepEqual([...s.waves.keys()], ['glass:0', 'glass:1', 'glass:2', 'glass:3']);
  assert.equal(s.kitReady(), true);
  s.setKit(1); s.setKit(2); s.setBoardTheme('gem');
  assert.equal(s.kit, 2);
  s.place(1);
  assert.ok(s.ctx.sources.some((n) => n.buffer === s.waves.get('place:2:0')?.buf));
  s.setKit(0); s.setBoardTheme('glass'); s.setBoardTheme('gem');
  while (s.warm()) {}
  assert.deepEqual([...new Set([...s.waves.keys()].map((k) => +k.split(':')[1]))].sort(), [0, 1]);
  s.stop();
});

test('ガラス盤面の配置・コンボ・連鎖・全消し・操作音はすべて既存のコップの波形だけを再生する', () => {
  const s = audio(); s.warmSoon = () => {}; s.setBoardTheme('glass');
  const calls = [
    ['place', 4, 2], ['pick'], ['fitHover'], ['fit'], ['hover'], ['anticipate', 4], ['invalid'],
    ['charge', 3], ['sink', 3, 8], ['step', 1, 2], ['goal', 4, 2], ['push', 3], ['rows', 2, 3],
    ['combo', 5], ['praise', 5], ['fanfare'], ['allClear'], ['shatter'], ['refill'], ['wave'],
    ['pop', 3], ['bubbles'], ['blip'], ['rattle'], ['tick', 2], ['swoosh'], ['swoosh', true], ['settle'], ['over'], ['shalan', 3],
  ];
  for (const [method, ...args] of calls) {
    s.ctx.currentTime += 2; s.ctx.sources = []; s[method](...args);
    assert.ok(s.ctx.sources.length > 0, `${method} は無音にならない`);
    for (const src of s.ctx.sources) {
      assert.ok(src.buffer, `${method} は正弦波・三角波の発振器を使わない`);
      const entry = [...s.waves].find(([, w]) => w.buf === src.buffer);
      assert.match(entry?.[0] || '', /^glass:[0-3]$/, `${method} は鈴・チャイム・雑音を使わない`);
      assert.deepEqual(src.buffer.getChannelData(0), glassBuffer(s.ctx.sampleRate, Number(entry[0].split(':')[1])));
      assert.ok(src.buffer.getChannelData(0).some((v) => Math.abs(v) > .1), `${method} の波形に音が入っている`);
      assert.ok(src.playbackRate.value >= .8 && src.playbackRate.value <= 1.5, `${method} はガラスの高い響きを保つ`);
    }
    s.stop();
  }
  s.setBoardTheme('gem'); s.ctx.sources = []; s.combo(3);
  assert.ok(s.ctx.sources.some((n) => n.buffer === [...s.waves].find(([key]) => key.startsWith('note:'))?.[1].buf));
});

test('3D の盤面（ガラスの立方体）もガラス盤面と同じく、既存のガラスのコップの波形だけを使う', () => {
  const s = audio(); s.warmSoon = () => {};
  s.setKit(2); s.setBoardTheme('3d');
  assert.equal(s.kit, 0);
  while (s.warm()) {}
  assert.deepEqual([...s.waves.keys()], ['glass:0', 'glass:1', 'glass:2', 'glass:3']);
  s.ctx.sources = []; s.place(4, 2); s.ctx.currentTime += 1; s.shalan(2); s.goal(2); s.combo(3);
  const keys = s.ctx.sources.filter((n) => n.buffer).map((n) => [...s.waves].find(([, w]) => w.buf === n.buffer)?.[0]);
  assert.ok(keys.length >= 4 && keys.every((k) => /^glass:[0-3]$/.test(k)));
  s.setBoardTheme('gem');
  assert.equal(s.kit, 2);
  s.stop();
});

test('ガラスだけの音でもミュート・一時停止・中断で予約音を残さない', () => {
  const s = audio(); s.warmSoon = () => {}; s.setBoardTheme('glass');
  s.combo(4); assert.ok(s.voices.size === 3);
  s.enabled = false; assert.equal(s.voices.size, 0);
  const count = s.ctx.sources.length; s.place(4); s.allClear(); assert.equal(s.ctx.sources.length, count);
  s.enabled = true; s.allClear(); assert.ok(s.voices.size > 0);
  s.setPaused(true); assert.equal(s.voices.size, 0); s.combo(3); assert.equal(s.voices.size, 0);
  s.setPaused(false); s.goal(4); assert.ok(s.voices.size > 0);
  s.markStale(); assert.equal(s.voices.size, 0); s.place(3); assert.equal(s.voices.size, 0);
});

test('音のセットを替えたら、使わないセットの波形は捨て、次のセットを先に作り始める（メモリを使いすぎない）', () => {
  const s = audio(); let started = 0; s.warmSoon = () => { started++; };
  const kits = () => [...new Set([...s.waves.keys()].map((k) => +k.split(':')[1]))].sort();
  let more = true; while (more) more = s.warm();                    // いまのセット 0 と、次の 1 を作る
  assert.deepEqual(kits(), [0, 1]);
  s.setKit(1);
  assert.deepEqual(kits(), [1], '0 はもう使わない（次は 2）ので捨てる');
  assert.equal(started, 1, '次のセットを空き時間に作り始める');
  more = true; while (more) more = s.warm();
  assert.deepEqual(kits(), [1, 2]);
  s.setKit(2);
  assert.deepEqual(kits(), [2], '1 を捨てる（次は 0）');
  more = true; while (more) more = s.warm();
  assert.deepEqual(kits(), [0, 2]);
  s.stop();
});

test('warm はいまのセット → 次のセットの順に 1 つずつ作る。作ったものは作り直さない', () => {
  const s = audio(); s.warmSoon = () => {};
  const order = [];
  const waveOf = s.waveOf.bind(s); s.waveOf = (k) => { order.push(+k.split(':')[1]); return waveOf(k); };
  s.setKit(1);
  let more = true; while (more) more = s.warm();
  assert.equal(order.length, 40);
  assert.ok(order.slice(0, 20).every((k) => k === 1) && order.slice(20).every((k) => k === 2), 'いまの 1 → 次の 2');
  const before = order.length; s.warm(); assert.equal(order.length, before, '全部作ったら何もしない');
  s.setKit(2);                                                       // 1 を捨て、2 は残してあるので、次の 0 だけ作る
  more = true; while (more) more = s.warm();
  assert.equal(order.length, before + 20);
  assert.ok(order.slice(before).every((k) => k === 0));
  s.stop();
});

test('kitReady: いまのセットの波形が全部できたら true（次のセットを作るのは、そのあと空き時間に）', () => {
  const s = audio(); s.warmSoon = () => {};
  assert.equal(s.kitReady(), false);
  let guard = 0; while (!s.kitReady() && guard++ < 100) s.warm();
  assert.equal(s.kitReady(), true); assert.equal(s.waves.size, 20, 'いまのセットだけ（次のセットはまだ）');
  s.setKit(1);
  assert.equal(s.kitReady(), false, '替えたら、そのセットを作り終えるまで false（0 は捨てられ、1 は作ってあるぶんだけ）');
  while (!s.kitReady() && guard++ < 200) s.warm();
  assert.equal(s.kitReady(), true);
  s.stop();
});

test('音のセットの番号が範囲外・同じ番号なら何もしない。波形を作れない環境でも替えられる', () => {
  const s = audio(); let started = 0; s.warmSoon = () => { started++; };
  s.setKit(0); assert.equal(started, 0); assert.equal(s.kit, 0);
  s.setKit(7); s.setKit(-1); s.setKit(1.5); s.setKit('x');
  assert.equal(s.kit, 0, '範囲外はガラスへ');
  s.setKit(2); assert.equal(s.kit, 2); assert.equal(started, 1);
  s.ctx.createBuffer = () => { throw new Error('unavailable'); };
  assert.doesNotThrow(() => { s.setKit(1); s.place(3); s.shalan(2); s.goal(2, 1); });
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
  const calls = { stars: [], shalan: [], rims: [] };
  const r = Object.assign(Object.create(Renderer.prototype), {
    fxLayer: el('layer'), cell: 35, W: 280, wrapW: 390, topY: 300, frameMs, rush,
    fxTimers: new Set(), pausedAnimations: new Set(), fxPaused: false, gen: 0,
    sparkLayer: { twinkle: (x, y, o) => { calls.stars.push({ x, y, ...o }); return true; }, clear() { calls.cleared = true; } },
    rims: { flash: (x, y, color, delay) => { calls.rims.push({ x, y, color, delay }); }, clear() { calls.rimsCleared = true; } },
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
  assert.equal(r.fxLayer.children.length, 0); assert.equal(calls.shalan.length, 0); assert.equal(calls.rims.length, 0); assert.equal(calls.stars.length, 0);
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
  assert.equal(r.fxLayer.children.length, 1); assert.equal(calls.stars.length, 0); assert.equal(calls.rims.length, 0);
  r.done();
});

test('遅い端末では、星（品質 0.6 未満）→ 跡の光（0.5 未満）の順に減らす', () => {
  const mid = glowRenderer({ frameMs: 31 });                                  // 品質 ≈ 0.58
  mid.r.lineGlow('col', 3, 'red', 1); mid.r.trail('col', 3, 'red', 540); mid.r.goalSparkle(['red'], 2);
  assert.equal(mid.calls.stars.length, 0, '星は出さない');
  assert.equal(mid.r.fxLayer.children.length, 1, '枠 1（跡は canvas）'); assert.equal(mid.calls.rims.length, 9, '跡 9');
  const slow = glowRenderer({ frameMs: 60 });                                 // 品質 0.25
  slow.r.lineGlow('col', 3, 'red', 1); slow.r.trail('col', 3, 'red', 540);
  assert.equal(slow.r.fxLayer.children.length, 1, '枠だけ'); assert.equal(slow.calls.rims.length, 0);
  mid.r.done(); slow.r.done();
});

test('通過した跡: 列車の後ろが抜けた順に、ラインの外の通路の入り口までの 9 マスが光る。星は交互に白とブロックの色', () => {
  const { r, calls } = glowRenderer();
  r.trail('col', 3, 'green', 540);
  const flashes = calls.rims;
  assert.equal(flashes.length, 9);
  assert.ok(flashes.every((f) => f.color === 'green'), 'ブロックの色で光る');
  const delays = flashes.map((f) => f.delay);
  assert.ok(delays.every((d, i) => i === 0 || d > delays[i - 1]), '抜けた順に点る');
  assert.ok(delays[0] > 0 && delays[8] <= 540 + 1e-6, '列車が通り終える（9 マス）までに全部点る');
  assert.ok(RIM_MS <= 320, 'ほんの少しだけ光る');
  assert.equal(r.fxLayer.children.length, 0, '光は要素ではなく canvas に描く（要素を動かすと毎フレームの仕事が増える）');
  assert.deepEqual(calls.stars.map((s) => s.color), ['white', 'green', 'white', 'green', 'white', 'green', 'white', 'green', 'white']);
  r.done();
});

test('横ラインの跡は縦と同じ時刻・左右対称の位置。ゴールでは星がはじける', () => {
  const a = glowRenderer(), b = glowRenderer();
  a.r.trail('col', 4, 'red', 600); b.r.trail('row', 4, 'red', 600);
  assert.deepEqual(a.calls.rims.map((f) => f.delay), b.calls.rims.map((f) => f.delay));
  a.calls.rims.forEach((f, i) => { const g = b.calls.rims[i]; assert.ok(Math.abs(f.x - g.y) < 1e-6 && Math.abs(f.y - g.x) < 1e-6, `${i}: (${f.x},${f.y}) ↔ (${g.x},${g.y})`); });
  a.r.goalSparkle(['red', 'blue'], 2);
  assert.equal(a.calls.stars.length, 9 + 6);                                  // 跡 9 + ゴール 6
  assert.ok(a.calls.stars.slice(9).every((s) => s.size >= 35 * 0.5 && s.delay <= 6 * 22));
  a.r.done(); b.r.done();
});

test('リセットで星も全部消す', () => {
  const { r, calls } = glowRenderer();
  const kept = { fx2: [], fxLayer: [] };                                      // 小さな演出の canvas（要素）は、中身を空にしても残す
  const canvas = (name) => ({ el: { name }, clear() {} });
  Object.assign(r, { gen: 0, sfx: { stop() {} }, clearCelebration() {}, wrap: { getAnimations: () => [] }, waiters: new Set(), shardLayer: { clear() { calls.shardsCleared = true; } },
    fxTop: canvas('top'), rimFx: canvas('rim'),
    fx2: { replaceChildren: (...c) => { kept.fx2 = c; } },
    blockLayer: { innerHTML: 'x' }, hintLayer: { innerHTML: 'x' }, tints: new Map(), clearAnnotations() {}, setFever() {}, setDanger() {}, els: new Map(), manual: new Set(),
    setRush() {}, clearPreview() {} });
  r.fxLayer.replaceChildren = (...c) => { kept.fxLayer = c; };
  r.reset();
  assert.equal(calls.cleared, true); assert.equal(calls.shardsCleared, true); assert.equal(calls.rimsCleared, true, '光の跡も消す');
  assert.deepEqual(kept.fx2.map((e) => e.name), ['top']); assert.deepEqual(kept.fxLayer.map((e) => e.name), ['rim']);
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const timerRenderer = () => Object.assign(Object.create(Renderer.prototype), {
  fxTimers: new Set(), pausedAnimations: new Set(), fxPaused: false, gen: 0,
  wrap: { getAnimations: () => [] }, fxTop: { setPaused() {} }, rimFx: { setPaused() {} },
});

test('演出を止めている間は遅延音が発火せず、再開時に残りの時間を待つ', async () => {
  const r = timerRenderer(); let fired = 0;
  r.later(() => fired++, 60); r.setPaused(true);
  await wait(85); assert.equal(fired, 0);
  r.setPaused(false); await wait(20); assert.equal(fired, 0);
  await wait(65); assert.equal(fired, 1); assert.equal(r.fxTimers.size, 0);
});

test('一時停止は canvas の演出（星・かけら・光の跡）の時計も止める', () => {
  const r = timerRenderer(), calls = [];
  r.fxTop = { setPaused: (on) => calls.push(['top', on]) }; r.rimFx = { setPaused: (on) => calls.push(['rim', on]) };
  r.setPaused(true); r.setPaused(true); r.setPaused(false);
  assert.deepEqual(calls, [['top', true], ['rim', true], ['top', false], ['rim', false]]);
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

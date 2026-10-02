import { glassBuffer, shalanBuffer, GLASS_VARIANTS, SHALAN_TOP } from './synth.js?v=202610020948';

/** 効果音と振動。WebAudio のみ（アセット不要）。初回タップで有効化。 */
const PENTA = [0, 2, 4, 7, 9];
const LOWER = Math.pow(2, -3 / 12), MAX_HZ = 1760;
const VOICE_LIMIT = 40;
const LEVEL = 0.32;                                    // 全体の音量（ミュートでは 0）
/**
 * 作っておく波形（synth.js）。ガラスを置く音（コップの高さ違い 4 つ）と、ベルのシャラン。
 * 鳴らすたびに計算せず、AudioBuffer を 1 回だけ作って使い回す（作るのは数 ms。起動後の空き時間に先に作っておく）
 */
const WAVES = {
  ...Object.fromEntries(Array.from({ length: GLASS_VARIANTS }, (_, v) => [`glass${v}`, (sr) => glassBuffer(sr, v)])),
  shalan: shalanBuffer,
};
// 上限で切りそろえると和音も大連鎖も同じ音になる。上限を超えた音はオクターブ下へ戻す。
export const voicedFrequency = (hz) => {
  hz = Math.max(45, Number.isFinite(hz) ? hz : 220);
  while (hz > MAX_HZ) hz /= 2;
  return hz;
};
// 2オクターブの旋律。長い連鎖でも音を潰さず、フレーズを繰り返しながら厚みを足す。
export const note = (i, base = 261.63) => {
  const k = Math.max(0, Math.floor(i)) % 10;
  return base * 2 ** ((PENTA[k % 5] + Math.floor(k / 5) * 12) / 12);
};

export class Sfx {
  constructor() {
    this.ctx = null; this._enabled = true; this.paused = false;
    this.gestureAt = 0; this.stuckSince = 0; this.stale = false;
    this.voices = new Set(); this.last = new Map(); this.placement = 0; this.waves = new Map();
    try { this._enabled = localStorage.getItem('blockmancala-sound') !== 'off'; } catch {}
  }
  get enabled() { return this._enabled; }
  set enabled(on) {
    this._enabled = !!on;
    if (!on) this.stop();
    if (this.ctx) for (const out of [this.master, this.bright]) out?.gain.setTargetAtTime(on ? LEVEL : 0, this.ctx.currentTime, 0.008);
    try { localStorage.setItem('blockmancala-sound', on ? 'on' : 'off'); } catch {}
  }
  /** 音を止めると、予約済みのアルペジオ・余韻も残さない。 */
  stop() {
    for (const v of [...this.voices]) v.end();
    this.last.clear();
    try { navigator.vibrate?.(0); } catch {}
  }
  setPaused(on) { this.paused = !!on; if (on) this.stop(); }
  /** 同時発音を制限し、操作音には飾りの音より優先して枠を渡す。 */
  track(source, nodes, priority) {
    if (this.voices.size >= VOICE_LIMIT) {
      const victim = [...this.voices].find((v) => v.priority <= priority);
      if (!victim) { nodes.forEach((n) => n.disconnect()); source.disconnect(); return false; }
      victim.end();
    }
    const cleanup = () => {
      this.voices.delete(v); source.disconnect(); nodes.forEach((n) => n.disconnect());
    };
    const v = { priority, end: () => { try { source.stop(); } catch {} cleanup(); } };
    source.onended = cleanup;
    this.voices.add(v);
    return true;
  }
  /** 高速ドラッグ・同時着地では細かい音を束ねる。止まった AudioContext に時刻を残さない。 */
  allow(key, interval) {
    if (!this.ready()) return false;
    const now = this.ctx.currentTime, prev = this.last.get(key) ?? -Infinity;
    if (now - prev < interval) return false;
    this.last.set(key, now);
    return true;
  }
  /**
   * 音を使えるようにする。指の操作のたびに呼ぶ（bindGestures）。
   * iOS Safari は、指を「離した」時（touchend / click）の中でしか音の開始・再開を許さない。
   * 指を「置いた」時（pointerdown = touchstart）や setTimeout からの resume() は無視されるので、
   * ピースを動かしているだけでは止まった音が戻らず、ボタンを押したときだけ戻っていた
   */
  unlock(gesture = false) {
    if (gesture) this.gestureAt = performance.now();
    if (this.ctx && this.ctx.state === 'closed') this.ctx = null;
    // 裏に回って戻ってきた後は、iOS で「running なのに無音」のままになることがあるので、最初の操作で作り直す
    if (this.ctx && gesture && this.stale) { this.closeCtx(); this.ctx = null; }
    if (gesture) this.stale = false;
    if (!this.ctx) { this.build(); if (!this.ctx) return; }
    else if (this.ctx.state !== 'running') {
      // 指の操作で何度 resume しても戻らない（iOS の「中断」から抜けられなくなった）ときは作り直す
      if (gesture && this.stuckSince && performance.now() - this.stuckSince > 1500) {
        this.closeCtx();
        this.build();
        if (!this.ctx) return;
      } else this.resumeUntilRunning();
    }
    if (this.ctx.state === 'running') this.stuckSince = 0;
    else if (!this.stuckSince) this.stuckSince = performance.now();
    // iOS: 操作の中で無音を1つ鳴らすと、そのあとの音が確実に出るようになる
    if (gesture) this.kick();
  }
  closeCtx() { this.stop(); const c = this.ctx; if (!c) return; c.onstatechange = null; try { c.close().catch(() => {}); } catch {} }
  /** 画面が裏に回った（アプリの切り替え・通知・画面収録の開始など）。次の操作で作り直す */
  markStale() { this.stop(); if (this.ctx) this.stale = true; }
  /** AudioContext と出力までの経路を作る */
  build() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    // iOS Safari 16.4+: 既定では消音（サイレント）スイッチがオンだと鳴らない。ゲームの効果音として
    // 消音スイッチを無視して鳴らす（マナーモードでも音が出るようになる）
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch {}
    try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch { this.ctx = null; return; }
    this.connect();
    // 中断（コントロールセンター・画面収録・着信など）から戻ったら、すぐ再開を試みる
    this.ctx.onstatechange = () => {
      if (this.ctx?.state === 'running') this.stuckSince = 0;
      else this.resumeUntilRunning();
    };
    this.resumeUntilRunning();
    this.warmSoon();
  }
  /** 音の出口。OfflineAudioContext でも同じ回路を検証できる。 */
  connect() {
    this.noiseBuf = null; this._tickAt = 0;                  // 前の AudioContext のバッファ・時刻は使えない
    this.waves.clear();
    this.last.clear();
    this.master = this.ctx.createGain();
    this.master.gain.value = this.enabled ? LEVEL : 0;
    // 耳心地のため、高い倍音を少し丸め、音が重なって大きくなったときも割れないよう軽く抑える
    this.soft = this.ctx.createBiquadFilter();
    this.soft.type = 'lowpass'; this.soft.frequency.value = 3800; this.soft.Q.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(this.soft); this.soft.connect(comp); comp.connect(this.ctx.destination);
    // 明るい出口: ガラスやベルの高い響き（〜9kHz）は、上の 3.8kHz のローパスで丸めずに通す。音量・ミュートは master と同じ
    this.bright = this.ctx.createGain();
    this.bright.gain.value = this.enabled ? LEVEL : 0;
    this.air = this.ctx.createBiquadFilter();
    this.air.type = 'lowpass'; this.air.frequency.value = 9500; this.air.Q.value = 0.5;
    this.bright.connect(this.air); this.air.connect(comp);
    this.output = comp;
  }
  /** 無音を一瞬だけ鳴らす（iOS の音の許可を確実にするため。操作の中で呼ぶ） */
  kick() {
    try {
      const src = this.ctx.createBufferSource();
      src.buffer = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      src.connect(this.ctx.destination);
      src.onended = () => src.disconnect();
      src.start(0);
    } catch {}
  }
  /** running になるまで resume() を繰り返す（中断が解けるまで少し間が要ることがあるため） */
  resumeUntilRunning(triesLeft = 10, ctx = this.ctx) {
    if (!ctx || ctx !== this.ctx || ctx.state === 'running' || ctx.state === 'closed' || triesLeft <= 0) return;
    ctx.resume().catch(() => {});
    setTimeout(() => this.resumeUntilRunning(triesLeft - 1, ctx), 400);
  }
  /**
   * 今この音を予約してよいか。止まった時計に予約した音は、ずっと後で戻ったときにまとめて鳴ってしまうので出さない。
   * ただし操作の直後（再開を頼んだばかりで、まだ running に変わっていないだけ）は予約する（すぐ再開して鳴る）
   */
  ready() {
    if (!this.enabled || this.paused || this.stale || !this.ctx || this.ctx.state === 'closed') return false;
    if (this.ctx.state === 'running') return true;
    this.resumeUntilRunning();
    return this.ctx.state === 'suspended' && performance.now() - this.gestureAt < 500;
  }
  /** 画面のどこを触っても、指を離したときに音を使えるようにする（iOS はここでしか音を再開できない） */
  bindGestures(target = document) {
    const on = () => this.unlock(true);
    for (const type of ['touchend', 'pointerup', 'click', 'keydown']) target.addEventListener(type, on, { capture: true, passive: true });
  }
  tone(freq, { dur = 0.1, type = 'sine', gain = 0.6, at = 0, slide = 0, attack = 0.004, priority = 1 } = {}) {
    if (!this.ready()) return;
    const t = this.ctx.currentTime + at;
    freq = voicedFrequency(freq * LOWER);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(voicedFrequency(freq * slide), t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + Math.min(attack, dur * 0.4));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    if (!this.track(o, [g], priority)) return;
    o.start(t); o.stop(t + dur + 0.03);
  }
  /**
   * 作っておいた波形（synth.js の WAVES）を明るい出口から鳴らす。rate = 再生の速さ（1 = そのまま。高さと長さが変わる）。
   * 1 回の発音で 1 ボイス（たくさんの共鳴を足し合わせた音でも、同時発音の枠を使い切らない）
   */
  playBuffer(key, { gain = 1, rate = 1, at = 0, priority = 1 } = {}) {
    if (!this.ready()) return;
    const wave = this.waveOf(key);
    if (!wave) return;
    const t = this.ctx.currentTime + at, dur = wave.dur / rate;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = wave.buf;
    src.playbackRate.value = rate;
    g.gain.value = gain;
    src.connect(g); g.connect(this.bright);
    if (!this.track(src, [g], priority)) return;
    src.start(t); src.stop(t + dur + 0.02);
  }
  /** 波形 key の AudioBuffer（無ければ作る。この AudioContext の sampleRate で）。作れなければ null */
  waveOf(key) {
    let w = this.waves.get(key);
    if (w || !WAVES[key]) return w ?? null;
    try {
      const sr = this.ctx.sampleRate, data = WAVES[key](sr), buf = this.ctx.createBuffer(1, data.length, sr);
      buf.getChannelData(0).set(data);
      w = { buf, dur: data.length / sr };
    } catch { return null; }
    this.waves.set(key, w);
    return w;
  }
  /** 波形を 1 つ作っておく（まだ作っていないものがあれば true）。最初に鳴らす瞬間に、作る計算で引っかからないように */
  warm() {
    if (!this.ctx || this.ctx.state === 'closed') return false;
    const next = Object.keys(WAVES).find((k) => !this.waves.has(k));
    if (next && !this.waveOf(next)) return false;
    return Object.keys(WAVES).some((k) => !this.waves.has(k));
  }
  /** 起動後の空き時間に、波形を 1 つずつ作っておく（まとめて作ると、それはそれで一瞬止まるので） */
  warmSoon() {
    const ctx = this.ctx;
    const idle = (f) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout: 1500 }) : setTimeout(f, 150));
    const next = () => { if (this.ctx === ctx && this.warm()) idle(next); };
    idle(next);
  }
  vibe(p) { if (this.enabled && !this.paused && !this.stale) try { navigator.vibrate?.(p); } catch {} }

  pick()        { this.tone(530, { dur: 0.045, gain: 0.19, slide: 1.12, priority: 2 }); this.vibe(5); }
  // ガラスのコップをテーブルに置く音。コップの高さを順に変え（4 種）、マス数が多いほど低く重く
  place(cells = 1) {
    const weight = Math.min(1, Math.max(0, (cells - 1) / 8));
    this.glass(this.placement++ % GLASS_VARIANTS, weight);
    this.tone(250 - weight * 55, { dur: 0.08, gain: 0.22, slide: 0.55, attack: 0.002, priority: 3 });   // 盤面が受け止める低い胴鳴り
    this.vibe(10 + Math.round(weight * 5));
  }
  /** ガラスを置く音だけ。variant = コップの高さ（0〜3）、weight = 重さ（0〜1。重いほど低い） */
  glass(variant = 0, weight = 0.3) {
    this.playBuffer(`glass${variant % GLASS_VARIANTS}`, { gain: 0.5, rate: (1 - weight * 0.14) * (0.98 + Math.random() * 0.04), priority: 3 });
  }
  /**
   * シャラン: クリスマスのベルのように、鈴のきらめきから音階が駆け上がり、最後の音が長く響く。
   * ゴールの音（note(chain - 1, 330)）と同じ音階の、2 オクターブ上。連鎖が進むほど高くなる（8 連鎖までは、1 連鎖ごとに別の高さ）。size = 大きさ（1 = 全消し・新記録の見せ場、ふだんのラインは 0.65 ほど）、at = 何秒後か
   */
  shalan(chain = 1, { size = 1, at = 0 } = {}) {
    if (!at && !this.allow('shalan', 0.1)) return;
    let top = note(chain - 1, 330) * LOWER * 4;
    while (top >= 2800) top /= 2;
    this.playBuffer('shalan', { gain: 0.2 * size, rate: top / SHALAN_TOP, at, priority: 1 });
  }
  /** 穴にぴったりはまる場所に入った（カチッ）・ぴったり置いた（カチッ + 上がる2音） */
  fitHover()    { if (!this.allow('fitHover', 0.08)) return;
                  this.tone(1318.5, { dur: 0.035, type: 'triangle', gain: 0.22 }); this.vibe(8); }
  fit()         { this.tone(1046.5, { dur: 0.04, type: 'triangle', gain: 0.4 });
                  [0, 4].forEach((k, i) => this.tone(note(k, 1046.5), { dur: 0.09, gain: 0.22, type: 'sine', at: 0.06 + i * 0.07 })); this.vibe(14); }
  hover()       { if (this.allow('hover', 0.055)) this.tone(1245, { dur: 0.022, gain: 0.035, priority: 0 }); }
  // 消える場所に入った: 連鎖が多いほど高く上がっていくキラッという音（期待）
  anticipate(chain) { if (!this.allow('anticipate', 0.12)) return;
                  const f = note(Math.min(chain, 7) + 1, 330);
                  this.tone(f, { dur: 0.12, gain: 0.16, type: 'triangle', slide: 1.12 });
                  this.tone(f * 1.5, { dur: 0.16, gain: 0.08, at: 0.05 }); this.vibe(8); }
  invalid()     { this.tone(155, { dur: 0.075, type: 'triangle', gain: 0.2, slide: 0.75, priority: 2 }); }
  charge(chain = 1, dur = 0.13) {
    this.noise({ dur, gain: 0.12, from: 430, to: 1550, attack: dur * 0.7, priority: 0 });
    this.tone(note(chain - 1, 196), { dur, gain: 0.1, slide: 1.12, attack: dur * 0.25, priority: 0 });
  }
  // 解放: 短い割れ音 → 低い胴鳴り → 上へ抜ける空気。高さは連鎖、厚みはラインの長さ。
  sink(chain = 1, cells = 1) {
    const weight = Math.min(cells, 8) / 8;
    this.noise({ dur: 0.075, gain: 0.32 + weight * 0.12, from: 2800, to: 650, attack: 0.002, priority: 2 });
    this.tone(132 + Math.min(chain, 8) * 4, { dur: 0.19, gain: 0.6, slide: 0.43, priority: 2 });
    this.tone(note(chain - 1, 262), { dur: 0.13, type: 'triangle', gain: 0.2, slide: 1.045, priority: 2 });
    this.noise({ dur: 0.15, gain: 0.075, from: 550, to: 2600, at: 0.025, priority: 0 });
    this.vibe(12 + Math.min(chain, 6) * 2);
  }
  step(i, chain = 1) { if (this.allow('step', 0.038)) this.tone(note(i + (chain - 1) % 3, 220), { dur: 0.04, type: 'triangle', gain: 0.105, priority: 0 }); }
  goal(chain = 1, count = 1) {
    const f = note(chain - 1, 330);
    this.tone(f, { dur: 0.2, gain: 0.43, priority: 2 });
    this.tone(f * 1.5, { dur: 0.24, gain: 0.18, at: 0.025, priority: 2 });
    this.tone(190, { dur: 0.075, gain: 0.22, slide: 0.6, priority: 2 });
    if (chain >= 4 || count > 1) this.tone(f * 1.25, { dur: 0.26, gain: 0.12, at: 0.05 });
    if (chain >= 8) this.tone(f * 2, { dur: 0.16, gain: 0.075, at: 0.09 });
    this.vibe(count > 1 ? [12, 24, 18] : 14);
  }
  push(chain)   { if (this.allow('push', 0.06)) this.tone(140 + Math.min(chain, 10) * 9, { dur: 0.09, type: 'triangle', gain: 0.24, slide: 1.3 }); }
  rows(n, chain){ for (let k = 0; k < 3 + n; k++) this.tone(note(chain + k), { dur: 0.16, gain: 0.35, at: k * 0.045 });
                  this.vibe([0, 20, 30, 30]); }
  // 連続発動: 上がっていく和音＋キラキラ
  combo(n)      { const f = note(n - 2, 262);
                  [1, 1.25, 1.5].forEach((m, k) => this.tone(f * m, { dur: 0.16, gain: 0.16, type: 'triangle', at: 0.025 + k * 0.035 }));
                  this.vibe([0, 18, 30, 26]); }
  // 褒め言葉: 段階が上がるほど和音が厚く、高く
  praise(tier)  { const base = [262, 294, 330, 392, 440][Math.max(0, Math.min(4, tier - 1))];
                  const chord = [1, 1.25, 1.5, 2, 2.5].slice(0, 2 + tier);
                  chord.forEach((m, k) => this.tone(base * m, { dur: 0.23 + tier * 0.025, gain: 0.25 / Math.sqrt(chord.length), type: k % 2 ? 'sine' : 'triangle', at: k * 0.035 }));
                  if (tier >= 4) this.tone(98, { dur: 0.22, gain: 0.35, slide: 0.65 });
                  this.vibe(tier >= 4 ? [0, 30, 40, 50] : 16); }
  // 新記録: ファンファーレ
  fanfare()     { [0, 2, 4, 5].forEach((k, i) => this.tone(note(k + 2, 523.25), { dur: i === 3 ? 0.5 : 0.12, gain: 0.3, type: 'triangle', at: i * 0.1 }));
                  this.tone(note(7, 523.25), { dur: 0.6, gain: 0.12, at: 0.3 }); this.shalan(5, { at: 0.08 }); this.vibe([0, 30, 40, 30, 40, 80]); }
  // 全消し専用: 短い立ち上がりと、盤面へ色が広がる間の上昇フレーズ。
  allClear() {
    this.noise({ dur: 0.32, gain: 0.23, from: 600, to: 2400, attack: 0.025, priority: 2 });
    this.tone(130.81, { dur: 0.3, gain: 0.45, slide: 0.6, priority: 2 });
    [0, 2, 4, 5, 7, 9].forEach((k, i) => this.tone(note(k, 262), { dur: i === 5 ? 0.52 : 0.2, gain: 0.23, type: 'triangle', at: 0.04 + i * 0.065, priority: 2 }));
    [262, 330, 392].forEach((f) => this.tone(f, { dur: 0.65, gain: 0.11, at: 0.4, priority: 2 }));
    this.shalan(1, { at: 0.06 }); this.shalan(4, { size: 0.85, at: 0.5 });          // シャラン、シャラン
    this.vibe([22, 35, 35]);
  }
  shatter() { this.noise({ dur: 0.11, gain: 0.16, from: 2600, to: 1000, attack: 0.002 });
              [784, 988, 1175].forEach((f, i) => this.tone(f, { dur: 0.17, gain: 0.09, at: i * 0.038, priority: 0 })); }
  refill()      { [0, 1, 2].forEach((k) => this.tone(note(k, 784), { dur: 0.07, gain: 0.18, at: k * 0.05 })); }
  /** 短いざらざらした音（波・しぶき）。ノイズを帯域フィルタに通す */
  noise({ dur = 0.6, gain = 0.3, from = 400, to = 1400, q = 0.8, at = 0, attack = dur * 0.3, priority = 1 } = {}) {
    if (!this.ready()) return;                                  // tone() と同じ
    const ctx = this.ctx, t = ctx.currentTime + at;
    if (!this.noiseBuf) {
      this.noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 1.5, ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    const src = ctx.createBufferSource(), f = ctx.createBiquadFilter(), g = ctx.createGain();
    src.buffer = this.noiseBuf;
    f.type = 'bandpass'; f.Q.value = q;
    f.frequency.setValueAtTime(from, t); f.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
    if (!this.track(src, [f, g], priority)) return;
    src.start(t); src.stop(t + dur + 0.05);
  }
  // 全消し: ザザーッと波がせり上がる音＋明るい和音
  wave()        { this.noise({ dur: 1.1, gain: 0.5, from: 300, to: 1800, q: 0.6 });
                  this.noise({ dur: 0.9, gain: 0.25, from: 2400, to: 900, q: 1.2, at: 0.25 });
                  [0, 4, 7, 12].forEach((k, i) => this.tone(523.25 * Math.pow(2, k / 12), { dur: 0.6, gain: 0.12, type: 'triangle', at: 0.2 + i * 0.07 }));
                  this.vibe([0, 40, 30, 60]); }
  // 風船が割れる: ポンという短い音。割れるごとに音が上がる
  pop(i = 0)    { this.noise({ dur: 0.08, gain: 0.4, from: 2500, to: 900, q: 0.7 });
                  this.tone(note(i + 2, 523.25), { dur: 0.12, gain: 0.2, type: 'triangle' });
                  this.vibe(10); }
  // シャボン玉: ぷくぷくと上がっていく小さな音
  bubbles()     { for (let k = 0; k < 7; k++) this.tone(note(k, 659), { dur: 0.08, gain: 0.1, type: 'sine', at: k * 0.09, slide: 1.3 });
                  this.noise({ dur: 0.7, gain: 0.12, from: 1200, to: 2600, q: 2 }); this.vibe([0, 20, 20, 20]); }
  blip()        { this.tone(1400 + Math.random() * 500, { dur: 0.04, gain: 0.06, slide: 1.4 }); }
  // ガムボール: ころころと降ってくる音
  rattle()      { for (let k = 0; k < 10; k++) this.tone(note(k % 6, 523.25), { dur: 0.05, gain: 0.08, type: 'triangle', at: 0.15 + k * 0.07 }); }
  tick(n = 1)   { if (this._tickAt && this.ctx && this.ctx.currentTime - this._tickAt < 0.05) return;
                  this._tickAt = this.ctx?.currentTime; this.tone(900 + Math.random() * 400, { dur: 0.03, gain: 0.05 * Math.min(3, n), type: 'triangle' }); }
  // まんまる: ふわっと広がる（close なら閉じる）音
  swoosh(close = false) { this.noise({ dur: 0.55, gain: 0.35, from: close ? 1800 : 300, to: close ? 300 : 1800, q: 0.8 });
                  if (!close) [0, 4, 7, 12].forEach((k, i) => this.tone(523.25 * Math.pow(2, k / 12), { dur: 0.5, gain: 0.1, type: 'triangle', at: 0.15 + i * 0.06 })); }
  // ブロックが列に入って止まった: 小さなコツッ
  settle(i = 0) { if (!this.allow('settle', 0.032)) return;
                 this.noise({ dur: 0.025, gain: 0.075, from: 1800, to: 650, attack: 0.001, priority: 0 });
                 this.tone(note(i, 392), { dur: 0.06, gain: 0.13, type: 'triangle', priority: 0 }); }
  // ゲームオーバー: やわらかい三角波・正弦波の和音が、ゆっくり下がって消える（耳障りなのこぎり波は使わない）
  over()        { [392, 311.1, 261.6].forEach((f, i) => this.tone(f, { dur: 0.9, type: i ? 'sine' : 'triangle', gain: 0.22, slide: 0.7, at: i * 0.12 }));
                  this.tone(196, { dur: 1.1, type: 'sine', gain: 0.25, slide: 0.8, at: 0.3 }); this.vibe([0, 60, 50, 140]); }
}

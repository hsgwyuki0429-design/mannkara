import { placeBuffer, chimeBuffer, noteBuffer, PLACE_VARIANTS, KITS } from './synth.js?v=202610030217';

/** 効果音と振動。WebAudio のみ（アセット不要）。初回タップで有効化。 */
const PENTA = [0, 2, 4, 7, 9];
const LOWER = Math.pow(2, -3 / 12), MAX_HZ = 1760;
const VOICE_LIMIT = 40;
const LEVEL = 0.32;                                    // 全体の音量（ミュートでは 0）
// 鈴の音量（正弦波・三角波だった前の音と、耳の感度で重み付けした大きさがそろうように測って決めた）
const BELL = { goal: 0.5, refill: 0.2, fit: 0.33, combo: 0.135, praise: 0.36, shatter: 0.185, fanfare: 0.54, run: 0.32 };
const SHALAN_GAIN = 0.26;                              // シャランの音量（size 1 のとき）。波形（synth.js）は尖った音のぶん山が高いので、波形の大きさを抑えて、ここで上げる
/**
 * 音のセット（synth.js の KITS: ガラス → 木琴 → オルゴール）は、スコアが KIT_EVERY 点進むごとに順に替わる（kitForScore）。
 * 置く音・シャラン・鈴（ゴール・コンボ・褒め言葉など）の楽器が替わる。短い操作の音（持ち上げ・なぞる・置けない）は、どのセットも同じ
 */
export const KIT_EVERY = 1000;
export const kitForScore = (score) => Math.floor(Math.max(0, Number.isFinite(score) ? score : 0) / KIT_EVERY) % KITS.length;
/** 置いたときの低い胴鳴り（耳に届く強さ）: ガラスのコップは底がテーブルに当たる音が波形にもあるので、木琴・オルゴールは少し控えめに */
const PLACE_THUMP = [0.22, 0.14, 0.1];
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
/**
 * シャランの最後のバー（「ラン」）の高さ（Hz）: ゴールの音（note(chain - 1, 330)）と同じ音階の 3 オクターブ上を、
 * 2〜4.5kHz に折りたたんだもの（バーチャイムの高さ）。連鎖が進むほど高くなり、6 連鎖までは別の高さ（7 連鎖目から 2 連鎖目と同じ高さに戻る）
 */
export const shalanTop = (chain) => {
  let f = note(chain - 1, 330) * LOWER * 8;
  while (f >= 3800) f /= 2;
  return Math.round(f);
};
/**
 * 鈴（synth.js の bellBuffer）の高さの決め方。音の高さごとに波形を作ると多すぎるので、短 3 度（3 半音）おきの 11 個（392〜2217Hz）の波形を
 * 作っておき、いちばん近いものを再生の速さ（±9% 以内）で合わせる（部分音の比は変わらない）。
 */
const BELL_BASE = 392, BELL_STEPS = 11;
const BELL_BOTTOM = BELL_BASE * 2 ** (-1.5 / 12), BELL_TOP = BELL_BASE * 2 ** ((3 * (BELL_STEPS - 1) + 1.5) / 12);      // 359〜2418Hz
const foldBell = (f) => { while (f >= BELL_TOP) f /= 2; while (f < BELL_BOTTOM) f *= 2; return f; };
/**
 * 鈴の音の高さ（Hz）: tone と同じ指定（freq に LOWER を掛けて聴きやすい範囲に収める）から oct 段上げて、鈴の音域（359〜2418Hz）へ折りたたむ。
 * 正弦波・三角波の「ピン」は 200〜700Hz と低く、スマホの小さなスピーカーでは基本の音がほとんど出なかった。鈴は 1 オクターブ上げて、
 * 上の部分音（オクターブ上・金属の整数でない比）で厚みを出す
 */
export const bellPitch = (freq, oct = 0) => foldBell(voicedFrequency(freq * LOWER) * 2 ** oct);
/**
 * 作っておく波形（synth.js）。セットごとに、置く音（高さ違い 4 つ）・シャラン（最後の音の高さごと）・鈴（高さ 11 段）。キーは
 * `place:セット:番号` / `chime:セット:高さ` / `note:セット:段`。鳴らすたびに計算せず、AudioBuffer を 1 回だけ作って使い回す
 * （作るのは 1 つ数 ms〜20ms。起動後の空き時間に、いまのセットと次に替わるセットを先に作っておく）。
 * シャランは再生の速さで高さを変えると長さも変わってしまうので、高さごとに合成する（長さはどれも同じ）
 */
const SHALAN_TOPS = [...new Set(Array.from({ length: 10 }, (_, i) => shalanTop(i + 1)))];
const WAVES = {};
for (let kit = 0; kit < KITS.length; kit++) {
  for (let v = 0; v < PLACE_VARIANTS; v++) WAVES[`place:${kit}:${v}`] = (sr) => placeBuffer(sr, v, kit);
  for (const top of SHALAN_TOPS) WAVES[`chime:${kit}:${top}`] = (sr) => chimeBuffer(sr, top, kit);
  for (let k = 0; k < BELL_STEPS; k++) WAVES[`note:${kit}:${k}`] = (sr) => noteBuffer(sr, BELL_BASE * 2 ** (k / 4), kit);
}
const WAVE_KEYS = Object.keys(WAVES);
const kitOf = (key) => Number(key.split(':')[1]);

export class Sfx {
  constructor() {
    this.ctx = null; this._enabled = true; this.paused = false;
    this.gestureAt = 0; this.stuckSince = 0; this.stale = false;
    this.voices = new Set(); this.last = new Map(); this.placement = 0; this.waves = new Map(); this.kit = 0;
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
    // 明るい出口: ガラスやバーチャイムの高い響き（〜9kHz）は、上の 3.8kHz のローパスで丸めずに通す。音量・ミュートは master と同じ
    this.bright = this.ctx.createGain();
    this.bright.gain.value = this.enabled ? LEVEL : 0;
    this.air = this.ctx.createBiquadFilter();
    this.air.type = 'lowpass'; this.air.frequency.value = 6500; this.air.Q.value = 0.5;
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
   * 作っておいた波形（synth.js の WAVES）を明るい出口から鳴らす。rate = 再生の速さ（1 = そのまま。高さと長さが変わる）、
   * ring = 波形の自然な減衰に重ねる、さらなる減衰が 60dB になる秒数（短いほど速く消える。0 = 重ねない）。
   * 1 回の発音で 1 ボイス（たくさんの共鳴を足し合わせた音でも、同時発音の枠を使い切らない）
   */
  playBuffer(key, { gain = 1, rate = 1, at = 0, priority = 1, ring = 0 } = {}) {
    if (!this.ready()) return;
    const wave = this.waveOf(key);
    if (!wave) return;
    const t = this.ctx.currentTime + at, dur = ring ? Math.min(ring * 0.45 + 0.05, wave.dur / rate) : wave.dur / rate;
    const src = this.ctx.createBufferSource(), g = this.ctx.createGain();
    src.buffer = wave.buf;
    src.playbackRate.value = rate;
    g.gain.value = gain;
    if (ring) { g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(gain * 0.001, t + ring); }     // 波形の自然な減衰に、さらに ring 秒で 60dB 消える減衰を重ねる（ボイスは聞こえなくなるころに止める）
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
  /** いまのセットと、次に替わるセット（先に作っておく）。それ以外の波形はメモリに残さない */
  wantedKits() { return [this.kit, (this.kit + 1) % KITS.length]; }
  /** 音のセットを替える（kitForScore で決めた番号）。使わないセットの波形は捨て、次のセットを空き時間に作り始める */
  setKit(kit) {
    kit = Number.isInteger(kit) && kit >= 0 && kit < KITS.length ? kit : 0;
    if (kit === this.kit) return;
    this.kit = kit;
    const want = this.wantedKits();
    for (const key of [...this.waves.keys()]) if (!want.includes(kitOf(key))) this.waves.delete(key);
    if (this.ctx) this.warmSoon();
  }
  /** 波形を 1 つ作っておく（まだ作っていないものがあれば true）。最初に鳴らす瞬間に、作る計算で引っかからないように。いまのセット → 次のセットの順 */
  warm() {
    if (!this.ctx || this.ctx.state === 'closed') return false;
    const todo = this.wantedKits().flatMap((kit) => WAVE_KEYS.filter((k) => kitOf(k) === kit && !this.waves.has(k)));
    if (todo.length && !this.waveOf(todo[0])) return false;
    return todo.length > 1;
  }
  /** いまのセットの波形が全部できているか */
  kitReady() { return WAVE_KEYS.every((k) => kitOf(k) !== this.kit || this.waves.has(k)); }
  /**
   * 起動後の空き時間に、波形を 1 つずつ作っておく（まとめて作ると、それはそれで一瞬止まるので）。いまのセットは 1.5 秒以内に必ず進める。
   * 次のセットは、遅れてもよいので、ほんとうに空いたときだけ（忙しい間は 8 秒まで待ち、ゲーム中に割り込ませない）
   */
  warmSoon() {
    const ctx = this.ctx;
    const idle = (f, timeout = 1500) => (typeof requestIdleCallback === 'function' ? requestIdleCallback(f, { timeout }) : setTimeout(f, 150));
    const next = () => { if (this.ctx === ctx && this.warm()) idle(next, this.kitReady() ? 8000 : 1500); };
    idle(next);
  }
  vibe(p) { if (this.enabled && !this.paused && !this.stale) try { navigator.vibrate?.(p); } catch {} }

  pick()        { this.tone(530, { dur: 0.045, gain: 0.19, slide: 1.12, priority: 2 }); this.vibe(5); }
  // 置く音（セットの楽器: ガラスのコップ・木琴・オルゴール）。高さを順に変え（4 種）、マス数が多いほど低く重く。
  // kit = このターンの音のセット（前のターンの再生が残っていても、そのターンの楽器で鳴らす）
  place(cells = 1, kit = this.kit) {
    const weight = Math.min(1, Math.max(0, (cells - 1) / 8));
    this.glass(this.placement++ % PLACE_VARIANTS, weight, kit);
    this.tone(250 - weight * 55, { dur: 0.08, gain: PLACE_THUMP[kit] ?? PLACE_THUMP[0], slide: 0.55, attack: 0.002, priority: 3 });   // 盤面が受け止める低い胴鳴り
    this.vibe(10 + Math.round(weight * 5));
  }
  /** 置く音の波形だけ（既定はガラスのコップ。kit で楽器を選ぶ）。variant = 高さ（0〜3）、weight = 重さ（0〜1。重いほど低い） */
  glass(variant = 0, weight = 0.3, kit = this.kit) {
    this.playBuffer(`place:${kit}:${variant % PLACE_VARIANTS}`, { gain: 0.58, rate: (1 - weight * 0.14) * (0.98 + Math.random() * 0.04), priority: 3 });
  }
  /**
   * シャラン: バーチャイム（マークツリー）を指で 2 回なでたような、尖った高い金属の「シャン、シャン」。
   * 高い音が駆け上がるたびに「シャッ」とはじけ、最後のバーが長く響く。
   * 最後のバーの高さは shalanTop（ゴールの音と同じ音階。連鎖が進むほど高い）。size = 大きさ（1 = 全消し・新記録の見せ場、
   * ふだんのラインは 0.65 ほど）、at = 何秒後か
   */
  shalan(chain = 1, { size = 1, at = 0 } = {}) {
    if (!at && !this.allow('shalan', 0.1)) return;
    this.playBuffer(`chime:${this.kit}:${shalanTop(chain)}`, { gain: SHALAN_GAIN * size, rate: 0.99 + Math.random() * 0.02, at, priority: 1 });
  }
  /**
   * 鈴（synth.js の bellBuffer）。freq = tone と同じ高さの指定（bellPitch が、LOWER を掛けて oct 段上げ、鈴の音域へ収める）/
   * ring = 鈴の自然な減衰（基本が 60dB 消えるまで 0.3〜0.7 秒）に重ねる、さらなる減衰の 60dB の秒数（短いほど速く切れる）/ gain = 大きさ。
   * 正弦波の「ピン」より厚みがあり、スマホの小さなスピーカーでも基本以外の部分音で聞こえる
   */
  bell(freq, { oct = 0, ...opts } = {}) { this.bellAt(bellPitch(freq, oct), opts); }
  /** 鈴を、鈴の音域に収まった高さ f（Hz）そのままで鳴らす（和音で、根音からの比で重ねるとき） */
  bellAt(f, { gain = 0.3, ring = 0.5, at = 0, priority = 1 } = {}) {
    const k = Math.max(0, Math.min(BELL_STEPS - 1, Math.round(4 * Math.log2(f / BELL_BASE))));
    this.playBuffer(`note:${this.kit}:${k}`, { gain, rate: f / (BELL_BASE * 2 ** (k / 4)), at, ring, priority });
  }
  /** 穴にぴったりはまる場所に入った（カチッ）・ぴったり置いた（カチッ + 上がる2音） */
  fitHover()    { if (!this.allow('fitHover', 0.08)) return;
                  this.tone(1318.5, { dur: 0.035, type: 'triangle', gain: 0.22 }); this.vibe(8); }
  fit()         { this.tone(1046.5, { dur: 0.04, type: 'triangle', gain: 0.4 });
                  [0, 4].forEach((k, i) => this.bell(note(k, 1046.5), { gain: BELL.fit, ring: 0.45, at: 0.06 + i * 0.07 })); this.vibe(14); }
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
  // ゴールに入った: 鈴（根音・5 度・（4 連鎖から）3 度。オクターブ上は鈴の部分音に入っている）+ 低い着地音
  goal(chain = 1, count = 1) {
    const root = bellPitch(note(chain - 1, 330), 1), up = (r) => (root * r < BELL_TOP ? root * r : root * r / 2);
    const boost = 0.77 + 0.064 * Math.min(chain - 1, 9);                  // 連鎖が進むほど、少しずつ大きく（前の音もそうだった）
    this.bellAt(root, { gain: BELL.goal * boost, ring: 1.1, priority: 2 });
    this.bellAt(up(1.5), { gain: BELL.goal * boost * 0.42, ring: 0.8, at: 0.025, priority: 2 });
    this.tone(190, { dur: 0.075, gain: 0.22, slide: 0.6, priority: 2 });
    if (chain >= 4 || count > 1) this.bellAt(up(1.25), { gain: BELL.goal * boost * 0.28, ring: 0.45, at: 0.05 });
    this.vibe(count > 1 ? [12, 24, 18] : 14);
  }
  push(chain)   { if (this.allow('push', 0.06)) this.tone(140 + Math.min(chain, 10) * 9, { dur: 0.09, type: 'triangle', gain: 0.24, slide: 1.3 }); }
  rows(n, chain){ for (let k = 0; k < 3 + n; k++) this.tone(note(chain + k), { dur: 0.16, gain: 0.35, at: k * 0.045 });
                  this.vibe([0, 20, 30, 30]); }
  // 連続発動: 上がっていく和音＋キラキラ
  combo(n)      { const f = note(n - 2, 262);
                  [1, 1.25, 1.5].forEach((m, k) => this.bell(f * m, { gain: BELL.combo, ring: 0.6, oct: 1, at: 0.025 + k * 0.035 }));
                  this.vibe([0, 18, 30, 26]); }
  // 褒め言葉: 段階が上がるほど和音が厚く、高く
  praise(tier)  { const base = [262, 294, 330, 392, 440][Math.max(0, Math.min(4, tier - 1))];
                  const chord = [1, 1.25, 1.5, 2, 2.5].slice(0, 2 + tier);
                  chord.forEach((m, k) => this.bell(base * m, { gain: BELL.praise * (0.7 + 0.085 * (tier - 1)) / Math.sqrt(chord.length), ring: 0.7 + tier * 0.08, oct: 1, at: k * 0.035 }));
                  if (tier >= 4) this.tone(98, { dur: 0.22, gain: 0.35, slide: 0.65 });
                  this.vibe(tier >= 4 ? [0, 30, 40, 50] : 16); }
  // 新記録: ファンファーレ
  fanfare()     { [0, 2, 4, 5].forEach((k, i) => this.bell(note(k + 2, 523.25), { gain: BELL.fanfare, ring: i === 3 ? 1.4 : 0.6, at: i * 0.1 }));
                  this.tone(note(7, 523.25), { dur: 0.6, gain: 0.12, at: 0.3 }); this.shalan(5, { at: 0.08 }); this.vibe([0, 30, 40, 30, 40, 80]); }
  // 全消し専用: 短い立ち上がりと、盤面へ色が広がる間の上昇フレーズ。
  allClear() {
    this.noise({ dur: 0.32, gain: 0.23, from: 600, to: 2400, attack: 0.025, priority: 2 });
    this.tone(130.81, { dur: 0.3, gain: 0.45, slide: 0.6, priority: 2 });
    [0, 2, 4, 5, 7, 9].forEach((k, i) => this.bell(note(k, 262), { gain: BELL.run, ring: i === 5 ? 1.4 : 0.5, oct: 1, at: 0.04 + i * 0.065, priority: 2 }));
    [262, 330, 392].forEach((f) => this.tone(f, { dur: 0.65, gain: 0.11, at: 0.4, priority: 2 }));
    this.shalan(1, { at: 0.06 }); this.shalan(4, { size: 0.85, at: 0.5 });          // シャラン、シャラン
    this.vibe([22, 35, 35]);
  }
  shatter() { this.noise({ dur: 0.11, gain: 0.16, from: 2600, to: 1000, attack: 0.002 });
              [784, 988, 1175].forEach((f, i) => this.bell(f, { gain: BELL.shatter, ring: 0.4, at: i * 0.038, priority: 0 })); }
  refill()      { [0, 1, 2].forEach((k) => this.bell(note(k, 784), { gain: BELL.refill, ring: 0.45, at: k * 0.05 })); }
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

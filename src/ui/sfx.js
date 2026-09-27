/** 効果音と振動。WebAudio のみ（アセット不要）。初回タップで有効化。 */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];      // ペンタトニック（連鎖で上がっていく）
/** 高すぎる音は大音量で耳に刺さるので、全体を少し低くし（LOWER 半音）、上限も設ける（MAX_HZ） */
const LOWER = Math.pow(2, -3 / 12), MAX_HZ = 1400;
const note = (i, base = 523.25) => base * Math.pow(2, PENTA[Math.min(i, 8)] / 12);

export class Sfx {
  constructor() { this.ctx = null; this.enabled = true; }
  unlock() {
    // iOS Safari は 'suspended' だけでなく、コントロールセンターを開く・画面収録・着信などで
    // 独自の 'interrupted' にもなる。running 以外なら戻す
    if (this.ctx) { if (this.ctx.state !== 'running') this.ctx.resume().catch(() => {}); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.25;
    // 耳心地のため、高い倍音を少し丸め、音が重なって大きくなったときも割れないよう軽く抑える
    this.soft = this.ctx.createBiquadFilter();
    this.soft.type = 'lowpass'; this.soft.frequency.value = 3200; this.soft.Q.value = 0.5;
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -18; comp.knee.value = 12; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    this.master.connect(this.soft); this.soft.connect(comp); comp.connect(this.ctx.destination);
  }
  tone(freq, { dur = 0.1, type = 'sine', gain = 0.6, at = 0, slide = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + at;
    freq = Math.min(freq * LOWER, MAX_HZ);
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(freq * slide, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.03);
  }
  vibe(p) { if (this.enabled) try { navigator.vibrate?.(p); } catch {} }

  pick()        { this.tone(660, { dur: 0.06, gain: 0.3 }); this.vibe(6); }
  // はまる音: 低い「コトッ」＋澄んだ高音の2音
  place()       { this.tone(330, { dur: 0.08, type: 'triangle', gain: 0.75, slide: 0.55 });
                  this.tone(988, { dur: 0.09, gain: 0.22, at: 0.02 });
                  this.tone(1319, { dur: 0.12, gain: 0.14, at: 0.06 }); this.vibe(12); }
  /** 穴にぴったりはまる場所に入った（カチッ）・ぴったり置いた（カチッ + 上がる2音） */
  fitHover()    { this.tone(1318.5, { dur: 0.035, type: 'triangle', gain: 0.22 }); this.vibe(8); }
  fit()         { this.tone(1046.5, { dur: 0.04, type: 'triangle', gain: 0.4 });
                  [0, 4].forEach((k, i) => this.tone(note(k, 1046.5), { dur: 0.09, gain: 0.22, type: 'sine', at: 0.06 + i * 0.07 })); this.vibe(14); }
  hover()       { this.tone(1760, { dur: 0.025, gain: 0.05 }); }
  // 消える場所に入った: 連鎖が多いほど高く上がっていくキラッという音（期待）
  anticipate(chain) { const f = note(Math.min(chain, 6) + 1, 659);
                  this.tone(f, { dur: 0.12, gain: 0.16, type: 'triangle', slide: 1.12 });
                  this.tone(f * 1.5, { dur: 0.16, gain: 0.08, at: 0.05 }); this.vibe(8); }
  invalid()     { this.tone(180, { dur: 0.12, type: 'square', gain: 0.15, slide: 0.8 }); }
  // 発動: 低い衝撃音＋上へ抜けるシュッという音
  sink()        { this.tone(300, { dur: 0.16, type: 'sine', gain: 0.3, slide: 0.5 });
                  this.tone(110, { dur: 0.18, type: 'sine', gain: 0.55, slide: 0.45 });
                  this.tone(700, { dur: 0.14, type: 'triangle', gain: 0.05, slide: 1.8 }); this.vibe(14); }
  step(i)       { this.tone(note(i, 392), { dur: 0.05, type: 'triangle', gain: 0.25 }); }
  goal(chain)   { const f = note(chain + 1);
                  this.tone(f, { dur: 0.18, gain: 0.5 });
                  this.tone(f * 1.5, { dur: 0.22, gain: 0.3, at: 0.05 });
                  this.vibe([0, 16, 20, 24]); }
  push(chain)   { this.tone(140 + chain * 12, { dur: 0.14, type: 'triangle', gain: 0.5, slide: 1.6 }); this.vibe(20); }
  rows(n, chain){ for (let k = 0; k < 3 + n; k++) this.tone(note(chain + k), { dur: 0.16, gain: 0.35, at: k * 0.045 });
                  this.vibe([0, 20, 30, 30]); }
  // 連続発動: 上がっていく和音＋キラキラ
  combo(n)      { const f = note(Math.min(n, 8), 523.25);
                  [1, 1.25, 1.5, 2].forEach((m, k) => this.tone(f * m, { dur: 0.22, gain: 0.26, type: 'triangle', at: k * 0.04 }));
                  this.tone(f * 2, { dur: 0.3, gain: 0.06, at: 0.16 });
                  this.vibe([0, 18, 30, 26]); }
  // 褒め言葉: 段階が上がるほど和音が厚く、高く
  praise(tier)  { const base = 392 * Math.pow(2, (tier - 1) / 6);
                  const chord = [1, 1.26, 1.5, 2, 2.52, 3].slice(0, 2 + tier);
                  chord.forEach((m, k) => this.tone(base * m, { dur: 0.35, gain: 0.2, type: k % 2 ? 'sine' : 'triangle', at: k * 0.03 }));
                  if (tier >= 3) this.tone(base * 2, { dur: 0.5, gain: 0.06, type: 'sine', at: 0.12, slide: 1.02 });
                  if (tier >= 4) this.tone(80, { dur: 0.35, type: 'sine', gain: 0.6, slide: 0.5 });
                  this.vibe(tier >= 4 ? [0, 30, 40, 50] : 16); }
  // 新記録: ファンファーレ
  fanfare()     { [0, 2, 4, 5].forEach((k, i) => this.tone(note(k + 2, 523.25), { dur: i === 3 ? 0.5 : 0.12, gain: 0.3, type: 'triangle', at: i * 0.1 }));
                  this.tone(note(7, 523.25), { dur: 0.6, gain: 0.12, at: 0.3 }); this.vibe([0, 30, 40, 30, 40, 80]); }
  refill()      { [0, 1, 2].forEach((k) => this.tone(note(k, 784), { dur: 0.07, gain: 0.18, at: k * 0.05 })); }
  /** 短いざらざらした音（波・しぶき）。ノイズを帯域フィルタに通す */
  noise({ dur = 0.6, gain = 0.3, from = 400, to = 1400, q = 0.8, at = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
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
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.3); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g); g.connect(this.master);
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
  settle(i = 0) { this.tone(note(i, 784), { dur: 0.05, gain: 0.12, type: 'triangle' }); }
  // ゲームオーバー: やわらかい三角波・正弦波の和音が、ゆっくり下がって消える（耳障りなのこぎり波は使わない）
  over()        { [392, 311.1, 261.6].forEach((f, i) => this.tone(f, { dur: 0.9, type: i ? 'sine' : 'triangle', gain: 0.22, slide: 0.7, at: i * 0.12 }));
                  this.tone(196, { dur: 1.1, type: 'sine', gain: 0.25, slide: 0.8, at: 0.3 }); this.vibe([0, 60, 50, 140]); }
}

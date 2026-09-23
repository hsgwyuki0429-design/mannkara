/** 効果音と振動。WebAudio のみ（アセット不要）。初回タップで有効化。 */
const PENTA = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];      // ペンタトニック（連鎖で上がっていく）
const note = (i, base = 523.25) => base * Math.pow(2, PENTA[Math.min(i, PENTA.length - 1)] / 12);

export class Sfx {
  constructor() { this.ctx = null; this.enabled = true; }
  unlock() {
    if (this.ctx) { if (this.ctx.state === 'suspended') this.ctx.resume(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.25;
    this.master.connect(this.ctx.destination);
  }
  tone(freq, { dur = 0.1, type = 'sine', gain = 0.6, at = 0, slide = 0 } = {}) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime + at;
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
  hover()       { this.tone(1760, { dur: 0.025, gain: 0.05 }); }
  // 消える場所に入った: 連鎖が多いほど高く上がっていくキラッという音（期待）
  anticipate(chain) { const f = note(Math.min(chain, 6) + 1, 659);
                  this.tone(f, { dur: 0.12, gain: 0.16, type: 'triangle', slide: 1.12 });
                  this.tone(f * 1.5, { dur: 0.16, gain: 0.08, at: 0.05 }); this.vibe(8); }
  invalid()     { this.tone(180, { dur: 0.12, type: 'square', gain: 0.15, slide: 0.8 }); }
  // 発動: 低い衝撃音＋上へ抜けるシュッという音
  sink()        { this.tone(300, { dur: 0.16, type: 'sine', gain: 0.3, slide: 0.5 });
                  this.tone(110, { dur: 0.18, type: 'sine', gain: 0.55, slide: 0.45 });
                  this.tone(700, { dur: 0.14, type: 'sawtooth', gain: 0.05, slide: 2.4 }); this.vibe(14); }
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
                  this.tone(f * 4, { dur: 0.3, gain: 0.08, at: 0.16 });
                  this.vibe([0, 18, 30, 26]); }
  // 褒め言葉: 段階が上がるほど和音が厚く、高く
  praise(tier)  { const base = 392 * Math.pow(2, (tier - 1) / 6);
                  const chord = [1, 1.26, 1.5, 2, 2.52, 3].slice(0, 2 + tier);
                  chord.forEach((m, k) => this.tone(base * m, { dur: 0.35, gain: 0.2, type: k % 2 ? 'sine' : 'triangle', at: k * 0.03 }));
                  if (tier >= 3) this.tone(base * 4, { dur: 0.5, gain: 0.07, type: 'sine', at: 0.12, slide: 1.02 });
                  if (tier >= 4) this.tone(80, { dur: 0.35, type: 'sine', gain: 0.6, slide: 0.5 });
                  this.vibe(tier >= 4 ? [0, 30, 40, 50] : 16); }
  // 新記録: ファンファーレ
  fanfare()     { [0, 2, 4, 5].forEach((k, i) => this.tone(note(k + 2, 523.25), { dur: i === 3 ? 0.5 : 0.12, gain: 0.3, type: 'triangle', at: i * 0.1 }));
                  this.tone(note(7, 523.25), { dur: 0.6, gain: 0.12, at: 0.3 }); this.vibe([0, 30, 40, 30, 40, 80]); }
  refill()      { [0, 1, 2].forEach((k) => this.tone(note(k, 784), { dur: 0.07, gain: 0.18, at: k * 0.05 })); }
  over()        { this.tone(392, { dur: 0.7, type: 'sawtooth', gain: 0.25, slide: 0.25 }); this.vibe([0, 60, 50, 140]); }
}

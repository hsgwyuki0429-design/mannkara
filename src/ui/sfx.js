/** 効果音と振動。WebAudio のみ（アセット不要）。初回タップで有効化される。 */
export class Sfx {
  constructor() { this.ctx = null; this.enabled = true; }
  unlock() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    this.master = this.ctx.createGain();
    this.master.gain.value = 0.22;
    this.master.connect(this.ctx.destination);
  }
  tone(freq, dur = 0.09, type = 'triangle', gain = 1, detune = 0) {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); o.detune.value = detune;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  sweep(from, to, dur = 0.25, type = 'sine') {
    if (!this.enabled || !this.ctx) return;
    const t = this.ctx.currentTime;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur);
    g.gain.setValueAtTime(0.5, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this.master);
    o.start(t); o.stop(t + dur + 0.02);
  }
  vibe(pattern) {
    if (!this.enabled) return;
    try { navigator.vibrate?.(pattern); } catch {}
  }
  pick()          { this.tone(520, 0.05, 'sine', 0.5); }
  land()          { this.tone(160, 0.11, 'square', 0.5); this.vibe(12); }
  step(i = 0)     { this.tone(420 + i * 55, 0.05, 'triangle', 0.35); }
  goal(chain = 1) { this.sweep(520 + chain * 90, 1500 + chain * 140, 0.26); this.vibe([0, 18, 26, 30]); }
  chain(n)        { this.tone(500 + n * 120, 0.16, 'sine', 0.6); }
  over()          { this.sweep(420, 70, 0.7, 'sawtooth'); this.vibe([0, 60, 50, 120]); }
}

/** 背景だけの色相を変える。各色のグラデーションは固定し、opacity だけで混ぜる。 */
const PALETTES = [
  ['#123f4c', '#247884'],   // 深い青緑
  ['#2451c4', '#2e60d6'],   // これまでの青
  ['#39265f', '#704797'],   // 紫
  ['#632e50', '#a6507a'],   // ローズ
  ['#694132', '#a76e49'],   // 琥珀
  ['#254b43', '#4b8266'],   // 緑
];
const COMBO_COLORS = [0, 1, 2, 3, 4, 5];

export class Background {
  constructor() {
    this.el = document.createElement('div');
    this.el.id = 'ambient';
    this.el.setAttribute('aria-hidden', 'true');
    this.layers = PALETTES.map(([low, high]) => {
      const layer = document.createElement('i');
      layer.className = 'ambient-layer';
      layer.style.setProperty('--ambient-low', low);
      layer.style.setProperty('--ambient-high', high);
      this.el.append(layer);
      return layer;
    });
    document.body.prepend(this.el);
    this.calm = 0;
    this.moves = 0;
    this.holdUntil = 0;
    this.set(0, 0);
  }

  set(index, duration = 1800) {
    this.index = index;
    // 動きを減らす設定では、長い色の移動や素早い切り替えを避ける。
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const [i, layer] of this.layers.entries()) {
      layer.style.transitionDuration = `${reduced ? 250 : duration}ms`;
      layer.style.opacity = i === index ? '1' : '0';
    }
  }

  turn(turn) {
    this.moves++;
    if (performance.now() < this.holdUntil) return;
    if (turn.steps.length && turn.streak >= 2) {
      const index = COMBO_COLORS[(turn.streak - 2) % COMBO_COLORS.length];
      this.set(index, turn.streak % 5 === 0 ? 220 : 1400);
    } else {
      if (this.moves % 6 === 0) this.calm = (this.calm + 1) % PALETTES.length;
      if (this.index !== this.calm) this.set(this.calm, 2400);
    }
  }

  chain(tier) {
    if (tier < 3 || performance.now() < this.holdUntil) return;
    this.set(tier >= 5 ? 4 : tier >= 4 ? 3 : 2, 700);
  }

  celebrate(kind) {
    if (kind === 'best' && performance.now() < this.holdUntil) return;
    this.holdUntil = performance.now() + 1600;
    this.set(kind === 'clear' ? 5 : 4, kind === 'clear' ? 220 : 450);
  }

  settle() {
    this.holdUntil = 0;
    this.set(this.calm, 1800);
  }

  reset() {
    this.moves = 0;
    this.settle();
  }
}

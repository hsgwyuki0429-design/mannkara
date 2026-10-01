/** 背景だけの色相を変える。各色のグラデーションは固定し、opacity だけで混ぜる。 */
const PALETTES = [
  ['#2451c4', '#2e60d6'],   // 最初はこれまでの青
  ['#74adbc', '#c8ecea'],   // パステルシアン
  ['#7fab9d', '#cceedd'],   // ミント
  ['#88ad89', '#d4ebd4'],   // ソフトグリーン
  ['#a3ad78', '#deedc5'],   // ライム
  ['#b8aa72', '#f4edc3'],   // バターイエロー
  ['#c39b7d', '#f5d8bc'],   // ピーチ
  ['#c38c89', '#f3cccc'],   // コーラル
  ['#ba8fa9', '#f1d0e2'],   // パステルピンク
  ['#a48fb9', '#eed3f1'],   // ライラック
  ['#9291bb', '#dfd5f2'],   // ラベンダー
  ['#8b9fbd', '#d6dcf4'],   // ペリウィンクル
  ['#83a6ce', '#c8e2f4'],   // スカイブルー
];
// 色相環に沿って隣の色へ。1ゲーム中にすべてを見せるために急がせない。
const HUE_PATH = [0, 12, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
const COMBO_COLORS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 0];

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
    const ms = reduced ? 250 : duration;
    for (const [i, layer] of this.layers.entries()) {
      layer.style.transitionDuration = `${ms}ms`;
      layer.style.opacity = i === index ? '1' : '0';
    }
    // 明るい背景では文字と操作アイコンを濃色に。色が混ざる途中で切り替える。
    clearTimeout(this.themeTimer);
    const light = index !== 0;
    const apply = () => document.body.classList.toggle('background-light', light);
    if (duration === 0) apply();
    else this.themeTimer = setTimeout(apply, ms * .45);
  }

  turn(turn) {
    this.moves++;
    if (performance.now() < this.holdUntil) return;
    if (turn.steps.length && turn.streak >= 2) {
      const index = COMBO_COLORS[(turn.streak - 2) % COMBO_COLORS.length];
      this.set(index, turn.streak % 5 === 0 ? 220 : 1400);
    } else {
      if (this.moves % 6 === 0) this.calm = HUE_PATH[(HUE_PATH.indexOf(this.calm) + 1) % HUE_PATH.length];
      if (this.index !== this.calm) this.set(this.calm, 2400);
    }
  }

  chain(tier) {
    if (tier < 3 || performance.now() < this.holdUntil) return;
    this.set(tier >= 5 ? 5 : tier >= 4 ? 8 : 10, 700);
  }

  celebrate(kind) {
    if (kind === 'best' && performance.now() < this.holdUntil) return;
    this.holdUntil = performance.now() + 1600;
    this.set(kind === 'clear' ? 2 : 5, kind === 'clear' ? 220 : 450);
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

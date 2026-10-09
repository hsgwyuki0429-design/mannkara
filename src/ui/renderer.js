export const ROTATION = 225; // deg。左上の直角が真下に来る
import { SIZE, isInside, ANIM, lineCells, CHAIN_SPEED_GROWTH, CHAIN_SPEED_MAX, TURN_PLAY_BUDGET } from '../core/constants.js?v=202610091259';
import { Shards } from './shards.js?v=202610091259';
import { Sparkles } from './sparkles.js?v=202610091259';
import { FxCanvas, softwareRendering } from './fx2d.js?v=202610091259';
import { Rims } from './rims.js?v=202610091259';
import { colorOf } from './palette.js?v=202610091259';
import { PLATE_SETS } from './ambient.js?v=202610091259';
import { DROP_WARN_MS, DROP_GAP_MS, DROP_FALL_MS, DROP_HOLD_MS } from '../core/battle.js?v=202610091259';
import { glassElement, glassGroups } from './glass.js?v=202610091259';

/** 連鎖数ごとの褒め言葉（段階が上がるほど派手な色）。[この連鎖から, 言葉, 段階] */
export const PRAISE = [[8, 'Unbelievable!', 5], [6, 'Amazing!', 4], [4, 'Excellent!', 3], [3, 'Great!', 2], [2, 'Good!', 1]];
/**
 * 1ターンぶんの各連鎖の再生速度。連鎖が進むほど指数的に速くし、
 * それでも合計が TURN_PLAY_BUDGET を超えるなら全体をまとめて速めて収める（自分の盤面と、対戦の相手の盤面で同じ）
 */
export function planSpeeds(steps) {
  const base = steps.map((s) => Math.min(CHAIN_SPEED_MAX, Math.pow(CHAIN_SPEED_GROWTH, s.chain - 1)));
  const cost = (s) => Renderer.stepCells(s) * ANIM.step + ANIM.betweenChains;
  const total = steps.reduce((a, s, i) => a + cost(s) / base[i], 0);
  const k = Math.max(1, total / TURN_PLAY_BUDGET);
  return base.map((v) => v * k);
}
/** 1 ターンの再生の長さ（速さ 1 のとき。ms）。planSpeeds で速めたぶんも入れる */
export function turnPlayCost(turn) {
  const sp = planSpeeds(turn.steps);
  return turn.steps.reduce((a, s, i) => a + (Renderer.stepCells(s) * ANIM.step + ANIM.betweenChains) / sp[i], turn.steps.length ? ANIM.charge : 0);
}

/** 盤面全体を画面の縦方向にだけ少し伸ばす率（斜辺の中心線が基準） */
const STRETCH_Y = 1.04;
/** 盤面の外（通路・ゴール）を画面上で斜辺側へ縮める率（縦に伸ばした後で 0.86 倍になるように） */
const LANE_SQUASH = 0.86 / STRETCH_Y;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * CSS アニメーションを最初から再生し直すため、要素を中身のない複製に差し替える。
 * （クラスを外して offsetWidth を読む方法は毎回ページ全体の強制レイアウトになり、連鎖中のカクつきの原因になる）
 */
const fresh = (el) => { const n = el.cloneNode(false); el.replaceWith(n); return n; };
/**
 * 画面いっぱいの薄い層（ピンチの縁・コンボの光）の出し入れ。opacity が 0 でも、置いてあるだけで画面1枚ぶんの層が毎フレームの合成に残るので、
 * 出ていない間は画面から外す（hidden）。出るときは外れていた層をいったん opacity 0 で描かせてから、ふわっと出す。消えるときは薄くなってから外す
 */
const FADE_MS = 600;
function setVeil(el, level) {
  const on = level > 0;
  clearTimeout(el.__hide);
  if (on) {
    if (el.hidden) { el.hidden = false; void el.offsetWidth; }
    el.style.opacity = Math.min(1, level);
  } else {
    el.style.opacity = 0;
    if (!el.hidden) el.__hide = setTimeout(() => { el.hidden = true; }, FADE_MS + 100);
  }
  el.classList.toggle('off', !on);
}
/** Web Animations の keyframes に、CSS の animation-timing-function と同じく区間ごとの easing を付ける */
const eased = (frames, easing) => frames.map((f, i) => (i < frames.length - 1 ? { easing, ...f } : f));
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 2.2);
/** easeInOut の逆関数（進んだ割合 y になる時刻の割合） */
const easeInOutInv = (y) => (y < 0.5 ? Math.sqrt(y / 2) : 1 - Math.sqrt((1 - y) * 2) / 2);
/** ブロックと同じ7色 */
const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
/** コンボ中は背景の色相に合わせた控えめなグラデーションだけを重ねる（色は ambient.js が --amb-glow で渡す）。 */
const FEVER_HUES = 1;
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
/** 色名 → 光のにじみの色（ブロックの明るい面の色。ラインの枠・通り過ぎた跡の光に使う。--g に渡す） */
const glowOf = (name, a = 0.85) => {
  const h = colorOf(name).hi, v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 255);
  return `rgba(${v.join(',')},${a})`;
};

/**
 * 描画とアニメーションだけを担当（ルールは持たない）。
 * 画面座標 (x, r): x=0 左端…7 右端, r=0 上端…7 下端。
 * 縦列は r=8 の行（盤面の下）を右へ、横列は x=8 の列（盤面の右）を下へ流れ、(8,8) のゴールへ入る。
 */
/** ホワイト用: 辺が接している同じ色のマスの間を、すき間なくつなぐ（cells = [{x, y, color, el}]。クラス j-l/j-r/j-t/j-b を付け直す） */
export function markJoins(cells) {
  const at = new Map(cells.map((c) => [c.x + ',' + c.y, c]));
  for (const c of cells) {
    const same = (dx, dy) => at.get((c.x + dx) + ',' + (c.y + dy))?.color === c.color;
    c.el.classList.toggle('j-l', same(-1, 0)); c.el.classList.toggle('j-r', same(1, 0));
    const l = same(-1, 0), r = same(1, 0), t = same(0, -1), b = same(0, 1);
    c.el.classList.toggle('j-t', t); c.el.classList.toggle('j-b', b);
    // 2 辺でつながっていて斜めが違う色・空きの角（L 字の内側）は、はみ出した角を切る
    c.el.classList.toggle('n-tl', l && t && !same(-1, -1)); c.el.classList.toggle('n-tr', r && t && !same(1, -1));
    c.el.classList.toggle('n-br', r && b && !same(1, 1)); c.el.classList.toggle('n-bl', l && b && !same(-1, 1));
  }
}

export class Renderer {
  /**
   * root を渡すと、その入れ物（.stage と同じ役目）の中に、自分の盤面とまったく同じ作りの盤面を作る（対戦の相手の盤面。id は付けない・
   * 画面全体の演出（背景の光・ピンチの縁）と --cell は入れ物の中だけ）。渡さなければ index.html の自分の盤面
   */
  constructor(sfx, { root = null } = {}) {
    this.sfx = sfx;
    this.root = root;
    const get = (id) => (root ? root.querySelector(`[data-part="${id}"]`) : document.getElementById(id));
    // 必要な要素が HTML に無くても（古い HTML がキャッシュされている等）自前で作る
    const need = (id, cls, parent = 'playfield') => {
      if (get(id)) return;
      const d = document.createElement('div');
      if (root) d.dataset.part = id; else d.id = id;
      d.className = cls;
      (parent ? get(parent) : root).appendChild(d);
    };
    if (root) need('playfield', 'playfield', null);
    ['wellLayer', 'hiLayer', 'blockLayer', 'hintLayer', 'ghostLayer', 'fxLayer'].forEach((id) => need(id, 'layer'));
    need('lane', 'lane'); need('laneRow', 'lane'); need('goal', 'goal'); need('pop', 'pop');
    if (root && !get('goal').firstChild) get('goal').innerHTML = '<span>GOAL</span>';
    this.pf = get('playfield');
    this.wellLayer = get('wellLayer');
    this.wellLayer.classList.add('well-layer');
    // 盤面の土台（マスの下の土台とくぼみ）は、背景の色に合わせて色が変わる。色の違う層を重ねて opacity だけで切り替える（ambient.bindBoard）ので、
    // 同じ土台の絵の層をいくつか持つ。0 番だけが最初から見えている（今の青）
    this.plateSets = Array.from({ length: PLATE_SETS }, (_, i) => {
      const d = document.createElement('div');
      d.className = 'well-set';
      d.style.display = i ? 'none' : 'block';
      this.wellLayer.appendChild(d);
      return d;
    });
    this.hiLayer = get('hiLayer');
    this.blockLayer = get('blockLayer');
    this.glassLayer = document.createElement('div');
    this.glassLayer.className = 'layer glass-blocks';
    this.blockLayer.after(this.glassLayer);
    this.ghostLayer = get('ghostLayer');
    this.hintLayer = get('hintLayer');
    this.fxLayer = get('fxLayer');
    // 消える列のハイライトは既存ブロックの上に重ねる（下にあると隠れて見えない）
    this.glassLayer.after(this.hiLayer);
    // マスに色が満ちる演出（空いたマスの中に塗るので、ブロックより下・マスより上）
    this.tintLayer = document.createElement('div');
    this.tintLayer.className = 'layer';
    this.wellLayer.after(this.tintLayer);
    // チュートリアルで動きを説明するときの印（ブロックより上）
    this.annoLayer = document.createElement('div');
    this.annoLayer.className = 'layer';
    this.hintLayer.after(this.annoLayer);
    this.marks = [];
    this.lane = get('lane');
    this.laneRow = get('laneRow');
    this.goal = get('goal');
    this.pop = get('pop');
    // 盤面は直角が下に来るよう 225° 回転して表示する。回転しない外枠 wrap に入れ、
    // 文字（連鎖表示）は wrap 側に置いて回転させない
    this.wrap = get('rotWrap');
    if (!this.wrap) {
      this.wrap = document.createElement('div');
      if (root) this.wrap.dataset.part = 'rotWrap'; else this.wrap.id = 'rotWrap';
      this.wrap.className = 'rot-wrap';
      this.pf.parentNode.insertBefore(this.wrap, this.pf);
      this.wrap.appendChild(this.pf);
    }
    this.wrap.appendChild(this.pop);
    // 回転しない演出用のレイヤー（浮かぶ得点など、画面の上下が必要なもの）
    this.fx2 = document.createElement('div');
    this.fx2.className = 'layer fx2';
    this.wrap.appendChild(this.fx2);
    // 小さな演出（星・宝石のかけら・ラインの光の跡）は、粒ごとに要素を作らず、canvas に色ごとに 1 回だけ描いた小さな絵を貼って動かす
    // （要素を動かすと、ブロックを動かす間は動いている数だけ毎フレームの仕事が増える。fx2d.js）。何も出ていない間は canvas を画面から外す
    this.fxTop = new FxCanvas(this.fx2);                      // 星・かけら（ブロックの前）
    this.shardLayer = new Shards(this.fxTop);                 // ゴールから飛び散る宝石のかけら
    this.sparkLayer = new Sparkles(this.fxTop);               // ラインの枠・通り過ぎた跡・ゴールで、またたく星
    this.rimFx = new FxCanvas(this.fxLayer);   // ラインの光の跡（盤面の座標。重なりは以前の光る要素と同じ: 動いているブロックの後ろ）
    this.rims = new Rims(this.rimFx);
    this.comboPop = document.createElement('div');
    this.comboPop.className = 'combo-pop';
    this.wrap.appendChild(this.comboPop);
    // おじゃまが落ちてくるときの、画面の縁の赤い光（自分の盤面は画面全体、相手の盤面はその枠の中）
    this.ojFlash = document.createElement('div');
    this.ojFlash.className = 'oj-flash';
    (root ?? document.body).appendChild(this.ojFlash);
    // ピンチのときの画面の縁と、コンボが続くほど明るくなる背景
    // （相手の盤面は画面に出さない入れ物。背景の光・ピンチの縁は自分の盤面だけ）
    this.dangerEl = root ? document.createElement('div') : document.getElementById('danger') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'danger' }));
    this.feverEl = root ? document.createElement('div') : document.getElementById('fever') || document.body.insertBefore(Object.assign(document.createElement('div'), { id: 'fever' }), document.body.firstChild);
    // 背景の色の層（色ごとに1枚。opacity だけを動かして色を入れ替える）
    if (!this.feverEl.querySelector('.fv')) {
      for (let i = 0; i < FEVER_HUES; i++) this.feverEl.appendChild(Object.assign(document.createElement('i'), { className: `fv fv${i}` }));
    }
    this.feverEl.hidden = this.dangerEl.hidden = true;        // 使うまでは画面から外しておく（setVeil）
    const goalText = this.goal.querySelector('span');
    if (goalText) goalText.className = 'upright';
    // ゴールの中の面（入ったブロックの色で満ちる）
    this.goalFill = document.createElement('div');
    this.goalFill.className = 'goal-fill';
    this.goal.prepend(this.goalFill);
    this.frameMs = 16.7;      // ブロックが動いている間の1フレームの時間（なめらかに平均。演出の量を決める）
    // 早送り: 再生中に次のピースが置かれたら、残りの再生を演出なしで一気に最後まで進める
    // （ルールは置いた瞬間に確定しているので、表示が遅れたままだと新しいピースが古いブロックに重なって見える）
    this.rush = false;
    this.waiters = new Set();  // wait() の途中のもの（早送り・リスタートしたらすぐ終わらせる）
    this.timeScale = 1;        // 再生の速さ（一時停止中は 0、再生中にピースを持ち上げたら追いつくよう速く）
    this.gen = 0;              // リスタートするたびに増やす（古いゲームの再生を新しい盤面に残さない）
    this.fxTimers = new Set();
    this.fxPaused = false;
    this.pausedAnimations = new Set();
    this.celebration = 0;
    this.els = new Map();     // blockId -> element
    this.manual = new Set();  // 手動制御中
    // 3D の盤面（cube3d.js）。選ばれている間だけ入る。ブロックの位置はここの要素（el.__pos）から毎フレーム読み、
    // 着地・溜め・ゴール・仮置き・マスに満ちる色・全消しは、ここから知らせる
    this.view3d = null;
    this.cell = 40;
    this.layout();
    window.addEventListener('resize', () => this.layout());
    // Split View・ブラウザのバーなどでステージだけが変わったときも収め直す。
    this.layoutObserver = new ResizeObserver(() => this.layout());
    this.layoutObserver.observe(this.wrap.parentElement);
  }

  /* ---------- レイアウト ---------- */
  static EXT_UP = 8.99;                                       // 斜辺の中心線から上下に見えている範囲（h 単位。上はゴールまで、下は直角の先まで）
  static EXT_DOWN = 8.55;
  static spanW = 11.62;                                       // 左右の番号を含めた横幅（マス単位）
  static spanH = (8.99 + 8.55) / Math.SQRT2;                  // 縦幅（マス単位）
  layout() {
    const stage = this.wrap.parentElement.getBoundingClientRect();
    const sw = stage.width || window.innerWidth;
    const sh = stage.height || window.innerHeight - 380;
    // 盤面をできるだけ大きく: 見えている範囲（左右の番号「8」の外側まで、ゴール上端〜直角の先端まで）が
    // ステージにぴったり収まる最大のマスの大きさにする
    const { EXT_UP, EXT_DOWN, spanW: SPAN_W, spanH: SPAN_H } = Renderer;
    const cell = Math.max(1, Math.floor(Math.min((sw - 4) / SPAN_W, (sh - 4) / SPAN_H)));
    const k = cell / this.cell;
    this.cell = cell;
    (this.root ?? document.documentElement).style.setProperty('--cell', cell + 'px');
    const W = SIZE * cell;
    this.W = W;
    const h = cell / Math.SQRT2;                             // 画面上で 1 マス進むと縦横にこれだけずれる
    const wrapW = sw, wrapH = (EXT_UP + EXT_DOWN) * h;
    this.wrapW = wrapW;
    this.topY = EXT_UP * h;                                   // 斜辺の中心線（playfield の中心）の高さ
    Object.assign(this.wrap.style, { width: wrapW + 'px', height: wrapH + 'px' });
    Object.assign(this.pf.style, {
      width: W + 'px', height: W + 'px',
      left: wrapW / 2 - W / 2 + 'px', top: this.topY - W / 2 + 'px',
      transform: this.boardTransform(),
    });
    Object.assign(this.lane.style, { left: 0, top: W + 'px', width: W + 'px', height: cell + 'px' });
    Object.assign(this.laneRow.style, { left: W + 'px', top: 0, width: cell + 'px', height: W + 'px' });
    const g = this.goalPos(), gs = cell * 1.22;
    Object.assign(this.goal.style, {
      left: g.x + (cell - gs) / 2 + 'px', top: g.y + (cell - gs) / 2 + 'px',
      width: gs + 'px', height: gs + 'px',
    });
    // canvas は覆う面積に比例して重くなる（画面の密度の 2 乗）ので、必要なぶんだけ: かけらは盤面の外（ゴールの上など）へ 1.5 マスほど飛ぶ
    this.fxTop.fit(-cell * 1.6, -cell * 1.6, wrapW + cell * 3.2, wrapH + cell * 3.2);
    this.rimFx.fit(-cell * 0.6, -cell * 0.6, cell * (SIZE + 1 + 1.2), cell * (SIZE + 1 + 1.2));   // 盤面 + 通路の 1 マス + 光のにじみの余白
    this.rims.setCell(cell);
    this.drawStatic();
    if (this.marks.length) this.annotate(this.marks);          // マスの大きさが変わったので置き直す
    // ブロックは今見えている位置のまま大きさだけ合わせる（盤面に合わせると、再生中のブロックが最後の位置へ飛んでしまう）。
    // 位置はどれもマスの大きさに比例するので、比で掛ければよい
    if (k !== 1) for (const el of this.els.values()) if (el.__pos) this.setPos(el, { x: el.__pos.x * k, y: el.__pos.y * k }, 0);
    this.refreshGlass();
    this.view3d?.layout();
  }

  /**
   * 小さな演出の canvas の細かさと更新の頻度を、描画装置に合わせる（起動後の空き時間に 1 度）。GPU が無い端末（ソフトウェア描画）では、
   * canvas の中身を書き換えるたびに画面の面積ぶんの写しが要るので、細かさを 1 倍・2 コマに 1 回の更新（30fps）にして、毎フレームの仕事を減らす
   */
  tuneFxDensity() {
    if (!softwareRendering()) return;
    for (const fx of [this.fxTop, this.rimFx]) { fx.setDprMax(1); fx.setEvery(2); }
  }

  /** 盤面と同じ見え方にする transform（ドラッグ中のピースにも使う） */
  boardTransform() { return `scaleY(${STRETCH_Y}) rotate(${ROTATION}deg)`; }

  /** 画面上の座標 -> 盤面（回転前）のローカル px 座標 */
  clientToLocal(cx, cy) {
    const pr = this.pf.getBoundingClientRect();
    const dx = cx - (pr.left + pr.width / 2);
    const dy = (cy - (pr.top + pr.height / 2)) / STRETCH_Y;
    const a = (-ROTATION * Math.PI) / 180;
    return {
      x: this.W / 2 + dx * Math.cos(a) - dy * Math.sin(a),
      y: this.W / 2 + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }
  /** 盤面（回転前）のローカル px 座標 -> 画面上の座標（clientToLocal の逆） */
  localToClient(lx, ly) {
    const pr = this.pf.getBoundingClientRect();
    const a = (ROTATION * Math.PI) / 180, x = lx - this.W / 2, y = ly - this.W / 2;
    return {
      x: pr.left + pr.width / 2 + x * Math.cos(a) - y * Math.sin(a),
      y: pr.top + pr.height / 2 + (x * Math.sin(a) + y * Math.cos(a)) * STRETCH_Y,
    };
  }
  /** 盤面ローカル px 座標 -> rotWrap 内の座標（回転しない要素を置くため） */
  localToWrap(px, py) {
    const a = (ROTATION * Math.PI) / 180;
    const vx = px - this.W / 2, vy = py - this.W / 2;
    return {
      x: this.wrapW / 2 + vx * Math.cos(a) - vy * Math.sin(a),
      y: this.topY + (vx * Math.sin(a) + vy * Math.cos(a)) * STRETCH_Y,
    };
  }

  drawStatic() {
    const c = this.cell;
    this.wellLayer.querySelector('.glass-plate')?.remove();
    const plate = [];
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (isInside(x, y)) plate.push({ x, y });
    this.wellLayer.appendChild(glassElement(plate, 'purple', c, { plate: true }));
    for (const set of this.plateSets) set.replaceChildren();
    this.tintLayer.innerHTML = '';
    this.tints = new Map();    // 'x,r' -> マスの中を色で満たす要素（最初に1回だけ作って使い回す）
    this.lane.innerHTML = '';
    this.laneRow.innerHTML = '';
    this.wells = new Map();
    for (let x = 0; x < SIZE; x++) {
      for (let r = 0; r < SIZE; r++) {
        if (!isInside(x, r)) continue;
        const d = document.createElement('div');
        d.className = 'cell well'
          + (x === 0 && r === 0 ? ' tl' : '') + (x === SIZE - 1 ? ' tr' : '')
          + (x === 0 && r === SIZE - 1 ? ' bl' : '') + (x + r === SIZE - 1 ? ' edge-r' : '');
        d.style.transform = `translate(${x * c}px,${r * c}px)`;
        this.plateSets[0].appendChild(d);
        for (let i = 1; i < this.plateSets.length; i++) this.plateSets[i].appendChild(d.cloneNode(false));
        this.wells.set(`${x},${r}`, d);
        const t = document.createElement('div');
        t.className = 'cell well-tint';
        t.hidden = true;                                    // 色が満ちている間だけ画面に出す（tintCell）。常に 36 個あると、何も動いていなくても描画の仕事が増える
        t.style.transform = d.style.transform;
        this.tintLayer.appendChild(t);
        this.tints.set(`${x},${r}`, t);
      }
    }
    // ライン番号（縦は盤面の下の通路、横は右の通路）。文字は回転させないので rotWrap 側に置く。
    // 通路のマスの中心から、ゴールに近いほど少し外側へずらす
    if (!this.nums) {
      this.nums = document.createElement('div');
      this.nums.className = 'lane-nums';
      this.wrap.insertBefore(this.nums, this.pf.nextSibling);
    }
    this.nums.innerHTML = '';
    this.numEls = new Map();   // 'col3' / 'row5' -> 番号の要素
    const h = c / Math.SQRT2;
    for (let n = 1; n <= SIZE; n++) {
      for (const [kind, x, r] of [['col', SIZE - n, SIZE], ['row', SIZE, SIZE - n]]) {
        const p = this.pos(x, r);
        const q = this.localToWrap(p.x + c / 2, p.y + c / 2);
        const out = Math.sign(q.x - this.wrapW / 2) * 0.28 * h * (SIZE - n) / (SIZE - 1);
        const a = document.createElement('div');
        a.className = 'lane-num';
        a.textContent = n;
        a.style.left = q.x + out + 'px';
        a.style.top = q.y + 0.15 * h + 'px';
        this.nums.appendChild(a);
        this.numEls.set(kind + n, a);
      }
    }
  }

  /* ---------- ブロック ---------- */
  /**
   * マス座標 -> ローカル px。盤面の外（通路とゴール, x + r > 7）は、画面上で斜辺からの高さを
   * LANE_SQUASH 倍に縮めて描く（通路の番号とゴールを盤面に少し近づける）。盤面の中はそのまま。
   */
  pos(x, r) {
    const d = x + r - (SIZE - 1);
    if (d > 0) { const s = ((1 - LANE_SQUASH) * d) / 2; x -= s; r -= s; }
    return { x: x * this.cell, y: r * this.cell };
  }
  ensureEl(block) {
    let el = this.els.get(block.id);
    if (!el) {
      el = document.createElement('div');
      el.className = `cell block c-${block.color}`;
      el.__color = block.color;
      if (block.color === 'garbage') {
        // おじゃま: 灰色のブロックに数字（盤面は回っているので、数字だけ立てて読めるようにする）
        el.classList.add('garbage');
        const num = document.createElement('b');
        num.className = 'gnum upright';
        el.appendChild(num);
        el.__num = num;
        this.setGarbageNum(el, block.garbage ?? 1);
      }
      this.blockLayer.appendChild(el);
      this.els.set(block.id, el);
      this.view3d?.invalidate();
    }
    return el;
  }
  /** おじゃまの数字を書く（2 以下は「もうすぐ消える」色） */
  setGarbageNum(el, n) {
    if (!el?.__num) return;
    el.__n = n;
    el.__num.textContent = n;
    el.classList.toggle('low', n <= 2);
    el.classList.toggle('wide', n >= 10);
  }
  setPos(el, p, dur = 0, ease = '') {
    // 前と同じ値は書き込まない（連鎖の再生中は毎フレーム呼ばれるので、同じ値の書き込みもスタイルの計算し直しになる）
    const t = dur + 'ms', e = ease || 'cubic-bezier(.2,.8,.3,1)', tf = `translate(${p.x}px,${p.y}px)`;
    if (el.__t !== t) { el.style.setProperty('--t', t); el.__t = t; }
    if (el.__e !== e) { el.style.setProperty('--e', e); el.__e = e; }
    if (el.__tf !== tf) { this.detachGlass(el); el.style.transform = tf; el.__tf = tf; this.view3d?.invalidate(); }
    el.__pos = p;
  }
  removeEl(id) {
    this.detachGlass(this.els.get(id));
    this.els.get(id)?.remove();
    this.els.delete(id);
    this.manual.delete(id);
    this.view3d?.invalidate();
  }

  bindBoard(board) { this._board = board; this.syncBoard(board, 0); }

  /** Split a surface before one of its cells moves, so no old silhouette is left behind. */
  detachGlass(el) {
    const group = el?.__glassGroup;
    if (!group) return;
    group.surface.remove();
    for (const cell of group.cells) { cell.el.classList.remove('glass-joined'); cell.el.__glassGroup = null; }
  }

  /** Use displayed positions, never the logical board (which may be several animations ahead). */
  refreshGlass(excluded = new Set()) {
    if (!this.glassLayer) return;
    for (const el of this.els.values()) this.detachGlass(el);
    this.glassLayer.replaceChildren();
    const theme = document.documentElement.dataset.boardTheme;
    if (theme !== 'glass' && theme !== 'white') {
      for (const el of this.els.values()) el.classList.remove('j-l', 'j-r', 'j-t', 'j-b', 'n-tl', 'n-tr', 'n-br', 'n-bl');
      return;
    }
    const cells = [];
    for (const [id, el] of this.els) {
      if (!el.__pos || this.manual.has(id) || excluded.has(id) || el.classList.contains('fly') || el.__num) continue;   // おじゃまは 1 個ずつ（つながない）
      const x = el.__pos.x / this.cell, y = el.__pos.y / this.cell;
      if (Math.abs(x - Math.round(x)) > .001 || Math.abs(y - Math.round(y)) > .001 || !isInside(Math.round(x), Math.round(y))) continue;
      cells.push({ x: Math.round(x), y: Math.round(y), color: el.__color, el });
    }
    if (theme === 'white') {
      const joinable = new Set(cells.map((c) => c.el));
      for (const el of this.els.values()) if (!joinable.has(el)) el.classList.remove('j-l', 'j-r', 'j-t', 'j-b', 'n-tl', 'n-tr', 'n-br', 'n-bl');
      markJoins(cells);
      return;
    }
    for (const group of glassGroups(cells)) {
      const surface = glassElement(group, group[0].color, this.cell);
      this.glassLayer.appendChild(surface);
      const joined = { surface, cells: group };
      for (const cell of group) { cell.el.classList.add('glass-joined'); cell.el.__glassGroup = joined; }
    }
  }

  syncBoard(board, dur = 0, ease = '') {
    this._board = board;
    const alive = new Set();
    for (const { block, x, r } of board.entries()) {
      alive.add(block.id);
      const el = this.ensureEl(block);
      if (block.color === 'garbage') this.setGarbageNum(el, block.garbage);
      if (!this.manual.has(block.id)) this.setPos(el, this.pos(x, r), dur, ease);
    }
    for (const id of [...this.els.keys()]) if (!alive.has(id) && !this.manual.has(id)) this.removeEl(id);
    this.refreshGlass();
  }

  /** 置いた直後の着地演出: ブロックがぽよんと弾み、盤面が小さく沈む（光や粒は出さない） */
  popIn(placed, fit = false) {
    this.clearCelebration();
    placed.forEach(({ block, x, r }, i) => {
      const el = this.ensureEl(block);
      this.setPos(el, this.pos(x, r), 0);
      // 弾みのアニメを最初からやり直すのは、前の弾みが残っているときだけ（置いたブロックは新しい要素なので普通は無い。
      // offsetWidth を読むと、そのたびにページ全体のスタイルとレイアウトを計算し直すことになる）
      if (el.classList.contains('pop-in')) { el.classList.remove('pop-in'); void el.offsetWidth; }
      el.style.setProperty('--d', Math.min(i * 9, 36) + 'ms');
      el.classList.toggle('fit-in', fit);
      el.classList.add('pop-in');
      this.cancelFxTimer(el.__landT);
      el.__landT = this.later(() => el.classList.remove('pop-in', 'fit-in'), 340);
    });
    this.refreshGlass();
    this.view3d?.land(placed.map(({ block }, i) => ({ id: block.id, delay: Math.min(i * 9, 36) })), fit);
    this.bounce([[0, 1], [0.22, 0.996], [0.52, fit ? 1.014 : 1.007], [1, 1]], 220);
  }

  /* ---------- ドラッグ中のプレビュー ---------- */
  /**
   * 仮置きのプレビュー。消える列は既存ブロックごと「持っているピースの色」に塗り替えて光らせ、
   * その列の番号とゴールも光らせる（ここに置けば消える、という期待を先に見せる）。
   */
  showPreview(piece, ox, oy, clearCells, chainCount, lines = [], fit = null) {
    const c = this.cell;
    const key = `${ox},${oy},${chainCount}`;
    const fresh = key !== this._pvKey;
    this._pvKey = key;
    this.ghostLayer.innerHTML = '';
    this.hiLayer.innerHTML = '';
    const willClear = clearCells.length > 0;
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `cell ghost c-${piece.color}` + (willClear ? ' strong' : '') + (fit?.kind ? ` fit ${fit.kind}` : '');
      d.style.transform = `translate(${(ox + cc.x) * c}px,${(oy + cc.y) * c}px)`;
      this.ghostLayer.appendChild(d);
    }
    // 斜辺側の端から順に光が走り込むよう、少しずつ遅らせる
    const seen = new Set(), hi = [];
    for (const { x, r } of clearCells) {
      const k = `${x},${r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      hi.push({ x, r, d: (x + r) * 14 });
      const d = document.createElement('div');
      d.className = `cell hi c-${piece.color}` + (fresh ? ' enter' : '');
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      d.style.setProperty('--d', (x + r) * 14 + 'ms');
      this.hiLayer.appendChild(d);
    }
    this.view3d?.setPreview({ key, cells: piece.cells.map((cc) => ({ x: ox + cc.x, r: oy + cc.y })), color: piece.color,
      strong: willClear, fit: fit?.kind ?? null, hi, fresh });
    this.litLines(lines, piece.color);
    this.goal.classList.toggle('ready', willClear);
  }
  /** 発動するラインの番号を光らせる（ラインごとに色を変えるときは lines の要素に color を持たせる） */
  litLines(lines, color) {
    for (const el of this.numEls?.values() ?? []) el.classList.remove('lit');
    for (const l of lines) {
      const el = this.numEls?.get(l.kind + l.n);
      if (!el) continue;
      el.className = `lane-num lit c-${l.color ?? color}`;
    }
  }
  /**
   * チュートリアルで動きを説明する印。marks = [{ x, r, color, kind }]
   * kind 'line' = 発動するラインのマス（金色の枠）/ 'target' = 流れこんだブロックが止まるマス（学習モードのおすすめと同じ、白い枠 + ブロックの色）
   */
  annotate(marks) {
    const c = this.cell;
    this.marks = marks;
    this.annoLayer.innerHTML = '';
    for (const { x, r, color, kind } of marks) {
      const d = document.createElement('div');
      d.className = `cell hint c-${color}` + (kind === 'line' ? ' plan anno-line' : '');
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      this.annoLayer.appendChild(d);
    }
  }
  clearAnnotations() { this.marks = []; this.annoLayer.innerHTML = ''; }
  /** 学習モードのおすすめ: 置く場所のマスを、持つピースの色で光る枠にして脈打たせる（手順どおりの手は金色） */
  showHint(piece, ox, oy, plan = false) {
    const c = this.cell;
    this.hintLayer.innerHTML = '';
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `cell hint c-${piece.color}` + (plan ? ' plan' : '');
      d.style.transform = `translate(${(ox + cc.x) * c}px,${(oy + cc.y) * c}px)`;
      this.hintLayer.appendChild(d);
    }
  }
  clearHint() { this.hintLayer.innerHTML = ''; }

  clearPreview() {
    this.ghostLayer.innerHTML = ''; this.hiLayer.innerHTML = '';
    this._pvKey = null;
    this.view3d?.setPreview(null);
    this.litLines([]);
    this.goal.classList.remove('ready');
  }

  /**
   * 発動の直前の「溜め」: 満杯になったラインのブロック stack がぎゅっと縮み、ラインの番号が弾む。
   * （盤面 this._board は連鎖の最後まで進んだ状態なので、そこからラインのブロックを探してはいけない）
   */
  async charge(kind, n, stack, ms = 150) {
    if (this.rush) return;
    this.lineGlow(kind, n, stack[0]?.color, 1, Math.max(320, 700 / Math.max(1, this.timeScale)));   // 満杯になったラインの枠が光る（このあとの発動の始まりでは二重に出さない）
    this.sfx?.charge(1, Math.max(0.035, ms / (1000 * Math.max(1, this.timeScale))));
    if (reducedMotion()) { await this.wait(ms); return; }
    // 位置を持つ親要素を scale すると translate まで拡縮されて列からずれる。
    // 溜めはその場の宝石の面だけに掛け、移動を始める前に戻す。
    const els = stack.map((b) => this.els.get(b.id)).filter(Boolean);
    for (const el of els) {
      el.style.setProperty('--charge', ms + 'ms');
      el.classList.add('charging');
    }
    const ids = stack.map((b) => b.id);
    this.view3d?.charge(ids, ms);
    this.numEls?.get(kind + n)?.animate([{ scale: '1' }, { scale: '1.5' }, { scale: '1' }], { duration: ms + 160, easing: 'ease-out' });
    await this.wait(ms);
    for (const el of els) el.classList.remove('charging');
    this.view3d?.charge(ids, 0);
  }

  /** 再生の時間で ms 待つ（一時停止中は止まり、速めると早く終わる。早送り・リスタートしたらすぐ終わる） */
  wait(ms) {
    if (this.rush) return Promise.resolve();
    return new Promise((resolve) => {
      let raf = 0, left = ms, last = performance.now();
      const w = () => { cancelAnimationFrame(raf); this.waiters.delete(w); resolve(); };
      const frame = (now) => {
        left -= Math.max(0, now - last) * this.timeScale;
        last = now;
        if (left <= 0) w(); else raf = requestAnimationFrame(frame);
      };
      raf = requestAnimationFrame(frame);
      this.waiters.add(w);
    });
  }

  /** 早送りを始める / やめる。始めたら、待っているものと動いているものをすぐ終わらせる */
  setRush(on) {
    this.rush = on;
    if (on) for (const w of [...this.waiters]) w();
  }

  /** 盤面が混んでピンチのときだけ、画面の縁がゆっくり脈打つ（0 = なし … 1 = 最大） */
  setDanger(level) {
    setVeil(this.dangerEl, level);
  }

  /* ---------- ライン発動（マンカラ） ---------- */
  goalPos() { return this.pos(SIZE, SIZE); }

  /** 演出用の要素を layer に足し、ms 後に消す */
  addFx(layer, el, ms) {
    layer.appendChild(el);
    this.later(() => el.remove(), ms);
  }

  /** 装飾用の遅延も停止・リセットに追従させる（古い全消しの破裂を次のゲームへ持ち越さない）。 */
  later(fn, ms) {
    const timer = { fn, left: Math.max(0, ms), started: 0, id: null, gen: this.gen };
    this.fxTimers.add(timer);
    if (!this.fxPaused) this.armFxTimer(timer);
    return timer;
  }
  armFxTimer(timer) {
    timer.started = performance.now();
    timer.id = setTimeout(() => {
      this.fxTimers.delete(timer);
      if (timer.gen === this.gen) timer.fn();
    }, timer.left);
  }
  cancelFxTimer(timer) {
    if (!timer) return;
    clearTimeout(timer.id);
    this.fxTimers.delete(timer);
  }
  setPaused(on) {
    if (this.fxPaused === on) return;
    this.fxPaused = on;
    for (const t of this.fxTimers) {
      if (on) { clearTimeout(t.id); t.left = Math.max(0, t.left - (performance.now() - t.started)); }
      else this.armFxTimer(t);
    }
    this.fxTop.setPaused(on); this.rimFx.setPaused(on);
    this.view3d?.setPaused(on);
    if (on) {
      for (const a of this.wrap.getAnimations({ subtree: true })) if (a.playState === 'running') {
        a.pause(); this.pausedAnimations.add(a);
      }
    } else {
      for (const a of this.pausedAnimations) if (a.playState === 'paused') a.play();
      this.pausedAnimations.clear();
    }
  }
  clearCelebration() {
    this.celebration++;
    this.fxLayer.querySelectorAll('.ac-gem').forEach((el) => el.remove());
    this.view3d?.clearGems();
  }

  /** スナップショット Map<id,{x,r,color}> の位置へ全ブロックを即座に合わせる（載っていないブロックは触らない） */
  applySnapshot(snap) {
    for (const [id, { x, r, color }] of snap) {
      if (this.manual.has(id)) continue;
      this.setPos(this.ensureEl({ id, color }), this.pos(x, r), 0);
    }
    this.refreshGlass();
  }

  /**
   * requestAnimationFrame で、再生の時間で duration ms の間 fn(t[ms]) を毎フレーム呼ぶ。ついでにフレーム時間を測る。
   * 一時停止中（timeScale 0）は進まない。早送りになったら最後の位置へ飛ぶ。リスタートしたら何もせずに終わる
   */
  tween(duration, fn) {
    if (this.rush) { fn(duration); return Promise.resolve(); }
    const gen = this.gen;
    return new Promise((resolve) => {
      let t = 0, last = performance.now(), measured = 0;
      const frame = (now) => {
        if (gen !== this.gen) { resolve(); return; }
        const dt = Math.max(0, now - last);
        last = now;
        // 1回だけの大きな引っかかり（手駒の計算・タブの切り替えなど）は数えない。続けて遅いときだけ演出を減らす
        if (measured++ && !this.rush && this.timeScale > 0 && dt < 100) this.frameMs += (dt - this.frameMs) * 0.08;
        t = this.rush ? duration : Math.min(duration, t + dt * this.timeScale);
        fn(t);
        if (t < duration) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  /**
   * 演出の量の目安（1 = 全部 … 0.25 = 最小限）。ブロックが動いている間のフレーム時間から決める。
   * 遅い端末や重い場面では、かけら・波打ち・1文字ずつの文字・マスに満ちる色を自動で減らす
   */
  get q() { return Math.max(0.25, Math.min(1, 1 - (this.frameMs - 20) / 26)); }

  /**
   * ライン(kind, n) の発動を再生する。縦列と横列はまったく同じ動きで、横列は縦横を入れ替えて描く。
   * 以下は縦列の座標 (x, r) で説明（横列は x と r を入れ替える）。
   *
   *  1) 列全体が1本の列車のように、列の中を下へ → 盤面の下の通路を右へ、切れ目なく流れる。
   *     どのブロックもちょうど 9 マス進むので全員同時に動き、同時に止まる。
   *     先頭（一番下だったブロック）はゴール (8,8) に着く。
   *  2) 残りのブロックが各ラインへ下から入る。押し込む相手がいる場合、押されるブロックの位置は
   *     入ってくるブロックの位置から計算する（= 常に接触したまま一緒に動く、隙間ができない）。
   *  連鎖数では速めず、次の操作に追いつくときだけ再生速度を変える。
   */
  /**
   * playStep の再生時間（speed 1 のとき、ms）。列車の 9 マス + 一番遠くまで入るブロックのマス数（playStep と同じ計算）。
   * 再生中にピースを持ち上げたときに、残りの再生時間から速さを決めるのに使う
   */
  static stepCells(step) {
    const { kind, stack, after } = step;
    let longest = 1;
    for (let k = 1; k < stack.length; k++) {
      const a = after.get(stack[k].id);
      longest = Math.max(longest, a ? SIZE - (kind === 'col' ? a.r : a.x) : k);
    }
    return 9 + longest;
  }

  /**
   * pause: チュートリアルで動きを説明するための一時停止（先頭がゴールに入り、残りがラインへ入る直前に await する）。
   * 普段の再生では渡さない
   */
  async playStep(step, speed = 1, pause = null) {
    const { kind, n: N, stack, chain, before, after } = step;
    const gen = this.gen;                                    // 途中でリスタートしたら、古い盤面の続きは描かない
    // 着地・前の見せ場の拡縮を移動へ持ち越さず、通路上では盤面を固定する。
    this._bounce?.cancel();
    this._shake?.cancel();
    this._punch?.cancel();
    const cellT = ANIM.step / speed;                         // 1マスあたりの時間
    const F = kind === 'col' ? (x, r) => ({ x, r }) : (x, r) => ({ x: r, r: x });   // 画面 <-> 縦列の座標
    const P = (fx, fr) => { const q = F(fx, fr); return this.pos(q.x, q.r); };
    const src = SIZE - N;
    const els = stack.map((b) => { this.manual.add(b.id); const el = this.ensureEl(b); el.classList.add('travel'); return el; });
    const moving = new Set(stack.map((b) => b.id));
    for (const [id, p] of before) {
      const q = after.get(id);
      if (!q || p.x !== q.x || p.r !== q.r) moving.add(id);
    }
    this.refreshGlass(moving);

    // 1) 列車（9マス）: 経路上の距離 s -> 位置。s<=8 は列の中を下へ、s>8 は通路を右へ
    const along = (s) => (s <= SIZE ? P(src, s) : P(src + (s - SIZE), SIZE));
    const start = stack.map((_, k) => N - 1 - k);           // slot k の r = N-1-k
    const trainT = 9 * cellT;
    if (!this.rush) {
      this.sfx?.sink(chain, N);
      this.lineGlow(kind, N, stack[0]?.color, chain, Math.max(320, Math.min(800, trainT + 160)));   // 連鎖の 2 番目以降は、ここで枠が光る（1 番目は溜めの始まりで出している。速い再生では短く）
      this.lineBlast(kind, N, stack[0]?.color, chain, stack, before);
      this.wake(kind, N, stack[0]?.color, trainT);
      this.trail(kind, N, stack[0]?.color, trainT);
    }
    let lastCell = -1;
    await this.tween(trainT, (t) => {
      const u = 9 * easeInOut(t / trainT);
      els.forEach((el, k) => this.setPos(el, along(start[k] + u), 0));
      const c = Math.floor(u);
      if (c !== lastCell) {
        lastCell = c;
        if (c > 0 && c < 9 && !this.rush && this.timeScale <= 1.5) this.sfx?.step(c, chain);     // 速めている間は刻みの音を鳴らさない
      }
    });
    if (gen !== this.gen) return;

    // 先頭がゴールへ
    this.goalIn(stack[0], chain);
    if (pause && !this.rush) {
      await pause();
      if (gen !== this.gen) return;
    }

    // 2) 各ラインへ入る
    const lanePos = (k) => ({ fx: SIZE - k, fr: SIZE });     // ライン k の真下の通路
    const moves = [];            // { el, from:{fx,fr}, to:{fx,fr}, dist, pushed:[{el, fromR, toR}] }
    const goals = [];            // 満杯で入れず、ゴールへ流れるブロック
    for (let k = 1; k < stack.length; k++) {
      const b = stack[k], el = els[k];
      const a = after.get(b.id);
      if (!a) { goals.push({ b, el, k }); continue; }
      const to = F(a.x, a.r);                                // 縦列座標での目的地
      const from = lanePos(k);
      // このラインで押されるブロック: 前後で位置が変わった、同じライン上のブロック
      const pushed = [];
      for (const [id, pb] of before) {
        const q = F(pb.x, pb.r);
        if (q.x !== to.x || stack.some((s) => s.id === id)) continue;
        const qa = after.get(id);
        if (!qa) continue;
        const qa2 = F(qa.x, qa.r);
        if (qa2.r !== q.r) pushed.push({ el: this.ensureEl({ id, color: pb.color }), fromR: q.r, toR: qa2.r });
      }
      moves.push({ el, b, from, to, dist: from.fr - to.r, pushed });
    }
    const longest = Math.max(1, ...moves.map((m) => m.dist), ...goals.map((g) => g.k));
    const enterT = longest * cellT;
    const pushedSound = new Set();
    // 入っていく先のラインの番号が光る
    if (!this.rush) for (const m of moves) this.glowNum(kind, SIZE - m.to.x, m.b.color);
    if (moves.length || goals.length) {
      await this.tween(enterT, (t) => {
        for (const m of moves) {
          if (!m.settled && t >= m.dist * cellT) { m.settled = true; this.settle(m.el, P(m.to.x, m.to.r), m.b.color, moves.indexOf(m)); }
          const d = m.dist * easeOut(Math.min(1, t / (m.dist * cellT)));
          const r = m.from.fr - d;                           // 入ってくるブロックの位置（上へ進む）
          this.setPos(m.el, P(m.to.x, r), 0);
          // 押されるブロックは「入ってくるブロックの位置 - 最終的な相対距離」より手前には居られない
          for (const q of m.pushed) {
            const rr = Math.min(q.fromR, r - (m.to.r - q.toR));
            this.setPos(q.el, P(m.to.x, rr), 0);
            if (rr < q.fromR && !pushedSound.has(m) && !this.rush) { pushedSound.add(m); this.sfx?.push(chain); }
          }
        }
        for (const g of goals) {                             // 通路をそのまま右へ流れてゴール
          const d = g.k * easeOut(Math.min(1, t / (g.k * cellT)));
          this.setPos(g.el, P(SIZE - g.k + d, SIZE), 0);
        }
      });
      if (gen !== this.gen) return;
    }
    for (const m of moves) if (!m.settled) this.settle(m.el, P(m.to.x, m.to.r), m.b.color, moves.indexOf(m));
    if (goals.length) this.goalIn(goals.map((g) => g.b), chain);     // 同時に着くブロックの演出はまとめて1回
    for (const m of moves) { this.manual.delete(m.b.id); m.el.classList.remove('travel'); }
    this.applySnapshot(after);
  }

  /** 配られたブロックがラインの中で止まった: 小さな音だけ（弾ませない） */
  settle(el, p, color, i = 0) {
    if (this.rush) return;
    this.sfx?.settle?.(i);
  }

  /** ライン番号の後ろに一瞬ブロックの色の丸を出して弾ませる（transform と opacity だけの小さなアニメーション） */
  glowNum(kind, n, color) {
    const el = this.numEls?.get(kind + n);
    if (!el) return;
    el.classList.add('lit', `c-${color}`);
    el.animate([{ scale: '1' }, { scale: '1.35' }, { scale: '1' }], { duration: 420, easing: 'ease-out' })
      .onfinish = () => el.classList.remove('lit', `c-${color}`);
  }

  /** ブロック（1個または同時に着く複数個）がゴールに入る。演出と音はまとめて1回 */
  goalIn(blocks, chain) {
    const list = Array.isArray(blocks) ? blocks : [blocks];
    for (const block of list) {
      const el = this.els.get(block.id);
      if (!el) continue;
      el.style.setProperty('--t', '0ms'); el.__t = '0ms';
      if (this.rush) { this.removeEl(block.id); continue; }
      el.classList.add('fly');
      this.view3d?.fly(block.id);
      this.later(() => { if (this.els.get(block.id) === el) this.removeEl(block.id); }, 220);
    }
    if (this.rush) return;
    const color = list[0].color;
    this.hitGoal(chain, color, list.length);
    this.shatter(list.map((b) => b.color), 3 + Math.min(chain, 4) + Math.min(list.length - 1, 3));
    this.goalSparkle(list.map((b) => b.color), Math.min(chain, 4));
  }

  /** ゴールがぽんと弾み、中の面が入ったブロックの色で満ちて引いていく（光らせない） */
  hitGoal(chain, color, count = 1) {
    this._goalHit?.cancel();
    const k = Math.min(chain, 8);
    if (!reducedMotion()) this._goalHit = this.goal.animate(eased([
      { transform: 'none' },
      { transform: 'scale(.93)', offset: 0.12 },
      { transform: `scale(${1.13 + k * 0.009 + Math.min(count - 1, 3) * 0.012})`, offset: 0.36 },
      { transform: 'scale(.985)', offset: 0.72 },
      { transform: 'none' },
    ], 'ease-out'), { duration: 300 });
    if (color) {
      this.goalFill.className = `goal-fill c-${color}`;
      this._goalFill?.cancel();
      // 半透明にすると背景の青と混ざって濁るので、濃さは変えずに大きさだけで満ちて引く
      this._goalFill = this.goalFill.animate([
        { opacity: 1, scale: '0' }, { scale: '1.04', offset: 0.28 }, { scale: '1', offset: 0.55 }, { opacity: 1, scale: '0' },
      ], { duration: 460, easing: 'ease-in-out' });
    }
    this.sfx?.goal(chain, count);
  }

  /** 入った宝石と同じ色・塗り・向きのかけらが n 個はじけ、重力で落ちていく。 */
  shatter(colors, n) {
    if (reducedMotion() || this.q < 0.6) return;
    n = Math.max(2, Math.round(n * this.q));
    const q = this.cellCenter(this.goalPos()), c = this.cell;
    this.shardLayer.burst(q.x, q.y, colors, n, c * 0.33, c * 4.1, { life: 0.6 });
  }

  /**
   * ラインが満杯になった（溜めの始まり・連鎖の 2 番目以降の発動の始まり）: そのラインの枠が白く光って
   * （ふちは白、外側と内側にブロックの明るい色のにじみ）、光の帯がブロックの流れる向きに走り、星がきらきらとまたたく。
   * シャランの音もここで鳴らす。同じラインに溜めと発動で二重に出さない。動きを減らす設定では、枠がふわっと光って消えるだけ
   */
  lineGlow(kind, n, color = 'yellow', chain = 1, ms = 700) {
    if (this.rush || !this.fxLayer) return;
    const now = performance.now(), key = kind + n;
    if (this._glowKey === key && now - this._glowAt < 320) return;
    this._glowKey = key; this._glowAt = now;
    this.sfx?.shalan(chain, { size: chain > 1 ? 0.8 : 0.65 });
    this.view3d?.sweep(Math.min(1.3, 0.6 + chain * 0.1));      // 3D: ガラスの面に映る光の帯が横切る
    const c = this.cell, fixed = SIZE - n, quiet = reducedMotion();
    const vertical = kind === 'col';
    const box = vertical ? { x: fixed * c, y: 0, w: c, h: n * c } : { x: 0, y: fixed * c, w: n * c, h: c };
    const el = document.createElement('div');
    el.className = `line-glow ${kind}`;
    el.style.cssText = `transform:translate(${box.x}px,${box.y}px);width:${box.w}px;height:${box.h}px;--g:${glowOf(color)}`;
    const shine = document.createElement('i');
    shine.className = 'lg-shine';
    el.appendChild(shine);
    this.addFx(this.fxLayer, el, ms + 60);
    if (quiet) {
      el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 0 }], { duration: ms * 0.7, easing: 'ease-out' });
      return;
    }
    el.animate(eased([
      { opacity: 0, scale: '0.96' },
      { opacity: 1, scale: '1.035', offset: 0.18 },
      { opacity: 0.9, scale: '1', offset: 0.55 },
      { opacity: 0, scale: '1' },
    ], 'ease-out'), { duration: ms });
    // 光の帯: ブロックが流れていく向き（斜辺側の端）へ、ラインの長さぶん走り抜ける
    shine.animate([{ translate: vertical ? '0 -100%' : '-100% 0' }, { translate: vertical ? '0 100%' : '100% 0' }],
      { duration: ms * 0.62, delay: ms * 0.05, easing: 'ease-in-out', fill: 'backwards' });
    if (this.q < 0.6) return;
    const m = Math.max(4, Math.min(12, Math.round(n * 1.6)));
    for (let i = 0; i < m; i++) {
      const along = ((i + 0.3 + Math.random() * 0.4) / m) * (vertical ? box.h : box.w);
      const side = (i % 2 ? 0.1 : 0.9) + (Math.random() - 0.5) * 0.12;
      const p = this.localToWrap(vertical ? box.x + side * box.w : box.x + along, vertical ? box.y + along : box.y + side * box.h);
      this.sparkLayer.twinkle(p.x, p.y, { color: i % 3 === 0 ? color : 'white', size: c * (0.55 + Math.random() * 0.35), delay: i * 30 + Math.random() * 50, life: 440 + Math.random() * 180 });
    }
  }

  /**
   * ブロックが通り過ぎた跡が、ほんの少しのあいだ光る: 抜けたマスの縁が白く光って引き、星が 1 つまたたく。
   * ラインの外（斜辺と通路の間・通路の入り口）も、ゴールの手前まで。wake（色が満ちる）と同じ時刻に始まる。
   * 光る要素はブロックより下（動いているブロックの後ろ）に出る
   */
  trail(kind, n, color = 'yellow', trainT = 540) {
    if (this.rush || !this.fxLayer || reducedMotion() || this.q < 0.5) return;
    const src = SIZE - n, F = kind === 'col' ? (x, r) => ({ x, r }) : (x, r) => ({ x: r, r: x });
    const stars = this.q >= 0.7, c = this.cell;
    for (let p = 0; p <= 8; p++) {
      const cell = F(src, p), pos = this.pos(cell.x, cell.r);
      const at = trainT * easeInOutInv(Math.min(1, (p + 1) / 9));   // 列車の後ろが抜けた時刻（wake と同じ）
      this.rims.flash(pos.x, pos.y, color, at);
      if (stars) {
        const mid = this.cellCenter(pos);
        this.sparkLayer.twinkle(mid.x + (Math.random() - 0.5) * c * 0.5, mid.y + (Math.random() - 0.5) * c * 0.5,
          { color: p % 2 ? color : 'white', size: c * (0.55 + Math.random() * 0.2), delay: at + 20, life: 460 });
      }
    }
  }

  /** ブロックがゴールに入った: ゴールの回りに星がはじけるようにまたたく（宝石のかけらと同時） */
  goalSparkle(colors, n = 1) {
    if (this.rush || reducedMotion() || this.q < 0.6) return;
    const p = this.cellCenter(this.goalPos()), c = this.cell, m = Math.min(8, 4 + n);
    for (let i = 0; i < m; i++) {
      const a = (i / m) * Math.PI * 2 + Math.random() * 0.5, r = c * (0.55 + Math.random() * 0.5);
      this.sparkLayer.twinkle(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r,
        { color: i % 2 ? colors[i % colors.length] : 'white', size: c * (0.5 + Math.random() * 0.4), delay: i * 22, life: 460 + Math.random() * 140, rise: 10 });
    }
  }

  /**
   * 発動したラインの空いたマスに、ブロックの色が満ちて引いていく（列車が通り過ぎた跡）。
   * ブロックが抜けた瞬間から、通路と反対側の端から順に
   */
  wake(kind, n, color, trainT) {
    if (this.q < 0.55 || reducedMotion()) return;
    for (const { x, r } of lineCells(kind, n)) {
      const along = kind === 'col' ? r : x;                   // 列車の進む向きの位置（0 = 通路と反対側の端）
      const at = trainT * easeInOutInv(Math.min(1, (along + 1) / 9));
      this.tintCell(x, r, color, at, 560);
    }
  }

  /**
   * マス (x, r) の中をブロックの色で満たして引く（delay ms 後から life ms）。
   * 要素はマスごとに1つを使い回す（色が変わるのは満ち始める瞬間）
   */
  tintCell(x, r, color, delay, life) {
    if (this.view3d) { this.view3d.tint(x, r, color, delay, life); return; }     // 3D: マスのくぼみの底が、その色で光る
    const d = this.tints?.get(`${x},${r}`);
    if (!d) return;
    d.__anim?.cancel();
    this.cancelFxTimer(d.__t);
    d.hidden = false;
    d.__t = this.later(() => { d.className = `cell well-tint c-${color}`; }, delay);
    // 半透明にすると背景の紺と混ざって濁るので、濃さは変えずにマスの中心から大きさだけで満ちて引く
    const anim = d.__anim = d.animate([{ scale: '0' }, { scale: '1.06', offset: 0.26 }, { scale: '1', offset: 0.4 }, { scale: '1', offset: 0.6 }, { scale: '0' }],
      { duration: life, delay, easing: 'ease-in-out' });
    anim.onfinish = anim.oncancel = () => { if (d.__anim === anim) d.hidden = true; };      // 終わったら画面から外す（あとから別の色で満ち直しているときは外さない）
  }

  /** 盤面がぽんと弾む（[offset, scale] の並び, ms）。クラスの付け外しと強制レイアウトを使わない */
  bounce(frames, dur) {
    if (reducedMotion()) return;
    this._bounce?.cancel();
    this._bounce = this.pf.animate(eased(frames.map(([offset, v]) => ({ offset, scale: `${v}` })), 'ease-out'), { duration: dur });
    this.view3d?.invalidate(dur + 40);
  }

  /** マス中心のローカル px -> rotWrap 内の座標 */
  cellCenter(p) { return this.localToWrap(p.x + this.cell / 2, p.y + this.cell / 2); }

  /** 移動中は宝石と盤面の大きさを固定し、小さな同色のかけらだけを添える。 */
  lineBlast(kind, n, color = 'yellow', chain = 1, moving = [], before = null) {
    for (const block of moving) {
      const el = this.els.get(block.id);
      if (!el) continue;
      el.classList.remove('pop-in', 'fit-in', 'charging');
    }
    if (reducedMotion()) return;
    if (n >= 3 && this.q >= 0.7 && moving[0]) {
      const at = before?.get(moving[0].id);
      if (at) {
        const p = this.cellCenter(this.pos(at.x, at.r));
        this.shardLayer.burst(p.x, p.y, [color], Math.min(4, 2 + Math.floor(chain / 4)), this.cell * 0.19, this.cell * 2.2, { life: 0.4 });
      }
    }
  }

  /** 画面が一瞬ぐっと寄って戻る（大きな連鎖の衝撃）。scale だけを動かす */
  punch(amount = 0.02, dur = 240) {
    if (reducedMotion()) return;
    this._punch?.cancel();
    this._punch = this.wrap.animate([{ scale: `${1 + amount}` }, { scale: '1' }], { duration: dur, easing: 'cubic-bezier(.2,.8,.3,1)' });
    this.view3d?.invalidate(dur + 40);
  }

  /** 盤面の外接四角（rotWrap の座標）。画面全体の演出を盤面の中心から始めるため */
  boardBox() {
    const c = this.cell;
    const pts = [[0, 0], [SIZE, 0], [0, SIZE]].map(([x, r]) => this.localToWrap(x * c, r * c));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  /**
   * 全消し（盤面の中の分。画面を覆う演出は使わない）:
   *  1) 空になった全マスに、盤面の中心から輪になって順に7色の宝石（ブロックと同じ .block の塗り）がぽんと満ちる
   *  2) 満ちた宝石が、同じ順に砕けて小さくなり、ブロックと同じ塗りのかけらを散らす。砕けるたびに盤面がぐっと寄る
   * 宝石は半透明にせず、大きさだけで出し入れする（背景の青と混ざって濁らないように）
   */
  allClearBlast() {
    this.clearCelebration();
    const celebration = this.celebration;
    this.sfx?.allClear();
    this.view3d?.sweep(1.5);
    this.punch(0.045, 320);
    const c = this.cell, cx = (SIZE - 1) / 3, cr = (SIZE - 1) / 3;   // 直角三角形の盤面の重心あたり
    const RING = 55, LIFE = 760;                                   // 短い余韻。次を置いたらすぐ引く
    const cells = [];
    for (let x = 0; x < SIZE; x++) for (let r = 0; r < SIZE; r++) {
      if (isInside(x, r)) cells.push({ x, r, ring: Math.round(Math.hypot(x - cx, r - cr) * 1.3) });   // 7色がひと回りする細かさ
    }
    const rings = Math.max(...cells.map((q) => q.ring));
    if (reducedMotion() || this.q < 0.45) {                         // 重い端末・動きを減らす設定: 色が満ちるだけ
      for (const q of cells) this.tintCell(q.x, q.r, COLORS[q.ring % COLORS.length], 60 + q.ring * 70, 620);
      return;
    }
    const shardEvery = this.q >= 0.8 ? 1 : 2;                      // 遅い端末ではかけらを半分に
    cells.forEach((q, i) => {
      const color = COLORS[q.ring % COLORS.length], d = 40 + q.ring * RING;
      const el = document.createElement('div');
      el.className = `cell block ac-gem c-${color}`;
      el.style.transform = `translate(${q.x * c}px,${q.r * c}px)`;
      el.style.setProperty('--d', d + 'ms');
      el.style.setProperty('--life', LIFE + 'ms');
      this.addFx(this.fxLayer, el, d + LIFE + 50);
      this.view3d?.gem(q.x, q.r, color, d, LIFE);
      if (i % shardEvery) return;
      // 宝石が砕ける瞬間（アニメの 72% の所）にかけらを散らす
      this.later(() => {
        if (!el.isConnected || this.celebration !== celebration) return;
        const p = this.cellCenter(this.pos(q.x, q.r));
        this.shardLayer.burst(p.x, p.y, [color], 2, c * 0.29, c * 3.2, { spread: 3.4, cap: 42, life: 0.55 });
      }, d + LIFE * 0.72);
    });
    // 砕け始め・砕け終わりで盤面がぐっと寄る
    const burstAt = 40 + LIFE * 0.72;
    this.later(() => { if (this.celebration === celebration) { this.punch(0.022, 230); this.sfx?.shatter(); } }, burstAt);
    this.later(() => { if (this.celebration === celebration) this.punch(0.015, 220); }, burstAt + rings * RING);
  }

  /* ---------- 対戦: おじゃま ---------- */
  /**
   * おじゃまが盤面の上から落ちてきて積もる（core/battle.js の dropPath の道のり。まっすぐ落ちる・斜めにすべる）。
   * landed = [{ block, x, r, path }]。1 個ずつ少しずらして落とし、止まるとつぶれて弾み、盤面が沈む。全部止まったら解決する
   */
  async garbageLand(landed) {
    if (!landed?.length) return;
    const gen = this.gen, c = this.cell;
    const count = landed.length, nums = landed.map((l) => l.n ?? l.block.garbage), sum = nums.reduce((a, v) => a + v, 0);
    const heavy = count >= 3 || sum >= 10;                         // たくさん・大きいおじゃま: 演出を一段強く
    // 警告（落ち始める前の間）: 縁の赤い光・盤面の小さな揺れ・低い警告音
    this.garbageWarn(count, sum, heavy);
    await this.wait(DROP_WARN_MS);
    if (gen !== this.gen) return;
    const jobs = landed.map(({ block, x, r, n, path }, i) => (async () => {
      await this.wait(i * DROP_GAP_MS);
      if (gen !== this.gen) return;
      const pts = path?.length ? [...path] : [{ x, r }];
      const top = pts[0];
      pts.unshift({ x: top.x + 4, r: top.r + 4 });                 // もっと上（画面の外寄り）から落ちてくる
      const el = this.ensureEl(block);
      this.setGarbageNum(el, n ?? block.garbage);
      this.manual.add(block.id);
      el.classList.add('travel', 'falling');
      const at = (p) => ({ x: p.x * c, y: p.r * c });
      this.setPos(el, at(pts[0]), 0);
      const lens = [0];
      for (let k = 1; k < pts.length; k++) lens.push(lens[k - 1] + Math.hypot(pts[k].x - pts[k - 1].x, pts[k].r - pts[k - 1].r));
      const total = lens.at(-1) || 1, dur = Math.min(DROP_FALL_MS, Math.max(380, 110 * Math.sqrt(total) * 2.4));
      let lastSpark = 0;
      await this.tween(dur, (t) => {
        const u = Math.pow(Math.min(1, t / dur), 1.9) * total;    // 落ちるほど速く（重力）
        let k = 1;
        while (k < lens.length - 1 && lens[k] < u) k++;
        const a = pts[k - 1], b = pts[k], f = Math.min(1, Math.max(0, (u - lens[k - 1]) / ((lens[k] - lens[k - 1]) || 1)));
        const cur = at({ x: a.x + (b.x - a.x) * f, r: a.r + (b.r - a.r) * f });
        this.setPos(el, cur, 0);
        // 落ちた跡の火花（かけらと星）
        if (!reducedMotion() && this.q >= 0.5 && t - lastSpark > dur / 9 && t < dur * 0.97) {
          lastSpark = t;
          const p = this.localToWrap(cur.x + c / 2, cur.y + c / 2);
          this.sparkLayer.twinkle(p.x, p.y, { color: 'white', size: c * 0.55, life: 360, rise: -c * 0.6 });
          this.shardLayer.burst(p.x, p.y, ['garbage'], 1, c * 0.12, c * 0.9, { life: 0.3 });
        }
      });
      if (gen !== this.gen) return;
      this.manual.delete(block.id);
      el.classList.remove('travel', 'falling');
      this.setPos(el, this.pos(x, r), 0);
      if (el.classList.contains('pop-in')) { el.classList.remove('pop-in'); void el.offsetWidth; }
      el.style.setProperty('--d', '0ms');
      el.classList.add('pop-in', 'fit-in');
      this.cancelFxTimer(el.__landT);
      el.__landT = this.later(() => el.classList.remove('pop-in', 'fit-in'), 420);
      this.view3d?.land([{ id: block.id, delay: 0 }], true);
      this.sfx?.garbageLand?.(i, n ?? block.garbage);
      // ずしんと着地: 盤面が沈んで弾む・画面が揺れる・衝撃の輪・かけら
      const big = Math.min(1, ((n ?? block.garbage) + count) / 14);
      this.bounce([[0, 1], [0.14, 0.955 - big * 0.02], [0.5, 1.014], [0.78, 0.997], [1, 1]], 360);
      this.punch(0.012 + big * 0.02, 260);
      this.shake(3 + big * 5 + (i === count - 1 && heavy ? 3 : 0), 280);
      if (!reducedMotion()) {
        const p = this.cellCenter(this.pos(x, r));
        this.impactRing(p, c * (2.6 + big * 1.6));
        if (this.q >= 0.5) {
          this.shardLayer.burst(p.x, p.y, ['garbage'], 6 + Math.round(big * 5), c * 0.2, c * 2.4, { life: 0.5 });
          this.sparkLayer.twinkle(p.x, p.y, { color: 'white', size: c * 1.1, life: 460, rise: -c * 0.3 });
        }
      }
    })());
    await Promise.all(jobs);
    await this.wait(DROP_HOLD_MS);
    this.refreshGlass();
  }

  /** おじゃまが落ちてくる直前の警告: 画面の縁の赤い光・盤面の小さな揺れ・警告音（文字は出さない） */
  garbageWarn(count, sum, heavy = false) {
    this.sfx?.garbageIncoming?.(count, sum);
    if (reducedMotion()) return;
    this.ojFlash.animate([{ opacity: 0 }, { opacity: heavy ? 1 : 0.8, offset: 0.18 }, { opacity: 0.35, offset: 0.55 }, { opacity: 0 }], { duration: DROP_WARN_MS + 500, easing: 'ease-out' });
    this.shake(heavy ? 3.5 : 2, 360);
  }

  /** 着地した場所から広がる衝撃の輪（rotWrap の座標 p を中心に、直径 size px まで） */
  impactRing(p, size) {
    const el = document.createElement('div');
    el.className = 'oj-ring';
    el.style.cssText = `left:${p.x - size / 2}px;top:${p.y - size / 2}px;width:${size}px;height:${size}px;`;
    this.addFx(this.fx2, el, 560);
  }

  /**
   * 対戦: 連鎖が 1 つ進むごとに、盤面のおじゃまに「−k」を出す（k = ここまでの連鎖の数。このターンの終わりに、数字が k 減る: garbageChip）
   */
  garbageTick(chip, k) {
    if (!chip) return;
    for (const { block } of [...chip.changed, ...chip.removed]) showGarbageTick(this.els.get(block.id), k);
  }

  /**
   * 自分の連鎖でおじゃまの数字が減る（chip = Game.chipGarbage の結果）。数字がぽんと弾んで変わり、0 になったものは砕けて消える
   */
  garbageChip(chip) {
    if (!chip) return;
    for (const { block } of [...chip.changed, ...chip.removed]) clearGarbageTick(this.els.get(block.id));
    for (const { block, n } of chip.changed) {
      const el = this.els.get(block.id);
      if (!el) continue;
      this.setGarbageNum(el, n);
      if (!reducedMotion()) el.__num?.animate([{ scale: '1' }, { scale: '1.6', offset: 0.35 }, { scale: '1' }], { duration: 360, easing: 'cubic-bezier(.3,1.5,.5,1)' });
    }
    if (chip.changed.length) this.sfx?.garbageChip?.(chip.changed.length);
    chip.removed.forEach(({ block, x, r }, i) => {
      const el = this.els.get(block.id);
      if (!el) return;
      this.setGarbageNum(el, 0);
      this.later(() => {
        if (this.els.get(block.id) !== el) return;
        el.classList.add('fly');
        this.view3d?.fly(block.id);
        if (!reducedMotion() && this.q >= 0.5) {
          const p = this.cellCenter(this.pos(x, r));
          this.shardLayer.burst(p.x, p.y, ['garbage'], 4, this.cell * 0.3, this.cell * 2.6, { life: 0.55 });
          this.sparkLayer.twinkle(p.x, p.y, { color: 'white', size: this.cell * 0.8, life: 420 });
        }
        this.later(() => { if (this.els.get(block.id) === el) this.removeEl(block.id); }, 220);
      }, i * 70);
    });
    if (chip.removed.length) { this.sfx?.garbageBreak?.(chip.removed.length); this.later(() => this.refreshGlass(), chip.removed.length * 70 + 260); }
  }

  /** 盤面が揺れる（強さ px, 長さ ms） */
  shake(power = 4, dur = 220) {
    if (reducedMotion()) return;
    const frames = [];
    for (let k = 0; k < 7; k++) {
      const f = power * (1 - k / 7);
      frames.push({ translate: `${(Math.random() - 0.5) * 2 * f}px ${(Math.random() - 0.5) * 2 * f}px` });
    }
    frames.push({ translate: '0 0' });
    this._shake?.cancel();
    this._shake = this.wrap.animate(frames, { duration: dur, easing: 'ease-out' });
    this.view3d?.invalidate(dur + 40);
  }

  /** ゴールの近くに得点が浮かぶ */
  floatScore(value, chain = 1) {
    const q = this.cellCenter(this.goalPos());
    const d = document.createElement('div');
    d.className = 'float-score' + (chain >= 5 ? ' hot' : chain >= 3 ? ' warm' : '');
    d.textContent = '+' + value.toLocaleString('en-US');
    d.style.left = q.x + 'px'; d.style.top = q.y - this.cell * 0.6 + 'px';
    this.addFx(this.fx2, d, 900);
  }

  /** 連続発動（COMBO）の表示。盤面の上に金色の文字 */
  showCombo(n) {
    const el = this.comboPop = fresh(this.comboPop);
    el.innerHTML = `COMBO<b>${n}</b>`;
    el.className = `combo-pop show${n >= 5 ? ' hot' : ''}`;
  }

  /** コンボが続くほど背景が強く光り、色が入れ替わる（0 = なし … 1 = 最大） */
  setFever(level) {
    setVeil(this.feverEl, level);
    this.feverEl.classList.toggle('max', level >= 1);
  }

  /** 盤面の上に出る大きな文字（Chain・NEW BEST など）。COMBO と同じ場所なので、出ていたら先に消す */
  showText(html, cls = '') {
    if (this.comboPop.classList.contains('show')) this.comboPop.animate([{ opacity: 0 }], { duration: 120, fill: 'forwards' });
    const el = this.pop = fresh(this.pop);
    el.innerHTML = html;
    // 大きい文字は1文字ずつ、順にぽんと落ちてくる（説明の小さい文字はそのあと下から）。重いときは文字ごと出す
    let i = 0;
    if (this.q >= 0.6) for (const node of [...el.childNodes]) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const frag = document.createDocumentFragment();
      for (const ch of node.textContent) {
        const s = document.createElement('span');
        s.className = 'ch';
        s.textContent = ch === ' ' ? '\u00a0' : ch;
        s.style.setProperty('--i', i++);
        frag.appendChild(s);
      }
      node.replaceWith(frag);
    }
    el.style.setProperty('--n', i);
    el.className = `pop show ${cls}`;
  }

  reset() {
    this.gen++;                                              // 再生中の発動はここで打ち切る
    this.sfx?.stop();
    this.clearCelebration();
    for (const timer of [...this.fxTimers]) this.cancelFxTimer(timer);
    for (const a of this.wrap.getAnimations({ subtree: true })) a.cancel();
    this.pausedAnimations.clear();
    for (const w of [...this.waiters]) w();
    for (const el of this.els.values()) this.detachGlass(el);
    this.glassLayer?.replaceChildren();
    this.blockLayer.innerHTML = '';
    this.fxLayer.replaceChildren(this.rimFx.el);
    this.shardLayer.clear();
    this.sparkLayer.clear();
    this.rims.clear();
    this.fx2.replaceChildren(this.fxTop.el);
    for (const d of this.tints?.values() ?? []) { d.__anim?.cancel(); this.cancelFxTimer(d.__t); }
    this.hintLayer.innerHTML = '';
    this.clearAnnotations();
    this.setFever(0);
    this.setDanger(0);
    this.els.clear();
    this.manual.clear();
    this.setRush(false);
    this.clearPreview();
    this.view3d?.reset();
  }
}

/**
 * おじゃまの「−k」（連鎖の途中、このターンの終わりに減る数）。盤面と一緒に回らないよう立てた枠の中で、数字の少し上に出す。
 * 対戦の相手の盤面（opp-board.js）も同じ
 */
export function showGarbageTick(el, k) {
  if (!el) return;
  let t = el.__tick;
  if (!t) {
    const wrap = document.createElement('i');
    wrap.className = 'gtick-wrap';
    t = document.createElement('b');
    t.className = 'gtick';
    wrap.appendChild(t);
    el.appendChild(wrap);
    el.__tick = t;
    el.classList.add('ticking');
  }
  t.textContent = `−${k}`;
  if (!reducedMotion()) t.animate([{ scale: '.3', opacity: 0 }, { scale: '1.3', opacity: 1, offset: 0.5 }, { scale: '1' }], { duration: 280, easing: 'cubic-bezier(.3,1.5,.5,1)' });
}
export function clearGarbageTick(el) {
  if (!el?.__tick) return;
  el.__tick.parentElement.remove();
  el.__tick = null;
  el.classList.remove('ticking');
}

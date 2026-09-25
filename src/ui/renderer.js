export const ROTATION = 225; // deg。左上の直角が真下に来る
import { SIZE, isInside, ANIM, lineCells } from '../core/constants.js?v=202609252141';
import { Shards } from './shards.js?v=202609252141';

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
/** Web Animations の keyframes に、CSS の animation-timing-function と同じく区間ごとの easing を付ける */
const eased = (frames, easing) => frames.map((f, i) => (i < frames.length - 1 ? { easing, ...f } : f));
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 2.2);
/** easeInOut の逆関数（進んだ割合 y になる時刻の割合） */
const easeInOutInv = (y) => (y < 0.5 ? Math.sqrt(y / 2) : 1 - Math.sqrt((1 - y) * 2) / 2);
/** ブロックと同じ7色 */
const COLORS = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * 描画とアニメーションだけを担当（ルールは持たない）。
 * 画面座標 (x, r): x=0 左端…7 右端, r=0 上端…7 下端。
 * 縦列は r=8 の行（盤面の下）を右へ、横列は x=8 の列（盤面の右）を下へ流れ、(8,8) のゴールへ入る。
 */
export class Renderer {
  constructor(sfx) {
    this.sfx = sfx;
    // 必要な要素が HTML に無くても（古い HTML がキャッシュされている等）自前で作る
    const need = (id, cls, parent = 'playfield') => {
      if (document.getElementById(id)) return;
      const d = document.createElement('div');
      d.id = id; d.className = cls;
      document.getElementById(parent).appendChild(d);
    };
    ['wellLayer', 'hiLayer', 'blockLayer', 'hintLayer', 'ghostLayer', 'fxLayer'].forEach((id) => need(id, 'layer'));
    need('lane', 'lane'); need('laneRow', 'lane'); need('goal', 'goal'); need('pop', 'pop');
    this.pf = document.getElementById('playfield');
    this.wellLayer = document.getElementById('wellLayer');
    this.hiLayer = document.getElementById('hiLayer');
    this.blockLayer = document.getElementById('blockLayer');
    this.ghostLayer = document.getElementById('ghostLayer');
    this.hintLayer = document.getElementById('hintLayer');
    this.fxLayer = document.getElementById('fxLayer');
    // 消える列のハイライトは既存ブロックの上に重ねる（下にあると隠れて見えない）
    this.blockLayer.after(this.hiLayer);
    // マスに色が満ちる演出（空いたマスの中に塗るので、ブロックより下・マスより上）
    this.tintLayer = document.createElement('div');
    this.tintLayer.className = 'layer';
    this.wellLayer.after(this.tintLayer);
    this.lane = document.getElementById('lane');
    this.laneRow = document.getElementById('laneRow');
    this.goal = document.getElementById('goal');
    this.pop = document.getElementById('pop');
    // 盤面は直角が下に来るよう 225° 回転して表示する。回転しない外枠 wrap に入れ、
    // 文字（連鎖表示）は wrap 側に置いて回転させない
    this.wrap = document.getElementById('rotWrap');
    if (!this.wrap) {
      this.wrap = document.createElement('div');
      this.wrap.id = 'rotWrap';
      this.wrap.className = 'rot-wrap';
      this.pf.parentNode.insertBefore(this.wrap, this.pf);
      this.wrap.appendChild(this.pf);
    }
    this.wrap.appendChild(this.pop);
    // 回転しない演出用のレイヤー（浮かぶ得点など、画面の上下が必要なもの）
    this.fx2 = document.createElement('div');
    this.fx2.className = 'layer fx2';
    this.wrap.appendChild(this.fx2);
    // ゴールから飛び散る宝石のかけら（色ごとに1回だけ描いた小さな絵を貼って動かす）
    this.shardLayer = new Shards(this.fx2);
    this.comboPop = document.createElement('div');
    this.comboPop.className = 'combo-pop';
    this.wrap.appendChild(this.comboPop);
    // ピンチのときの画面の縁と、コンボが続くほど明るくなる背景
    this.dangerEl = document.getElementById('danger') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'danger' }));
    this.feverEl = document.getElementById('fever') || document.body.insertBefore(Object.assign(document.createElement('div'), { id: 'fever' }), document.body.firstChild);
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
    this.els = new Map();     // blockId -> element
    this.manual = new Set();  // 手動制御中
    this.cell = 40;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /* ---------- レイアウト ---------- */
  layout() {
    const stage = this.wrap.parentElement.getBoundingClientRect();
    const sw = Math.min(stage.width || window.innerWidth, 560);
    const sh = stage.height || window.innerHeight - 380;
    // 盤面をできるだけ大きく: 見えている範囲（左右の番号「8」の外側まで、ゴール上端〜直角の先端まで）が
    // ステージにぴったり収まる最大のマスの大きさにする
    const EXT_UP = 8.99, EXT_DOWN = 8.55;                     // 斜辺の中心線から上下に見えている範囲（h 単位）
    const SPAN_W = 11.62;                                     // 左右の番号を含めた横幅（マス単位）
    const SPAN_H = (EXT_UP + EXT_DOWN) / Math.SQRT2;          // 縦幅（マス単位）
    const cell = Math.max(16, Math.floor(Math.min((sw - 4) / SPAN_W, (sh - 4) / SPAN_H)));
    const k = cell / this.cell;
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
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
    this.drawStatic();
    // ブロックは今見えている位置のまま大きさだけ合わせる（盤面に合わせると、再生中のブロックが最後の位置へ飛んでしまう）。
    // 位置はどれもマスの大きさに比例するので、比で掛ければよい
    if (k !== 1) for (const el of this.els.values()) if (el.__pos) this.setPos(el, { x: el.__pos.x * k, y: el.__pos.y * k }, 0);
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
    this.wellLayer.innerHTML = '';
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
        this.wellLayer.appendChild(d);
        this.wells.set(`${x},${r}`, d);
        const t = document.createElement('div');
        t.className = 'cell well-tint';
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
      this.blockLayer.appendChild(el);
      this.els.set(block.id, el);
    }
    return el;
  }
  setPos(el, p, dur = 0, ease = '') {
    el.style.setProperty('--t', dur + 'ms');
    el.style.setProperty('--e', ease || 'cubic-bezier(.2,.8,.3,1)');
    el.style.transform = `translate(${p.x}px,${p.y}px)`;
    el.__pos = p;
  }
  removeEl(id) {
    this.els.get(id)?.remove();
    this.els.delete(id);
    this.manual.delete(id);
  }

  bindBoard(board) { this._board = board; this.syncBoard(board, 0); }

  syncBoard(board, dur = 0, ease = '') {
    this._board = board;
    const alive = new Set();
    for (const { block, x, r } of board.entries()) {
      alive.add(block.id);
      const el = this.ensureEl(block);
      if (!this.manual.has(block.id)) this.setPos(el, this.pos(x, r), dur, ease);
    }
    for (const id of [...this.els.keys()]) if (!alive.has(id) && !this.manual.has(id)) this.removeEl(id);
  }

  /** 置いた直後の着地演出: ブロックがぽよんと弾み、盤面が小さく沈む（光や粒は出さない） */
  popIn(placed) {
    placed.forEach(({ block, x, r }, i) => {
      const el = this.ensureEl(block);
      this.setPos(el, this.pos(x, r), 0);
      el.classList.remove('pop-in');
      void el.offsetWidth;
      el.style.setProperty('--d', i * 18 + 'ms');
      el.classList.add('pop-in');
      clearTimeout(el.__landT);
      el.__landT = setTimeout(() => el.classList.remove('pop-in'), 420 + i * 18);
    });
    this.bounce([[0, 1], [0.35, 1.008], [0.7, 0.998], [1, 1]], 240);
  }

  /* ---------- ドラッグ中のプレビュー ---------- */
  /**
   * 仮置きのプレビュー。消える列は既存ブロックごと「持っているピースの色」に塗り替えて光らせ、
   * その列の番号とゴールも光らせる（ここに置けば消える、という期待を先に見せる）。
   */
  showPreview(piece, ox, oy, clearCells, chainCount, lines = []) {
    const c = this.cell;
    const key = `${ox},${oy},${chainCount}`;
    const fresh = key !== this._pvKey;
    this._pvKey = key;
    this.ghostLayer.innerHTML = '';
    this.hiLayer.innerHTML = '';
    const willClear = clearCells.length > 0;
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `cell ghost c-${piece.color}` + (willClear ? ' strong' : '');
      d.style.transform = `translate(${(ox + cc.x) * c}px,${(oy + cc.y) * c}px)`;
      this.ghostLayer.appendChild(d);
    }
    // 斜辺側の端から順に光が走り込むよう、少しずつ遅らせる
    const seen = new Set();
    for (const { x, r } of clearCells) {
      const k = `${x},${r}`;
      if (seen.has(k)) continue;
      seen.add(k);
      const d = document.createElement('div');
      d.className = `cell hi c-${piece.color}` + (fresh ? ' enter' : '');
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      d.style.setProperty('--d', (x + r) * 14 + 'ms');
      this.hiLayer.appendChild(d);
    }
    this.litLines(lines, piece.color);
    this.goal.classList.toggle('ready', willClear);
  }
  /** 発動するラインの番号を光らせる */
  litLines(lines, color) {
    for (const el of this.numEls?.values() ?? []) el.classList.remove('lit');
    for (const { kind, n } of lines) {
      const el = this.numEls?.get(kind + n);
      if (!el) continue;
      el.className = `lane-num lit c-${color}`;
    }
  }
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
    this.litLines([]);
    this.goal.classList.remove('ready');
  }

  /**
   * 発動の直前の「溜め」: 満杯になったラインのブロック stack がぎゅっと縮み、ラインの番号が弾む。
   * （盤面 this._board は連鎖の最後まで進んだ状態なので、そこからラインのブロックを探してはいけない）
   */
  async charge(kind, n, stack, ms = 150) {
    if (this.rush) return;
    for (const b of stack) {
      const a = this.els.get(b.id)?.animate([{ scale: '1' }, { scale: '.9' }], { duration: ms, easing: 'ease-in', fill: 'forwards' });
      if (a) a.onfinish = () => a.cancel();
    }
    this.numEls?.get(kind + n)?.animate([{ scale: '1' }, { scale: '1.5' }, { scale: '1' }], { duration: ms + 160, easing: 'ease-out' });
    await this.wait(ms);
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
    this.dangerEl.style.opacity = Math.max(0, Math.min(1, level));
    this.dangerEl.classList.toggle('off', !(level > 0));
  }

  /* ---------- ライン発動（マンカラ） ---------- */
  goalPos() { return this.pos(SIZE, SIZE); }

  /** 演出用の要素を layer に足し、ms 後に消す */
  addFx(layer, el, ms) {
    layer.appendChild(el);
    setTimeout(() => el.remove(), ms);
  }

  /** スナップショット Map<id,{x,r,color}> の位置へ全ブロックを即座に合わせる（載っていないブロックは触らない） */
  applySnapshot(snap) {
    for (const [id, { x, r, color }] of snap) {
      if (this.manual.has(id)) continue;
      this.setPos(this.ensureEl({ id, color }), this.pos(x, r), 0);
    }
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
   *  連鎖が進むほど速く再生する。
   */
  async playStep(step, speed = 1) {
    const { kind, n: N, stack, chain, before, after } = step;
    const gen = this.gen;                                    // 途中でリスタートしたら、古い盤面の続きは描かない
    const cellT = ANIM.step / speed;                         // 1マスあたりの時間
    const F = kind === 'col' ? (x, r) => ({ x, r }) : (x, r) => ({ x: r, r: x });   // 画面 <-> 縦列の座標
    const P = (fx, fr) => { const q = F(fx, fr); return this.pos(q.x, q.r); };
    const src = SIZE - N;
    const els = stack.map((b) => { this.manual.add(b.id); const el = this.ensureEl(b); el.classList.add('travel'); return el; });

    // 1) 列車（9マス）: 経路上の距離 s -> 位置。s<=8 は列の中を下へ、s>8 は通路を右へ
    const along = (s) => (s <= SIZE ? P(src, s) : P(src + (s - SIZE), SIZE));
    const start = stack.map((_, k) => N - 1 - k);           // slot k の r = N-1-k
    const trainT = 9 * cellT;
    if (!this.rush) {
      this.sfx?.sink();
      this.lineBlast(kind, N, stack[0]?.color, chain, stack, before);
      this.wake(kind, N, stack[0]?.color, trainT);
    }
    let lastCell = -1;
    await this.tween(trainT, (t) => {
      const u = 9 * easeInOut(t / trainT);
      els.forEach((el, k) => this.setPos(el, along(start[k] + u), 0));
      const c = Math.floor(u);
      if (c !== lastCell) {
        lastCell = c;
        if (c > 0 && c < 9 && !this.rush && this.timeScale <= 1.5) this.sfx?.step(c);     // 速めている間は刻みの音を鳴らさない
      }
    });
    if (gen !== this.gen) return;

    // 先頭がゴールへ
    this.goalIn(stack[0], chain);

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
    if (!this.rush) this.bounce([[0, 1], [0.3, 1.012], [0.6, 0.997], [1, 1]], 220);
  }

  /** 配られたブロックがラインの中で止まった: ぽよんと弾み、小さな音 */
  settle(el, p, color, i = 0) {
    if (this.rush) return;
    el.animate([{ scale: '1.18 .82' }, { scale: '.94 1.06', offset: 0.45 }, { scale: '1' }], { duration: 260, easing: 'ease-out' });
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
      el.style.setProperty('--t', '0ms');
      if (this.rush) { this.removeEl(block.id); continue; }
      el.classList.add('fly');
      setTimeout(() => this.removeEl(block.id), 220);
    }
    if (this.rush) return;
    const color = list[0].color;
    this.hitGoal(chain, color);
    this.shatter(color, 3 + Math.min(chain, 3) + Math.min(list.length - 1, 2));
  }

  /** ゴールがぽんと弾み、中の面が入ったブロックの色で満ちて引いていく（光らせない） */
  hitGoal(chain, color) {
    this._goalHit?.cancel();
    const k = Math.min(chain, 8);
    this._goalHit = this.goal.animate(eased([
      { transform: 'none' },
      { transform: `scale(${1.14 + k * 0.012})`, offset: 0.35 },
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
    this.sfx?.goal(chain);
  }

  /** ゴールから宝石のかけら（ブロックと同じ塗り・同じ向き）が n 個はじけ、重力で落ちていく（3個に1個はほかの色） */
  shatter(color, n) {
    if (reducedMotion() || this.q < 0.6) return;
    n = Math.max(2, Math.round(n * this.q));
    const q = this.cellCenter(this.goalPos()), c = this.cell;
    const colors = Array.from({ length: n }, (_, i) => (i % 3 === 2 ? COLORS[Math.floor(Math.random() * COLORS.length)] : color));
    this.shardLayer.burst(q.x, q.y, colors, n, c * 0.46, c * 4.6);
  }

  /**
   * 発動したラインの空いたマスに、ブロックの色が満ちて引いていく（列車が通り過ぎた跡）。
   * ブロックが抜けた瞬間から、通路と反対側の端から順に
   */
  wake(kind, n, color, trainT) {
    if (this.q < 0.55) return;
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
    const d = this.tints?.get(`${x},${r}`);
    if (!d) return;
    d.__anim?.cancel();
    clearTimeout(d.__t);
    d.__t = setTimeout(() => { d.className = `cell well-tint c-${color}`; }, delay);
    // 半透明にすると背景の紺と混ざって濁るので、濃さは変えずにマスの中心から大きさだけで満ちて引く
    d.__anim = d.animate([{ scale: '0' }, { scale: '1.06', offset: 0.26 }, { scale: '1', offset: 0.4 }, { scale: '1', offset: 0.6 }, { scale: '0' }],
      { duration: life, delay, easing: 'ease-in-out' });
  }

  /** 盤面がぽんと弾む（[offset, scale] の並び, ms）。クラスの付け外しと強制レイアウトを使わない */
  bounce(frames, dur) {
    this._bounce?.cancel();
    this._bounce = this.pf.animate(eased(frames.map(([offset, v]) => ({ offset, scale: `${v}` })), 'ease-out'), { duration: dur });
  }

  /** マス中心のローカル px -> rotWrap 内の座標 */
  cellCenter(p) { return this.localToWrap(p.x + this.cell / 2, p.y + this.cell / 2); }

  /** ラインの発動: 盤面が揺れ、大きな連鎖では画面がぐっと寄る（光や粒は出さない）。3連鎖目からは盤面のブロックが波打つ */
  lineBlast(kind, n, color = 'yellow', chain = 1, moving = [], before = null) {
    this.shake(Math.min(2 + chain * 1.2, 11), 180 + Math.min(chain, 8) * 20);
    if (chain >= 4) this.punch(Math.min(0.01 + chain * 0.003, 0.035));
    if (chain >= 3 && this.q >= 0.75 && before) this.ripple(before, kind, SIZE - n, Math.min(0.04 + chain * 0.01, 0.1), new Set(moving.map((b) => b.id)));
  }

  /**
   * 盤面のブロックが、発動したラインから外へ向かって順にぽよんと沈んで戻る（波紋を線ではなく動きで）。
   * 動かすのは各ブロックの scale だけ（合成だけで済む）
   */
  ripple(snap, kind, at, amount, skip = new Set()) {
    if (reducedMotion()) return;
    // snap = この発動の直前に見えている盤面（this._board は連鎖の最後まで進んだ状態なので使わない）
    for (const [id, { x, r }] of snap) {
      if (skip.has(id)) continue;
      const el = this.els.get(id);
      if (!el) continue;
      const dist = Math.abs((kind === 'col' ? x : r) - at);
      el.animate([{ scale: '1' }, { scale: `${1 - amount}` }, { scale: `${1 + amount * 0.35}` }, { scale: '1' }],
        { duration: 300, delay: 40 + dist * 45, easing: 'ease-in-out' });
    }
  }

  /** 画面が一瞬ぐっと寄って戻る（大きな連鎖の衝撃）。scale だけを動かす */
  punch(amount = 0.02, dur = 240) {
    if (reducedMotion()) return;
    this._punch?.cancel();
    this._punch = this.wrap.animate([{ scale: `${1 + amount}` }, { scale: '1' }], { duration: dur, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }

  /** 盤面の外接四角（rotWrap の座標）。画面全体の演出を盤面の中心から始めるため */
  boardBox() {
    const c = this.cell;
    const pts = [[0, 0], [SIZE, 0], [0, SIZE]].map(([x, r]) => this.localToWrap(x * c, r * c));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  /** 全消し（盤面の中の分）: 盤面がぐっと寄って戻り、空になったマスに盤面の中心から7色が順に満ちて広がる。画面全体の演出は scenes.allClear */
  allClearBlast() {
    this.punch(0.045, 320);
    const cx = (SIZE - 1) / 3, cr = (SIZE - 1) / 3;             // 直角三角形の盤面の重心あたり
    for (let x = 0; x < SIZE; x++) for (let r = 0; r < SIZE; r++) {
      if (!isInside(x, r)) continue;
      const ring = Math.round(Math.hypot(x - cx, r - cr));
      this.tintCell(x, r, COLORS[ring % COLORS.length], 60 + ring * 70, 620);
    }
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

  /** コンボが続くほど背景が強く光る（0 = なし … 1 = 最大） */
  setFever(level) {
    this.feverEl.style.opacity = Math.max(0, Math.min(1, level));
    this.feverEl.classList.toggle('max', level >= 1);
    this.feverEl.classList.toggle('off', !(level > 0));
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
    for (const w of [...this.waiters]) w();
    this.blockLayer.innerHTML = '';
    this.fxLayer.innerHTML = '';
    this.shardLayer.clear();
    this.fx2.innerHTML = '';
    for (const d of this.tints?.values() ?? []) { d.__anim?.cancel(); clearTimeout(d.__t); }
    this.hintLayer.innerHTML = '';
    this.setFever(0);
    this.setDanger(0);
    this.els.clear();
    this.manual.clear();
    this.setRush(false);
    this.clearPreview();
  }
}

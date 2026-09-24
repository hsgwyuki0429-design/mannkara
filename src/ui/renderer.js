export const ROTATION = 225; // deg。左上の直角が真下に来る
import { SIZE, isInside, ANIM, lineCells } from '../core/constants.js?v=202609240336';
import { Particles, RAINBOW } from './particles.js?v=202609240336';

/** 盤面全体を画面の縦方向にだけ少し伸ばす率（斜辺の中心線が基準） */
const STRETCH_Y = 1.04;
/** 盤面の外（通路・ゴール）を画面上で斜辺側へ縮める率（縦に伸ばした後で 0.86 倍になるように） */
const LANE_SQUASH = 0.86 / STRETCH_Y;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * CSS アニメーションを最初から再生し直すため、要素を中身のない複製に差し替える。
 * （クラスを外して offsetWidth を読む方法は毎回ページ全体の強制レイアウトになり、連鎖中のカクつきの原因になる）
 */
/** '#rrggbb' → 'rgba(r,g,b,a)' */
const rgba = (hex, a) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  return m ? `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})` : `rgba(255,255,255,${a})`;
};
const fresh = (el) => { const n = el.cloneNode(false); el.replaceWith(n); return n; };
/** Web Animations の keyframes に、CSS の animation-timing-function と同じく区間ごとの easing を付ける */
const eased = (frames, easing) => frames.map((f, i) => (i < frames.length - 1 ? { easing, ...f } : f));
const easeInOut = (p) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2);
const easeOut = (p) => 1 - Math.pow(1 - p, 2.2);

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
    // 回転しない演出用のレイヤー（重力で落ちる破片・浮かぶ得点など、画面の上下が必要なもの）
    this.fx2 = document.createElement('div');
    this.fx2.className = 'layer fx2';
    this.wrap.appendChild(this.fx2);
    // 光の粒・破片・輪は数が多いので DOM ではなく1枚の canvas に描く（長い連鎖でカクつかないように）
    this.particles = new Particles(this.wrap);
    this.comboPop = document.createElement('div');
    this.comboPop.className = 'combo-pop';
    this.wrap.appendChild(this.comboPop);
    // 画面全体のフラッシュと、コンボが続くほど強くなる背景の光
    this.flashEl = document.getElementById('screenFlash') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'screenFlash' }));
    this.dangerEl = document.getElementById('danger') || document.body.appendChild(Object.assign(document.createElement('div'), { id: 'danger' }));
    this.feverEl = document.getElementById('fever') || document.body.insertBefore(Object.assign(document.createElement('div'), { id: 'fever' }), document.body.firstChild);
    const goalText = this.goal.querySelector('span');
    if (goalText) goalText.className = 'upright';
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
    this.particles.fit(wrapW, wrapH, cell * 2);          // ゴールの輪や飛び散る粒が届く範囲まで
    this.drawStatic();
    if (this._board) this.syncBoard(this._board, 0);
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

  /** 置いた直後の着地演出: ブロックが弾んで光り、マスに光の輪、細かい光の粒が散る */
  popIn(placed) {
    const c = this.cell;
    placed.forEach(({ block, x, r }, i) => {
      const el = this.ensureEl(block);
      this.setPos(el, this.pos(x, r), 0);
      el.classList.remove('pop-in');
      void el.offsetWidth;
      el.style.setProperty('--d', i * 18 + 'ms');
      el.classList.add('pop-in');
      clearTimeout(el.__landT);
      el.__landT = setTimeout(() => el.classList.remove('pop-in'), 420 + i * 18);
      const ring = document.createElement('div');
      ring.className = `cell land-ring c-${block.color}`;
      ring.style.transform = `translate(${x * c}px,${r * c}px)`;
      ring.style.animationDelay = i * 18 + 'ms';
      this.addFx(this.fxLayer, ring, 520);
    });
    // 光の粒（ピースの中心から）
    if (placed.length) {
      const mx = placed.reduce((a, p) => a + p.x, 0) / placed.length;
      const my = placed.reduce((a, p) => a + p.r, 0) / placed.length;
      const color = placed[0].block.color;
      const q = this.localToWrap((mx + 0.5) * c, (my + 0.5) * c);
      this.particles.sparks(q.x, q.y, color, 10, c);
      this.flareFx(q.x, q.y, color, c * 2.2, 300);
    }
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

  /** 発動の直前に、満杯になったラインが一瞬ぎゅっと光る「溜め」（期待を最高潮にしてから解放する） */
  async charge(kind, n, color, ms = 70) {
    const c = this.cell;
    const els = lineCells(kind, n).map(({ x, r }) => {
      const d = document.createElement('div');
      d.className = `cell charge c-${color}`;
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      this.fxLayer.appendChild(d);
      return d;
    });
    await delay(ms);
    els.forEach((d) => d.remove());
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

  /** requestAnimationFrame で duration ms の間 fn(t[ms]) を毎フレーム呼ぶ */
  tween(duration, fn) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const frame = (now) => {
        const t = Math.min(duration, now - t0);
        fn(t);
        if (t < duration) requestAnimationFrame(frame); else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

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
    const cellT = ANIM.step / speed;                         // 1マスあたりの時間
    const F = kind === 'col' ? (x, r) => ({ x, r }) : (x, r) => ({ x: r, r: x });   // 画面 <-> 縦列の座標
    const P = (fx, fr) => { const q = F(fx, fr); return this.pos(q.x, q.r); };
    const src = SIZE - N;
    const els = stack.map((b) => { this.manual.add(b.id); const el = this.ensureEl(b); el.classList.add('travel'); return el; });

    // 1) 列車（9マス）: 経路上の距離 s -> 位置。s<=8 は列の中を下へ、s>8 は通路を右へ
    const along = (s) => (s <= SIZE ? P(src, s) : P(src + (s - SIZE), SIZE));
    const start = stack.map((_, k) => N - 1 - k);           // slot k の r = N-1-k
    const trainT = 9 * cellT;
    this.sfx?.sink();
    this.lineBlast(kind, N, stack[0]?.color, chain);
    let lastCell = -1;
    await this.tween(trainT, (t) => {
      const u = 9 * easeInOut(t / trainT);
      els.forEach((el, k) => this.setPos(el, along(start[k] + u), 0));
      const c = Math.floor(u);
      if (c !== lastCell) {
        lastCell = c;
        if (c > 0 && c < 9) this.sfx?.step(c);
        const lead = along(start[0] + u);                  // 先頭のブロックが光の尾を引く
        this.trail(lead, stack[0].color);
      }
    });

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
    if (moves.length || goals.length) {
      await this.tween(enterT, (t) => {
        for (const m of moves) {
          const d = m.dist * easeOut(Math.min(1, t / (m.dist * cellT)));
          const r = m.from.fr - d;                           // 入ってくるブロックの位置（上へ進む）
          this.setPos(m.el, P(m.to.x, r), 0);
          // 押されるブロックは「入ってくるブロックの位置 - 最終的な相対距離」より手前には居られない
          for (const q of m.pushed) {
            const rr = Math.min(q.fromR, r - (m.to.r - q.toR));
            this.setPos(q.el, P(m.to.x, rr), 0);
            if (rr < q.fromR && !pushedSound.has(m)) { pushedSound.add(m); this.sfx?.push(chain); }
          }
        }
        for (const g of goals) {                             // 通路をそのまま右へ流れてゴール
          const d = g.k * easeOut(Math.min(1, t / (g.k * cellT)));
          this.setPos(g.el, P(SIZE - g.k + d, SIZE), 0);
        }
      });
    }
    if (goals.length) this.goalIn(goals.map((g) => g.b), chain);     // 同時に着くブロックの演出はまとめて1回
    for (const m of moves) { this.manual.delete(m.b.id); m.el.classList.remove('travel'); }
    this.applySnapshot(after);
    this.bounce([[0, 1], [0.3, 1.012], [0.6, 0.997], [1, 1]], 220);
  }

  /** ブロック（1個または同時に着く複数個）がゴールに入る。演出と音はまとめて1回 */
  goalIn(blocks, chain) {
    const list = Array.isArray(blocks) ? blocks : [blocks];
    for (const block of list) {
      const el = this.els.get(block.id);
      if (!el) continue;
      el.style.setProperty('--t', '0ms');
      el.classList.add('fly');
      setTimeout(() => this.removeEl(block.id), 220);
    }
    const color = list[0].color, more = Math.min(list.length - 1, 4), k = Math.min(chain, 8), c = this.cell;
    this.burst(this.goalPos(), color, 7 + Math.round(k * 1.5) + more * 2);
    this.shatter(this.goalPos(), color, 5 + Math.min(chain, 6) + more);
    this.wave(this.goalPos(), color);
    // 光: ゴールからフレアと光の筋、2連鎖目からは放射状の光線（連鎖が進むほど本数も長さも増える）
    const q = this.cellCenter(this.goalPos());
    this.flareFx(q.x, q.y, color, c * (2 + k * 0.35));
    this.particles.streaks(q.x, q.y, color, this.qn(6 + k), c, { speed: [6, 12] });
    if (chain >= 2 && this._raysChain !== chain) this._raysChain = chain, this.raysFx(q.x, q.y, color, { n: 8 + k, len: c * Math.min(1.6 + k * 0.1, 2.3), width: c * 0.42, life: 520 });   // canvas の上端で切れない長さまで
    this.hitGoal(chain);
  }

  hitGoal(chain) {
    this._goalHit?.cancel();
    const base = '0 0 6px rgba(34,211,214,.35),inset 0 0 6px rgba(34,211,214,.25)';
    this._goalHit = this.goal.animate(eased([
      { transform: 'none', boxShadow: base },
      { transform: 'scale(1.2)', boxShadow: '0 0 30px rgba(34,211,214,.95),inset 0 0 6px rgba(34,211,214,.25)', offset: 0.35 },
      { transform: 'none', boxShadow: base },
    ], 'ease-out'), { duration: 320 });
    this.sfx?.goal(chain);
  }

  /** 盤面がぽんと弾む（[offset, scale] の並び, ms）。クラスの付け外しと強制レイアウトを使わない */
  bounce(frames, dur) {
    this._bounce?.cancel();
    this._bounce = this.pf.animate(eased(frames.map(([offset, v]) => ({ offset, scale: `${v}` })), 'ease-out'), { duration: dur });
  }

  burst(p, color = 'yellow', n = 9) {
    const q = this.cellCenter(p);
    this.particles.burst(q.x, q.y, color, n, this.cell);
  }

  /** マス中心のローカル px -> rotWrap 内の座標 */
  cellCenter(p) { return this.localToWrap(p.x + this.cell / 2, p.y + this.cell / 2); }

  /** 発動したライン全体が白く光り、光の帯が走る */
  lineBlast(kind, n, color = 'yellow', chain = 1) {
    const c = this.cell;
    lineCells(kind, n).forEach(({ x, r }, i) => {
      const d = document.createElement('div');
      d.className = `cell line-flash c-${color}`;
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      d.style.animationDelay = i * 12 + 'ms';
      this.addFx(this.fxLayer, d, 460 + i * 12);
    });
    const beam = document.createElement('div');
    beam.className = `beam c-${color} ${kind}`;
    const fixed = (SIZE - n) * c;
    Object.assign(beam.style, kind === 'col'
      ? { left: fixed + 'px', top: 0, width: c + 'px', height: n * c + 'px' }
      : { left: 0, top: fixed + 'px', width: n * c + 'px', height: c + 'px' });
    this.addFx(this.fxLayer, beam, 420);
    // ラインの各マスから、ラインと直交する向き（両側）へ光の筋が飛び散る
    const pts = lineCells(kind, n).map(({ x, r }) => this.localToWrap((x + 0.5) * c, (r + 0.5) * c));
    const a = pts[0], b = pts[pts.length - 1];
    const perp = n > 1 ? Math.atan2(b.y - a.y, b.x - a.x) + Math.PI / 2 : Math.random() * Math.PI * 2;
    const per = this.q >= 0.7 ? [0, Math.PI] : this.q >= 0.4 ? [Math.random() < 0.5 ? 0 : Math.PI] : [];
    for (const q of pts) for (const side of per) {
      this.particles.streaks(q.x, q.y, color, 1, c, { dir: perp + side, spread: 1.2, speed: [3, 7], life: [280, 460], len: 0.8 });
    }
    if (chain >= 2) { const m = pts[pts.length >> 1]; this.flareFx(m.x, m.y, color, c * (1.4 + Math.min(chain, 8) * 0.2), 380); }
    this.shake(Math.min(2 + chain * 1.2, 11), 180 + Math.min(chain, 8) * 20);
    if (chain >= 3) this.flash(chain >= 6 ? 0.32 : 0.2, color);
    if (chain >= 4) this.punch(Math.min(0.01 + chain * 0.003, 0.035));
  }

  /**
   * 大きな光の1枚絵（フレア・光線）を使い回す。見た目（種類・色・本数）ごとに決まった大きさで1回だけ描き、
   * 位置・大きさ・回転はすべて transform で動かす（width や left を変えると描き直しになる）。
   * 使い終わったものは透明のまま置いておき、次に同じ見た目が要るときに使う
   */
  sprite(cls, color, vars = {}) {
    const key = cls + '|' + color + '|' + Object.values(vars).join(',');
    this.spritePool ??= new Map();
    const idle = this.spritePool.get(key) ?? [];
    this.spritePool.set(key, idle);
    let d = idle.pop();
    if (!d) {
      d = document.createElement('div');
      d.className = `${cls} c-${color}`;
      if (cls === 'fx-rays') d.style.backgroundImage = `url(${this.raysImage(color, vars)})`;
      this.fx2.appendChild(d);
    }
    d.__release = () => { if (d.isConnected) idle.push(d); };
    return d;
  }
  /**
   * 放射状の光線の画像（{ n: 本数, w: 1本の角度 deg }）を canvas に1回だけ描いて画像にする。
   * 中心の近くと外側へ向かって消えていくところまで描き込むので、CSS の mask は要らない（mask は合成が重い）
   */
  raysImage(color, { n, w }) {
    const key = color + '|' + n + '|' + w;
    this.raysUrls ??= new Map();
    if (this.raysUrls.has(key)) return this.raysUrls.get(key);
    const B = 160, dpr = Math.min(2, window.devicePixelRatio || 1), S = Math.round(B * dpr);
    const cv = document.createElement('canvas');
    cv.width = cv.height = S;
    const g = cv.getContext('2d'), col = this.particles.color(color), R = S / 2;
    g.translate(R, R);
    const grd = g.createRadialGradient(0, 0, 0, 0, 0, R);
    grd.addColorStop(0, rgba(col.hi, 0));
    grd.addColorStop(0.1, rgba(col.hi, 0.95));
    grd.addColorStop(0.3, rgba(col.hi, 0.85));
    grd.addColorStop(0.62, rgba(col.col, 0.4));
    grd.addColorStop(1, rgba(col.col, 0));
    g.fillStyle = grd;
    const half = (w * Math.PI) / 360;
    for (let i = 0; i < n; i++) {                       // 外へ向かって広がるくさび形
      const a = (Math.PI * 2 * i) / n;
      g.beginPath();
      g.moveTo(0, 0);
      g.arc(0, 0, R, a - half, a + half);
      g.closePath();
      g.fill();
    }
    // 芯: くさびの中心線を白っぽく細く
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = grd;
    g.globalAlpha = 0.5;
    for (let i = 0; i < n; i++) {
      const a = (Math.PI * 2 * i) / n;
      g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, R * 0.8, a - half * 0.3, a + half * 0.3); g.closePath(); g.fill();
    }
    const url = cv.toDataURL();
    this.raysUrls.set(key, url);
    return url;
  }

  /** 1枚絵を (x, y) を中心に、frames の [透明度, 拡大率, 回転deg, offset?] の順に動かして消す */
  playSprite(d, base, x, y, frames, life) {
    this._spriteAnims ??= new Set();
    const tf = (sc, rot) => `translate(${x - base / 2}px,${y - base / 2}px) rotate(${rot}deg) scale(${sc})`;
    // 区間ごとの easing: 広がり始めは素早く、消えていくところはゆっくり（全体に ease-out を掛けると早く消えすぎる）
    const a = d.animate(frames.map(([o, sc, rot, offset], i) => ({
      opacity: o, transform: tf(sc, rot), easing: i === 0 && frames.length > 2 ? 'ease-out' : 'cubic-bezier(.25,.6,.45,1)',
      ...(offset != null ? { offset } : {}),
    })), { duration: life });
    this._spriteAnims.add(a);
    a.onfinish = () => { this._spriteAnims.delete(a); d.__release(); };
  }

  /** 演出の量の目安（1 = 全部 … 0.25 = 最小限。遅い端末では自動で下がる） */
  get q() { return this.particles.quality; }
  /** n 個出したい粒を、演出の量に合わせて減らした数 */
  qn(n) { return Math.round(n * this.q); }

  /** ふわっと広がって消える大きな光（rotWrap 内の座標 x, y・直径 size px） */
  flareFx(x, y, color, size, life = 420, alpha = 0.75) {
    if (this.q < 0.4) return;
    const B = 96, d = this.sprite('fx-flare', color), k = size / B;
    this.playSprite(d, B, x, y, [[alpha, 0.45 * k, 0], [0, 1.2 * k, 0]], life);
  }

  /**
   * 中心から放射状に伸びる光線（n 本・長さ len px・太さ width px）。回りながら伸びて消える。
   * 光線は CSS の repeating-conic-gradient で1枚に描く
   */
  raysFx(x, y, color, { n = 12, len = 80, width = 14, life = 620, spin = 0.5, alpha = 0.8 } = {}) {
    if (this.q < 0.6 || matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const B = 160;
    // 本数は 12 / 16 / 20 本の3種類にまとめる（見た目の種類が少ないほど1枚絵を使い回せる）。太さは本数で決める
    n = n <= 13 ? 12 : n <= 17 ? 16 : 20;
    const w = { 12: 10, 16: 8, 20: 6 }[n];
    const d = this.sprite('fx-rays', color, { n, w });
    const k = (len * 2) / B, r0 = Math.random() * 360, r1 = r0 + (spin * 180) / Math.PI;
    this.playSprite(d, B, x, y, [[0, 0.55 * k, r0], [alpha, 0.62 * k, r0 + (r1 - r0) * 0.12, 0.12], [0, k, r1]], life);
  }

  /** 画面が一瞬ぐっと寄って戻る（大きな連鎖の衝撃）。scale だけを動かす */
  punch(amount = 0.02, dur = 240) {
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    this._punch?.cancel();
    this._punch = this.wrap.animate([{ scale: `${1 + amount}` }, { scale: '1' }], { duration: dur, easing: 'cubic-bezier(.2,.8,.3,1)' });
  }

  /** 盤面の外接四角（rotWrap の座標）。火の粉や花火を盤面の上に散らすため */
  boardBox() {
    const c = this.cell;
    const pts = [[0, 0], [SIZE, 0], [0, SIZE]].map(([x, r]) => this.localToWrap(x * c, r * c));
    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
  }

  /**
   * 連鎖の文字の後ろに回る光線（段階が上がるほど派手に。最高段階は虹色）。
   * 色は文字のグラデーションに合わせる（Good 緑 / Great 水色 / Excellent 金 / Amazing 桃紫 / Unbelievable 虹）
   */
  textBurst(tier) {
    const c = this.cell, x = this.wrapW / 2, y = this.wrap.clientHeight * 0.52 + c * 0.9;
    let colors = [['green'], ['cyan'], ['yellow', 'orange'], ['purple', 'red'], ['red', 'yellow', 'cyan', 'purple']][Math.min(tier, 5) - 1];
    if (this.q < 0.85) colors = colors.slice(0, 1 + (this.q >= 0.7));      // 重いときは重ねる枚数を減らす
    const alpha = 0.75 / Math.sqrt(colors.length);           // 重ねる枚数が多いほど1枚ずつは薄く（白く飛ばない）
    colors.forEach((color, i) => this.raysFx(x, y, color, {
      n: 10 + tier * 2, len: c * (2 + tier * 0.35), width: c * (0.5 + tier * 0.06), life: 700 + tier * 60, spin: i % 2 ? -0.6 : 0.6, alpha,
    }));
    this.flareFx(x, y, colors[0], c * (2.2 + tier * 0.35), 520);
    if (tier >= 4) this.particles.streaks(x, y, tier >= 5 ? RAINBOW[Math.floor(Math.random() * 7)] : 'yellow', this.qn(10 + tier * 2), c, { speed: [7, 13], life: [420, 700] });
  }

  /** コンボが続いている間、盤面から火の粉が立ちのぼる（level 0〜1） */
  embers(level) {
    if (level <= 0) return;
    const b = this.boardBox(), c = this.cell;
    const warm = ['orange', 'yellow', 'red'];
    const n = this.qn(2 + level * 6);
    const w = b.x1 - b.x0;
    for (let i = 0; i < n; i++) this.particles.embers(b.x0 + w * 0.15, b.y0, b.x1 - w * 0.15, b.y0 + (b.y1 - b.y0) * 0.6, warm[i % 3], 1, c);
  }

  /** 花火を n 発、盤面の上に少しずつ時間をずらして打ち上げる */
  fireworks(n = 5, gap = 140) {
    n = Math.max(2, this.qn(n));
    const gen = this.fxGen, b = this.boardBox(), c = this.cell;
    const top = this.cellCenter(this.goalPos()).y + c * 1.5;          // ゴールの少し下〜盤面の中ほどまで
    for (let i = 0; i < n; i++) {
      setTimeout(() => {
        if (gen !== this.fxGen) return;                     // リスタートしたら打ち切る
        const x = b.x0 + c * 1.5 + Math.random() * (b.x1 - b.x0 - c * 3);
        const y = top + Math.random() * (b.y0 + (b.y1 - b.y0) * 0.45 - top);
        const color = RAINBOW[(i * 3) % RAINBOW.length];
        this.flareFx(x, y, color, c * 3.2, 520);
        this.particles.firework(x, y, color, c);
        this.sfx?.step?.(3 + (i % 5));
      }, i * gap);
    }
  }

  /** 全消し: 虹色の光線が盤面の中心から回り、花火が連発する */
  allClearBlast() {
    const c = this.cell, b = this.boardBox();
    const x = (b.x0 + b.x1) / 2, y = (b.y0 + b.y1) / 2;
    ['red', 'yellow', 'green', 'cyan', 'purple'].forEach((color, i) => this.raysFx(x, y, color, {
      n: 12, len: c * 4.2, width: c * 0.7, life: 1100, spin: i % 2 ? -0.7 : 0.7,
    }));
    this.flareFx(x, y, 'yellow', c * 7, 800);
    [0, 160, 320].forEach((d, i) => setTimeout(() => this.particles.wave(x, y, RAINBOW[i * 2], c * 1.6), d));
    this.flash(0.3, 'yellow');
    this.punch(0.045, 320);
    this.fireworks(7, 150);
  }

  /** 流れる先頭ブロックが残す光の粒 */
  trail(p, color) {
    const q = this.cellCenter(p);
    this.particles.trail(q.x, q.y, color, this.cell);
  }

  /** ブロックの破片が弾け、重力で落ちていく */
  shatter(p, color, n = 6) {
    const q = this.cellCenter(p);
    this.particles.shatter(q.x, q.y, color, n, this.cell);
  }

  /** ゴールから広がる衝撃波の輪 */
  wave(p, color) {
    const q = this.cellCenter(p);
    this.particles.wave(q.x, q.y, color, this.cell);
  }

  /** 盤面が揺れる（強さ px, 長さ ms） */
  shake(power = 4, dur = 220) {
    if (matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const frames = [];
    for (let k = 0; k < 7; k++) {
      const f = power * (1 - k / 7);
      frames.push({ translate: `${(Math.random() - 0.5) * 2 * f}px ${(Math.random() - 0.5) * 2 * f}px` });
    }
    frames.push({ translate: '0 0' });
    this._shake?.cancel();
    this._shake = this.wrap.animate(frames, { duration: dur, easing: 'ease-out' });
  }

  /** 画面全体が一瞬白く光る */
  flash(strength = 0.25, color = 'yellow') {
    this.flashEl.className = `c-${color}`;
    this.flashEl.animate([{ opacity: strength }, { opacity: 0 }], { duration: 260, easing: 'ease-out' });
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

  /** 画面中央から紙吹雪（新記録など） */
  confetti(n = 40) {
    const colors = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];
    const cx = this.wrapW / 2, cy = this.topY * 0.8, c = this.cell;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = `confetti c-${colors[i % colors.length]}`;
      d.style.left = cx + 'px'; d.style.top = cy + 'px';
      this.fx2.appendChild(d);
      const a = Math.random() * Math.PI * 2, sp = c * (3 + Math.random() * 5);
      const vx = Math.cos(a) * sp, vy = Math.sin(a) * sp - c * 5, g = c * 12, T = 1.2 + Math.random() * 0.5;
      const rot = (Math.random() - 0.5) * 1440;
      const frames = [];
      for (let k = 0; k <= 10; k++) {
        const t = (T * k) / 10;
        frames.push({ transform: `translate(${vx * t}px,${vy * t + 0.5 * g * t * t}px) rotate(${rot * t}deg) rotateX(${rot * t * 2}deg)`,
          opacity: k < 7 ? 1 : 1 - (k - 6) / 4 });
      }
      d.animate(frames, { duration: T * 1000, easing: 'linear' }).onfinish = () => d.remove();
    }
  }

  /** 連続発動（COMBO）の表示。盤面の上に炎色の文字 */
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

  /** 中央に出る大きな文字（Combo / Chain） */
  showText(html, cls = '') {
    const el = this.pop = fresh(this.pop);
    el.innerHTML = html;
    el.className = `pop show ${cls}`;
  }

  reset() {
    this.blockLayer.innerHTML = '';
    this.fxLayer.innerHTML = '';
    this.fx2.innerHTML = '';
    this.hintLayer.innerHTML = '';
    this.particles.clear();
    this.fxGen = (this.fxGen || 0) + 1;
    for (const a of this._spriteAnims ?? []) a.finish();
    this.setFever(0);
    this.setDanger(0);
    this.els.clear();
    this.manual.clear();
    this.clearPreview();
  }
}

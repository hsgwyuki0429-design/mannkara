export const ROTATION = 225; // deg。左上の直角が真下に来る
import { SIZE, isInside, ANIM, lineCells } from '../core/constants.js?v=202609230947';

/** 盤面全体を画面の縦方向にだけ少し伸ばす率（斜辺の中心線が基準） */
const STRETCH_Y = 1.04;
/** 盤面の外（通路・ゴール）を画面上で斜辺側へ縮める率（縦に伸ばした後で 0.86 倍になるように） */
const LANE_SQUASH = 0.86 / STRETCH_Y;

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));
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
    ['wellLayer', 'hiLayer', 'blockLayer', 'ghostLayer', 'fxLayer'].forEach((id) => need(id, 'layer'));
    need('lane', 'lane'); need('laneRow', 'lane'); need('goal', 'goal'); need('pop', 'pop');
    this.pf = document.getElementById('playfield');
    this.wellLayer = document.getElementById('wellLayer');
    this.hiLayer = document.getElementById('hiLayer');
    this.blockLayer = document.getElementById('blockLayer');
    this.ghostLayer = document.getElementById('ghostLayer');
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
      this.fxLayer.appendChild(ring);
      setTimeout(() => ring.remove(), 520);
    });
    // 光の粒（ピースの中心から）
    if (placed.length) {
      const mx = placed.reduce((a, p) => a + p.x, 0) / placed.length;
      const my = placed.reduce((a, p) => a + p.r, 0) / placed.length;
      const color = placed[0].block.color;
      for (let k = 0; k < 10; k++) {
        const d = document.createElement('div');
        d.className = `spark c-${color}`;
        const a = (Math.PI * 2 * k) / 10 + Math.random() * 0.5;
        const dist = c * (0.9 + Math.random() * 0.9);
        d.style.setProperty('--dx', Math.cos(a) * dist + 'px');
        d.style.setProperty('--dy', Math.sin(a) * dist + 'px');
        d.style.left = (mx + 0.5) * c + 'px';
        d.style.top = (my + 0.5) * c + 'px';
        this.fxLayer.appendChild(d);
        setTimeout(() => d.remove(), 560);
      }
    }
    this.pf.classList.remove('land'); void this.pf.offsetWidth; this.pf.classList.add('land');
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
    if (chainCount >= 1 && willClear) {
      const b = document.createElement('div');
      b.className = 'chain-badge' + (chainCount >= 3 ? ' hot' : '');
      b.innerHTML = `<span class="upright">${chainCount >= 2 ? `⚡${chainCount} CHAIN` : 'CLEAR'}</span>`;
      b.style.left = (ox + piece.width / 2) * c + 'px';
      b.style.top = (oy + piece.height / 2) * c + 'px';
      this.ghostLayer.appendChild(b);
    }
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
  }

  /* ---------- ライン発動（マンカラ） ---------- */
  goalPos() { return this.pos(SIZE, SIZE); }

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
    goals.forEach((g) => this.goalIn(g.b, chain));
    for (const m of moves) { this.manual.delete(m.b.id); m.el.classList.remove('travel'); }
    this.applySnapshot(after);
    this.pf.classList.remove('thump'); void this.pf.offsetWidth; this.pf.classList.add('thump');
  }

  goalIn(block, chain) {
    const el = this.els.get(block.id);
    if (el) {
      el.style.setProperty('--t', '0ms');
      el.classList.add('fly');
      setTimeout(() => this.removeEl(block.id), 220);
    }
    this.burst(this.goalPos(), block.color, 9 + Math.min(chain, 8) * 2);
    this.shatter(this.goalPos(), block.color, 5 + Math.min(chain, 6));
    this.wave(this.goalPos(), block.color);
    this.hitGoal(chain);
  }

  hitGoal(chain) {
    this.goal.classList.remove('hit'); void this.goal.offsetWidth; this.goal.classList.add('hit');
    this.sfx?.goal(chain);
  }

  burst(p, color = 'yellow', n = 9) {
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = `particle c-${color}`;
      const a = (Math.PI * 2 * i) / n + Math.random() * 0.6;
      const dist = this.cell * (0.7 + Math.random() * 1.3);
      d.style.setProperty('--dx', Math.cos(a) * dist + 'px');
      d.style.setProperty('--dy', Math.sin(a) * dist + 'px');
      d.style.left = p.x + this.cell / 2 + 'px';
      d.style.top = p.y + this.cell / 2 + 'px';
      this.fxLayer.appendChild(d);
      setTimeout(() => d.remove(), 650);
    }
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
      this.fxLayer.appendChild(d);
      setTimeout(() => d.remove(), 460 + i * 12);
    });
    const beam = document.createElement('div');
    beam.className = `beam c-${color} ${kind}`;
    const fixed = (SIZE - n) * c;
    Object.assign(beam.style, kind === 'col'
      ? { left: fixed + 'px', top: 0, width: c + 'px', height: n * c + 'px' }
      : { left: 0, top: fixed + 'px', width: n * c + 'px', height: c + 'px' });
    this.fxLayer.appendChild(beam);
    setTimeout(() => beam.remove(), 420);
    this.shake(Math.min(2 + chain * 1.2, 11), 180 + Math.min(chain, 8) * 20);
    if (chain >= 3) this.flash(chain >= 6 ? 0.32 : 0.2, color);
  }

  /** 流れる先頭ブロックが残す光の粒 */
  trail(p, color) {
    const q = this.cellCenter(p);
    const d = document.createElement('div');
    d.className = `trail c-${color}`;
    d.style.left = q.x + 'px'; d.style.top = q.y + 'px';
    this.fx2.appendChild(d);
    setTimeout(() => d.remove(), 360);
  }

  /** ブロックの破片が弾け、重力で落ちていく（画面の上下で動かすので回転しないレイヤーに描く） */
  shatter(p, color, n = 6) {
    const q = this.cellCenter(p), c = this.cell;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = `shard c-${color}`;
      const size = c * (0.18 + Math.random() * 0.2);
      Object.assign(d.style, { left: q.x + 'px', top: q.y + 'px', width: size + 'px', height: size + 'px' });
      this.fx2.appendChild(d);
      const vx = (Math.random() - 0.5) * c * 5, vy = -c * (2 + Math.random() * 3), g = c * 11;
      const rot = (Math.random() - 0.5) * 900, T = 0.7 + Math.random() * 0.25;
      const frames = [];
      for (let k = 0; k <= 8; k++) {
        const t = (T * k) / 8;
        frames.push({ transform: `translate(${vx * t}px,${vy * t + 0.5 * g * t * t}px) rotate(${rot * t}deg) scale(${1 - 0.5 * k / 8})`,
          opacity: k < 5 ? 1 : 1 - (k - 4) / 4 });
      }
      d.animate(frames, { duration: T * 1000, easing: 'linear' }).onfinish = () => d.remove();
    }
  }

  /** ゴールから広がる衝撃波の輪 */
  wave(p, color) {
    const q = this.cellCenter(p);
    const d = document.createElement('div');
    d.className = `wave c-${color}`;
    d.style.left = q.x + 'px'; d.style.top = q.y + 'px';
    this.fx2.appendChild(d);
    setTimeout(() => d.remove(), 560);
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
    this.fx2.appendChild(d);
    setTimeout(() => d.remove(), 900);
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
    const el = this.comboPop;
    el.innerHTML = `COMBO<b>${n}</b>`;
    el.className = 'combo-pop';
    void el.offsetWidth;
    el.className = `combo-pop show${n >= 5 ? ' hot' : ''}`;
  }

  /** コンボが続くほど背景が強く光る（0 = なし … 1 = 最大） */
  setFever(level) {
    this.feverEl.style.opacity = Math.max(0, Math.min(1, level));
    this.feverEl.classList.toggle('max', level >= 1);
  }

  /** 中央に出る大きな文字（Combo / Chain） */
  showText(html, cls = '') {
    this.pop.innerHTML = html;
    this.pop.className = 'pop';
    void this.pop.offsetWidth;
    this.pop.className = `pop show ${cls}`;
  }

  reset() {
    this.blockLayer.innerHTML = '';
    this.fxLayer.innerHTML = '';
    this.fx2.innerHTML = '';
    this.setFever(0);
    this.setDanger(0);
    this.els.clear();
    this.manual.clear();
    this.clearPreview();
  }
}

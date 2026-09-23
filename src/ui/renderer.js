export const ROTATION = 225; // deg。左上の直角が真下に来る
import { SIZE, isInside, ANIM } from '../core/constants.js?v=202609230413';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
    const vw = Math.min(window.innerWidth, 560);
    const availW = vw - 12;
    const availH = window.innerHeight - 230;
    // 回転後の外接サイズ = 一辺 × √2
    const span = (SIZE + 1.15) * Math.SQRT2;
    const cell = Math.max(16, Math.floor(Math.min(availW / span, availH / (span * 0.86))));
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
    const W = SIZE * cell;
    const L = W + cell * 1.15;
    this.L = L;
    const D = L * Math.SQRT2;
    // 盤面の三角形とゴールが収まる高さだけ確保（左右の角の外側は空白なので少し詰める）
    Object.assign(this.wrap.style, { width: D + 'px', height: D * 0.86 + 'px' });
    Object.assign(this.pf.style, {
      width: L + 'px', height: L + 'px',
      left: (D - L) / 2 + 'px', top: (D * 0.86 - L) / 2 - D * 0.02 + 'px',
    });
    Object.assign(this.lane.style, { left: 0, top: W + 'px', width: W + 'px', height: cell + 'px' });
    Object.assign(this.laneRow.style, { left: W + 'px', top: 0, width: cell + 'px', height: W + 'px' });
    Object.assign(this.goal.style, {
      left: W - cell * 0.05 + 'px', top: W - cell * 0.05 + 'px',
      width: cell * 1.1 + 'px', height: cell * 1.1 + 'px',
    });
    this.drawStatic();
    if (this._board) this.syncBoard(this._board, 0);
  }

  /** 画面上の座標 -> 盤面（回転前）のローカル px 座標 */
  clientToLocal(cx, cy) {
    const r = this.wrap.getBoundingClientRect();
    const pr = this.pf.getBoundingClientRect();
    const dx = cx - (pr.left + pr.width / 2);
    const dy = cy - (pr.top + pr.height / 2);
    const a = (-ROTATION * Math.PI) / 180;
    return {
      x: this.L / 2 + dx * Math.cos(a) - dy * Math.sin(a),
      y: this.L / 2 + dx * Math.sin(a) + dy * Math.cos(a),
    };
  }

  drawStatic() {
    const c = this.cell;
    this.wellLayer.innerHTML = '';
    this.lane.innerHTML = '';
    this.wells = new Map();
    for (let x = 0; x < SIZE; x++) {
      for (let r = 0; r < SIZE; r++) {
        if (!isInside(x, r)) continue;
        const d = document.createElement('div');
        d.className = 'cell well'
          + (x === 0 && r === 0 ? ' tl' : '') + (x === SIZE - 1 ? ' tr' : '')
          + (x === 0 && r === SIZE - 1 ? ' bl' : '') + (x + r === SIZE - 1 && x > 0 && x < SIZE - 1 ? ' edge-r' : '');
        d.style.transform = `translate(${x * c}px,${r * c}px)`;
        this.wellLayer.appendChild(d);
        this.wells.set(`${x},${r}`, d);
      }
    }
    // ライン番号（縦は盤面の下、横は盤面の右）
    this.laneRow.innerHTML = '';
    for (let n = 1; n <= SIZE; n++) {
      const a = document.createElement('div');
      a.className = 'lane-label';
      a.innerHTML = `<span class="upright">${n}</span>`;
      Object.assign(a.style, { width: c + 'px', height: c + 'px', left: (SIZE - n) * c + 'px', top: 0 });
      this.lane.appendChild(a);
      const b = document.createElement('div');
      b.className = 'lane-label';
      b.innerHTML = `<span class="upright">${n}</span>`;
      Object.assign(b.style, { width: c + 'px', height: c + 'px', left: 0, top: (SIZE - n) * c + 'px' });
      this.laneRow.appendChild(b);
    }
  }

  /* ---------- ブロック ---------- */
  pos(x, r) { return { x: x * this.cell, y: r * this.cell }; }
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

  /** 置いた直後のポップ */
  popIn(placed) {
    for (const { block, x, r } of placed) {
      const el = this.ensureEl(block);
      this.setPos(el, this.pos(x, r), 0);
      el.classList.remove('pop-in');
      void el.offsetWidth;
      el.classList.add('pop-in');
    }
  }

  /* ---------- ドラッグ中のプレビュー ---------- */
  showPreview(piece, ox, oy, clearCells, chainCount) {
    const c = this.cell;
    this.ghostLayer.innerHTML = '';
    this.hiLayer.innerHTML = '';
    for (const cc of piece.cells) {
      const d = document.createElement('div');
      d.className = `cell ghost c-${piece.color}`;
      d.style.transform = `translate(${(ox + cc.x) * c}px,${(oy + cc.y) * c}px)`;
      this.ghostLayer.appendChild(d);
    }
    for (const { x, r } of clearCells) {
      const d = document.createElement('div');
      d.className = `cell hi c-${piece.color}`;
      d.style.transform = `translate(${x * c}px,${r * c}px)`;
      this.hiLayer.appendChild(d);
    }
    if (chainCount >= 2) {
      const b = document.createElement('div');
      b.className = 'chain-badge';
      b.innerHTML = `<span class="upright">⚡${chainCount}</span>`;
      b.style.left = (ox + piece.width / 2) * c + 'px';
      b.style.top = (oy + piece.height / 2) * c + 'px';
      this.ghostLayer.appendChild(b);
    }
  }
  clearPreview() { this.ghostLayer.innerHTML = ''; this.hiLayer.innerHTML = ''; }

  /* ---------- ライン発動（マンカラ） ---------- */
  goalPos() { return this.pos(SIZE, SIZE); }

  /**
   * ライン(kind, n) の発動。縦列と横列はまったく同じ動きで、横列は縦横を入れ替えて描く。
   * 縦列の場合: 列ごと盤面の下の通路まで抜け、1コマごとに「列が1マス下がる / 通路のブロックが
   * 1マス右へ」を同時に行う。先頭（斜辺側の端のブロック）がゴールへ入ったあと、
   * 残りが一斉に各ラインへ押し込まれる。
   */
  async conveyLine(step, board) {
    const { kind, n: N, stack, chain } = step;
    // 縦列の座標系 (x, r) で計算し、横列なら入れ替えて画面へ
    const P = kind === 'col' ? (x, r) => this.pos(x, r) : (x, r) => this.pos(r, x);
    const src = SIZE - N;       // 縦列の x（横列なら r）
    const lane = SIZE;          // 通路の r（横列なら x）
    stack.forEach((b) => { this.manual.add(b.id); this.ensureEl(b).classList.add('travel'); });

    // 全ての動きを「1マスあたり ANIM.step」の同じ速さで動かす
    const T = (cells) => Math.max(1, cells) * ANIM.step;

    // 1) 通路まで抜ける（全員同じ距離 = SIZE+1-N マス）
    const sinkT = T(SIZE + 1 - N);
    stack.forEach((b, k) => this.setPos(this.ensureEl(b), P(src, lane - k), sinkT, 'linear'));
    this.sfx?.sink();
    await delay(sinkT);

    // 2) ベルトコンベア（1コマ = 1マス）
    for (let s = 1; s <= N; s++) {
      stack.forEach((b, k) => {
        const el = this.ensureEl(b);
        if (k <= s) this.setPos(el, P(src + Math.min(s - k, N - k), lane), ANIM.step, 'linear');
        else this.setPos(el, P(src, lane - (k - s)), ANIM.step, 'linear');
      });
      this.sfx?.step(s);
      await delay(ANIM.step);
    }

    // 3) 先頭がゴールへ
    const lead = stack[0];
    const leadEl = this.ensureEl(lead);
    leadEl.classList.add('fly');
    this.burst(this.goalPos(), lead.color);
    this.hitGoal(chain);
    await delay(ANIM.step);
    this.removeEl(lead.id);

    // 4) 残りが各ラインへ押し込まれる。
    //    入ってくるブロックがラインの入口の1マス手前まで進み、そこで触れてから
    //    ライン内のブロック（一番近い空欄まで）を一緒に1マス押し込む。速さは他の動きと同じ。
    const dealt = new Set(stack.slice(1).map((b) => b.id));
    const lineOf = (x, r) => (kind === 'col' ? SIZE - x : SIZE - r);   // そのマスを通る同種ラインの番号
    const pushed = new Map();                                          // ライン番号 -> 押されるブロック
    const incoming = new Map();                                        // ライン番号 -> 入ってくるブロック
    for (const { block, x, r } of board.entries()) {
      const el = this.ensureEl(block);
      const to = this.pos(x, r);
      if (dealt.has(block.id)) { incoming.set(lineOf(x, r), { block, el, to }); continue; }
      if (this.manual.has(block.id)) continue;
      const from = el.__pos;
      if (from && (from.x !== to.x || from.y !== to.y)) {
        const n = lineOf(x, r);
        if (!pushed.has(n)) pushed.set(n, []);
        pushed.get(n).push({ el, to });
      } else {
        this.setPos(el, to, 0);
      }
    }
    let longest = ANIM.step;
    for (const [n, { block, el, to }] of incoming) {
      this.manual.delete(block.id);
      const from = el.__pos ?? to;
      const cells = Math.round((Math.abs(to.x - from.x) + Math.abs(to.y - from.y)) / this.cell);
      const group = pushed.get(n) ?? [];
      if (!group.length || cells < 1) {
        const t = T(cells);
        this.setPos(el, to, t, 'linear');
        longest = Math.max(longest, t);
        setTimeout(() => el.classList.remove('travel'), t);
        continue;
      }
      // 入口の1マス手前 = 目的地から、進んできた向きへ1マス戻った位置
      const ux = Math.sign(from.x - to.x), uy = Math.sign(from.y - to.y);
      const contact = { x: to.x + ux * this.cell, y: to.y + uy * this.cell };
      const tReach = T(cells - 1);
      if (cells > 1) this.setPos(el, contact, tReach, 'linear');
      const tPush = ANIM.step * 1.6;                                 // 押し込みは少し重たく
      setTimeout(() => {
        this.setPos(el, to, tPush, 'cubic-bezier(.3,.9,.4,1.25)');
        group.forEach((g) => this.setPos(g.el, g.to, tPush, 'cubic-bezier(.3,.9,.4,1.25)'));
        el.classList.remove('travel');
        this.sfx?.push(chain);
      }, cells > 1 ? tReach : 0);
      longest = Math.max(longest, (cells > 1 ? tReach : 0) + tPush);
    }
    // 配布先が満杯で押し込めなかったブロックはゴールへ流れる
    const onBoard = new Set([...board.entries()].map((e) => e.block.id));
    for (const b of stack.slice(1)) {
      if (onBoard.has(b.id)) continue;
      const el = this.ensureEl(b);
      const from = el.__pos ?? this.goalPos();
      const g = this.goalPos();
      const t = T(Math.round((Math.abs(g.x - from.x) + Math.abs(g.y - from.y)) / this.cell));
      longest = Math.max(longest, t);
      this.setPos(el, g, t, 'linear');
      setTimeout(() => { el.classList.add('fly'); this.burst(g, b.color); this.hitGoal(chain); }, t);
      setTimeout(() => this.removeEl(b.id), t + 200);
    }
    await delay(longest);
    const cls = kind === 'col' ? 'thump' : 'thump-x';
    this.pf.classList.remove('thump', 'thump-x'); void this.pf.offsetWidth; this.pf.classList.add(cls);
  }

  hitGoal(chain) {
    this.goal.classList.remove('hit'); void this.goal.offsetWidth; this.goal.classList.add('hit');
    this.sfx?.goal(chain);
  }

  burst(p, color = 'yellow') {
    const n = 9;
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
    this.els.clear();
    this.manual.clear();
    this.clearPreview();
  }
}

import { SIZE, isInside, colIndexToScreenX, capacity, ANIM } from '../core/constants.js';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 描画とアニメーションだけを担当（ルールは持たない）。
 * 画面座標 (x, r): x=0 左端(列8)…7 右端(列1), r=0 上端…7 下端。r=8 は盤面下の通路。
 */
export class Renderer {
  constructor(sfx) {
    this.sfx = sfx;
    this.pf = document.getElementById('playfield');
    this.wellLayer = document.getElementById('wellLayer');
    this.pipeLayer = document.getElementById('pipeLayer');
    this.hiLayer = document.getElementById('hiLayer');
    this.blockLayer = document.getElementById('blockLayer');
    this.ghostLayer = document.getElementById('ghostLayer');
    this.fxLayer = document.getElementById('fxLayer');
    this.lane = document.getElementById('lane');
    this.goal = document.getElementById('goal');
    this.pop = document.getElementById('pop');
    this.els = new Map();     // blockId -> element
    this.manual = new Set();  // 手動制御中
    this.cell = 40;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /* ---------- レイアウト ---------- */
  layout() {
    const vw = Math.min(window.innerWidth, 560);
    const availW = vw - 16;
    const availH = window.innerHeight - 250;
    const cell = Math.max(20, Math.floor(Math.min(availW / (SIZE + 1.35), availH / (SIZE + 1.1))));
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
    const W = SIZE * cell;
    this.pf.style.width = W + cell * 1.35 + 'px';
    this.pf.style.height = W + cell * 1.1 + 'px';
    Object.assign(this.lane.style, { top: W + 'px', width: W + 'px', height: cell + 'px' });
    Object.assign(this.goal.style, {
      left: W + cell * 0.1 + 'px', top: W - cell * 0.15 + 'px',
      width: cell * 1.2 + 'px', height: cell * 1.3 + 'px',
    });
    this.drawStatic();
    if (this._board) this.syncBoard(this._board, 0);
  }

  drawStatic() {
    const c = this.cell;
    this.wellLayer.innerHTML = '';
    this.pipeLayer.innerHTML = '';
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
    // 各列の下から通路へ伸びるパイプ（配られたブロックの通り道）
    for (let i = 0; i < SIZE; i++) {
      const x = colIndexToScreenX(i);
      const top = capacity(i);             // 列の一番下の1つ下の行
      if (top >= SIZE) continue;
      const p = document.createElement('div');
      p.className = 'pipe';
      Object.assign(p.style, {
        left: x * c + c * 0.3 + 'px', width: c * 0.4 + 'px',
        top: top * c + 'px', height: (SIZE - top) * c + 'px',
      });
      this.pipeLayer.appendChild(p);
    }
    for (let i = 0; i < SIZE; i++) {
      const l = document.createElement('div');
      l.className = 'lane-label';
      l.textContent = i + 1;
      l.style.width = c + 'px';
      l.style.transform = `translate(${colIndexToScreenX(i) * c}px,0)`;
      this.lane.appendChild(l);
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
      b.textContent = `⚡${chainCount}`;
      b.style.transform = `translate(${(ox + piece.width) * c}px,${oy * c - c * 0.35}px)`;
      this.ghostLayer.appendChild(b);
    }
  }
  clearPreview() { this.ghostLayer.innerHTML = ''; this.hiLayer.innerHTML = ''; }

  /* ---------- 横ライン ---------- */
  async clearRows(step) {
    const els = step.removed.map(({ block, x, r }) => {
      this.manual.add(block.id);
      const el = this.ensureEl(block);
      el.classList.add('flash');
      return { el, block, x, r };
    });
    this.sfx?.rows(step.rows.length, step.chain);
    await delay(ANIM.rowFlash);
    const g = this.goalPos();
    els.forEach(({ el, x, r }, i) => {
      this.burst(this.pos(x, r), el.className.match(/c-(\w+)/)?.[1]);
      setTimeout(() => {
        el.classList.add('fly');
        this.setPos(el, g, ANIM.rowFly, 'cubic-bezier(.5,0,.8,.4)');
      }, i * 18);
    });
    await delay(ANIM.rowFly + els.length * 18);
    this.hitGoal(step.chain);
    els.forEach(({ block }) => this.removeEl(block.id));
  }

  /* ---------- 列（マンカラ） ---------- */
  laneSlot(slot) { return { x: slot * this.cell, y: SIZE * this.cell }; }
  goalPos() { return { x: SIZE * this.cell + this.cell * 0.1, y: SIZE * this.cell - this.cell * 0.1 }; }

  /**
   * 列 N の発動：列全体がパイプを通って通路まで沈み、
   * 1コマごとに「列が1マス下がる / 通路のブロックが1マス右へ」を同時に行う。
   * 先頭（一番下のブロック）がゴールへ入ったあと、残りが一斉に各列へ押し上がる。
   */
  async conveyColumn(step, board) {
    const { column: N, stack, chain } = step;
    const src = colIndexToScreenX(N - 1);
    const laneR = SIZE;
    stack.forEach((b) => { this.manual.add(b.id); this.ensureEl(b).classList.add('travel'); });

    // 1) 通路まで沈む
    const sinkT = ANIM.sink + 22 * (SIZE - N);
    stack.forEach((b, k) => this.setPos(this.ensureEl(b), this.pos(src, laneR - k), sinkT, 'cubic-bezier(.5,0,.7,1)'));
    this.sfx?.sink();
    await delay(sinkT);

    // 2) ベルトコンベア
    for (let s = 1; s <= N; s++) {
      stack.forEach((b, k) => {
        const el = this.ensureEl(b);
        if (k <= s) this.setPos(el, this.laneSlot(src + Math.min(s - k, N - k)), ANIM.step, 'linear');
        else this.setPos(el, this.pos(src, laneR - (k - s)), ANIM.step, 'linear');
      });
      this.sfx?.step(s);
      await delay(ANIM.step);
    }

    // 3) 先頭がゴールへ
    const lead = stack[0];
    const leadEl = this.ensureEl(lead);
    this.setPos(leadEl, this.goalPos(), ANIM.step);
    leadEl.classList.add('fly');
    await delay(ANIM.step);
    this.burst(this.goalPos(), lead.color);
    this.hitGoal(chain);
    this.removeEl(lead.id);

    // 4) 残りが一斉に各列へ押し上がる（グイン）
    stack.slice(1).forEach((b) => { this.manual.delete(b.id); this.els.get(b.id)?.classList.remove('travel'); });
    this.syncBoard(board, ANIM.push, 'cubic-bezier(.25,1.55,.45,1)');
    this.pf.classList.remove('thump'); void this.pf.offsetWidth; this.pf.classList.add('thump');
    this.sfx?.push(chain);
    await delay(ANIM.push);
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

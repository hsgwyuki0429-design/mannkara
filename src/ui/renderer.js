import { SIZE, isInside, ANIM } from '../core/constants.js?v=202609230145';

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
    const cell = Math.max(20, Math.floor(Math.min(availW, availH) / (SIZE + 1.15)));
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
    const W = SIZE * cell;
    this.pf.style.width = W + cell * 1.15 + 'px';
    this.pf.style.height = W + cell * 1.15 + 'px';
    Object.assign(this.lane.style, { left: 0, top: W + 'px', width: W + 'px', height: cell + 'px' });
    Object.assign(this.laneRow.style, { left: W + 'px', top: 0, width: cell + 'px', height: W + 'px' });
    Object.assign(this.goal.style, {
      left: W - cell * 0.05 + 'px', top: W - cell * 0.05 + 'px',
      width: cell * 1.1 + 'px', height: cell * 1.1 + 'px',
    });
    this.drawStatic();
    if (this._board) this.syncBoard(this._board, 0);
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
      a.textContent = n;
      Object.assign(a.style, { width: c + 'px', height: c + 'px', transform: `translate(${(SIZE - n) * c}px,0)` });
      this.lane.appendChild(a);
      const b = document.createElement('div');
      b.className = 'lane-label';
      b.textContent = n;
      Object.assign(b.style, { width: c + 'px', height: c + 'px', transform: `translate(0,${(SIZE - n) * c}px)` });
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

    // 1) 通路まで抜ける
    const sinkT = ANIM.sink + 22 * (SIZE - N);
    stack.forEach((b, k) => this.setPos(this.ensureEl(b), P(src, lane - k), sinkT, 'cubic-bezier(.5,0,.7,1)'));
    this.sfx?.sink();
    await delay(sinkT);

    // 2) ベルトコンベア
    for (let s = 1; s <= N; s++) {
      stack.forEach((b, k) => {
        const el = this.ensureEl(b);
        if (k <= s) this.setPos(el, P(src + Math.min(s - k, N - k), lane), ANIM.step, 'linear');
        else this.setPos(el, P(src, lane - (k - s)), ANIM.step, 'linear');
      });
      this.sfx?.step(s);
      await delay(ANIM.step);
    }

    // 3) 先頭がゴールへ（位置 (8,8) は縦横共通）
    const lead = stack[0];
    const leadEl = this.ensureEl(lead);
    leadEl.classList.add('fly');
    this.burst(this.goalPos(), lead.color);
    this.hitGoal(chain);
    await delay(ANIM.step);
    this.removeEl(lead.id);

    // 4) 残りが一斉に各ラインへ押し込まれる
    stack.slice(1).forEach((b) => { this.manual.delete(b.id); this.els.get(b.id)?.classList.remove('travel'); });
    this.syncBoard(board, ANIM.push, 'cubic-bezier(.25,1.55,.45,1)');
    const cls = kind === 'col' ? 'thump' : 'thump-x';
    this.pf.classList.remove('thump', 'thump-x'); void this.pf.offsetWidth; this.pf.classList.add(cls);
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

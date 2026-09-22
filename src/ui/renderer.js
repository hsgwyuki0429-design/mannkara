import { COLUMN_COUNT, ROW_COUNT, GAME_OVER_HEIGHT, floorHeight, colIndexToScreenX, ANIM } from '../core/constants.js';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 盤面の描画とアニメーションだけを担当する（ゲームルールは持たない） */
export class Renderer {
  constructor(sfx) {
    this.sfx = sfx;
    this.pf = document.getElementById('playfield');
    this.floorLayer = document.getElementById('floorLayer');
    this.gridLayer = document.getElementById('gridLayer');
    this.blockLayer = document.getElementById('blockLayer');
    this.ghostLayer = document.getElementById('ghostLayer');
    this.fxLayer = document.getElementById('fxLayer');
    this.overLine = document.getElementById('overLine');
    this.lane = document.getElementById('lane');
    this.goal = document.getElementById('goal');
    this.chainPop = document.getElementById('chainPop');
    this.els = new Map();    // blockId -> element
    this.manual = new Set(); // 手動制御中のブロック
    this.cell = 34;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  /* ---------- レイアウト ---------- */
  layout() {
    const availH = window.innerHeight - 180;                 // HUD + 候補ぶん
    const availW = Math.min(window.innerWidth, 560) - 8;
    const cell = Math.max(18, Math.floor(Math.min(availW / (COLUMN_COUNT + 1.55), availH / (ROW_COUNT + 1.2))));
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
    const boardW = COLUMN_COUNT * cell;
    this.boardW = boardW;
    this.pf.style.width = boardW + cell * 1.55 + 'px';
    this.pf.style.height = ROW_COUNT * cell + cell * 1.1 + 'px';
    this.lane.style.top = ROW_COUNT * cell + 'px';
    this.lane.style.width = boardW + 'px';
    this.lane.style.height = cell + 'px';
    this.goal.style.left = boardW + cell * 0.1 + 'px';
    this.goal.style.top = ROW_COUNT * cell - cell * 0.15 + 'px';
    this.goal.style.width = cell * 1.4 + 'px';
    this.goal.style.height = cell * 1.3 + 'px';
    this.overLine.style.top = (ROW_COUNT - GAME_OVER_HEIGHT) * cell + 'px';
    this.overLine.style.width = boardW + 'px';
    this.drawStatic();
  }

  drawStatic() {
    const cell = this.cell;
    this.gridLayer.innerHTML = '';
    this.floorLayer.innerHTML = '';
    this.lane.innerHTML = '';
    for (let i = 0; i < COLUMN_COUNT; i++) {
      const x = colIndexToScreenX(i);
      // 列の有効範囲（床の上〜ゲームオーバーライン）だけグリッドを描く
      for (let h = floorHeight(i); h < GAME_OVER_HEIGHT; h++) {
        const d = document.createElement('div');
        d.className = 'cell grid-cell';
        d.style.transform = `translate(${x * cell}px,${(ROW_COUNT - 1 - h) * cell}px)`;
        this.gridLayer.appendChild(d);
      }
      // 階段状の床（列1が最も高い＝右が高い）
      for (let h = 0; h < floorHeight(i); h++) {
        const d = document.createElement('div');
        d.className = 'cell floor-cell';
        d.style.transform = `translate(${x * cell}px,${(ROW_COUNT - 1 - h) * cell}px)`;
        this.floorLayer.appendChild(d);
      }
      // 通路の列番号
      const label = document.createElement('div');
      label.className = 'lane-label';
      label.textContent = i + 1;
      label.style.width = cell + 'px';
      label.style.transform = `translate(${x * cell}px,0)`;
      this.lane.appendChild(label);
    }
    this.refreshAll();
  }

  /* ---------- 座標 ---------- */
  blockPos(colIndex, stackIndex) {
    const h = floorHeight(colIndex) + stackIndex;
    return { x: colIndexToScreenX(colIndex) * this.cell, y: (ROW_COUNT - 1 - h) * this.cell };
  }
  laneSlotPos(slot) { // slot: 0=画面左端 … 7=列1 … 8=ゴール
    return { x: slot * this.cell, y: ROW_COUNT * this.cell };
  }

  ensureEl(block) {
    let el = this.els.get(block.id);
    if (!el) {
      el = document.createElement('div');
      el.className = `cell block b-${block.color}`;
      this.blockLayer.appendChild(el);
      this.els.set(block.id, el);
    }
    return el;
  }
  setPos(el, pos, dur = ANIM.drop, ease = '') {
    el.style.setProperty('--t', dur + 'ms');
    if (ease) el.style.setProperty('--e', ease);
    el.style.transform = `translate(${pos.x}px,${pos.y}px)`;
  }

  /** 盤面上の全ブロックを正しい位置へ（手動制御中のものは除く） */
  syncBoard(board, dur = ANIM.drop, ease = '') {
    const alive = new Set();
    board.columns.forEach((col, i) => {
      col.forEach((block, k) => {
        alive.add(block.id);
        const el = this.ensureEl(block);
        if (this.manual.has(block.id)) return;
        this.setPos(el, this.blockPos(i, k), dur, ease);
      });
    });
    for (const [id, el] of this.els) {
      if (!alive.has(id) && !this.manual.has(id)) { el.remove(); this.els.delete(id); }
    }
  }
  bindBoard(board) { this._board = board; this.syncBoard(board, 0); }
  refreshAll() { if (this._board) this.syncBoard(this._board, 0); }

  /* ---------- ゴースト ---------- */
  showGhost(cells, landing) {
    const cell = this.cell;
    this.ghostLayer.innerHTML = '';
    for (const c of cells) {
      const d = document.createElement('div');
      d.className = 'ghost-col';
      d.style.width = cell + 'px';
      d.style.height = ROW_COUNT * cell + 'px';
      d.style.transform = `translate(${c.x * cell}px,0)`;
      this.ghostLayer.appendChild(d);
    }
    for (const c of landing) {
      const d = document.createElement('div');
      d.className = 'cell ghost';
      const p = this.blockPos(c.colIndex, c.stackIndex);
      d.style.transform = `translate(${p.x}px,${p.y}px)`;
      this.ghostLayer.appendChild(d);
    }
  }
  clearGhost() { this.ghostLayer.innerHTML = ''; }

  /** 指で運んでいる最中のピース（盤面上に浮かせて表示） */
  showFloating(piece, originX, topY = 0) {
    this.clearFloating();
    const cell = this.cell;
    this.floatEls = [];
    for (const c of piece.normalizedCells()) {
      const d = document.createElement('div');
      d.className = `cell block b-${piece.color} floating`;
      d.style.transform = `translate(${(originX + c.x) * cell}px,${topY + c.y * cell}px)`;
      this.ghostLayer.appendChild(d);
      this.floatEls.push(d);
    }
  }
  clearFloating() { this.floatEls = []; }

  /* ---------- マンカラ演出 ---------- */
  /**
   * 列 N の発動をベルトコンベア状に見せる。
   * 1コマごとに「列全体が1マス下がる / 通路のブロックが1マス右へ」を同時に行い、
   * 一番下のブロックが先頭としてゴールまで流れる。
   */
  async conveyColumn(columnNumber, stack, board, chain) {
    const N = stack.length;
    const srcSlot = colIndexToScreenX(columnNumber - 1);
    const colIndex = columnNumber - 1;
    stack.forEach((b) => { this.manual.add(b.id); this.ensureEl(b).classList.add('travel'); });

    for (let s = 1; s <= N + 1; s++) {
      for (let k = 0; k < stack.length; k++) {
        const el = this.ensureEl(stack[k]);
        if (k < s) {
          // 通路に出ているブロック：右へ流れる（目標位置で停止）
          const slot = srcSlot + Math.min(s - 1 - k, N - k);
          this.setPos(el, this.laneSlotPos(slot), ANIM.step, 'linear');
        } else {
          // まだ列に残っているブロック：1マスずつ下がる
          this.setPos(el, this.blockPos(colIndex, k - s), ANIM.step, 'linear');
        }
      }
      this.sfx?.step(Math.min(s, 6));
      await delay(ANIM.step);
    }

    // 先頭（一番下だったブロック）がゴールへ
    const lead = stack[0];
    const leadEl = this.ensureEl(lead);
    leadEl.classList.add('goaled');
    this.goal.classList.add('hit');
    this.burst(this.laneSlotPos(srcSlot + N), lead.color);
    this.sfx?.goal(chain);
    await delay(ANIM.goal);
    this.goal.classList.remove('hit');
    this.manual.delete(lead.id);
    leadEl.remove();
    this.els.delete(lead.id);

    // 残りが一斉に各列へ下から押し上がる
    for (let k = 1; k < stack.length; k++) this.manual.delete(stack[k].id);
    stack.forEach((b) => this.els.get(b.id)?.classList.remove('travel'));
    this.syncBoard(board, ANIM.push, 'cubic-bezier(.2,1.5,.4,1)');
    this.pf.classList.add('shake');
    this.sfx?.chain(chain);
    await delay(ANIM.push);
    this.pf.classList.remove('shake');
  }

  /** ゴール時のパーティクル */
  burst(pos, color) {
    const n = 10;
    for (let i = 0; i < n; i++) {
      const d = document.createElement('div');
      d.className = `particle b-${color}`;
      const a = (Math.PI * 2 * i) / n + Math.random();
      const r = this.cell * (0.8 + Math.random() * 1.4);
      d.style.setProperty('--dx', Math.cos(a) * r + 'px');
      d.style.setProperty('--dy', Math.sin(a) * r + 'px');
      d.style.transform = `translate(${pos.x + this.cell / 2}px,${pos.y + this.cell / 2}px)`;
      this.fxLayer.appendChild(d);
      setTimeout(() => d.remove(), 620);
    }
  }

  showChain(chain, gained) {
    this.chainPop.innerHTML = chain >= 2
      ? `<b>${chain}</b> CHAIN <i>+${gained}</i>`
      : `<i>+${gained}</i>`;
    this.chainPop.classList.remove('show');
    void this.chainPop.offsetWidth;
    this.chainPop.classList.add('show');
  }

  reset() {
    this.blockLayer.innerHTML = '';
    this.fxLayer.innerHTML = '';
    this.els.clear();
    this.manual.clear();
    this.clearGhost();
  }
}

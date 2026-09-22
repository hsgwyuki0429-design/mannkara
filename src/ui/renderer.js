import { COLUMN_COUNT, ROW_COUNT, GAME_OVER_HEIGHT, floorHeight, colIndexToScreenX, ANIM } from '../core/constants.js';

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 盤面の描画とアニメーションだけを担当する（ゲームルールは持たない） */
export class Renderer {
  constructor() {
    this.pf = document.getElementById('playfield');
    this.floorLayer = document.getElementById('floorLayer');
    this.gridLayer = document.getElementById('gridLayer');
    this.blockLayer = document.getElementById('blockLayer');
    this.ghostLayer = document.getElementById('ghostLayer');
    this.overLine = document.getElementById('overLine');
    this.lane = document.getElementById('lane');
    this.goal = document.getElementById('goal');
    this.chainPop = document.getElementById('chainPop');
    this.els = new Map();   // blockId -> element
    this.manual = new Set();// 手動で動かしている最中のブロック
    this.cell = 34;
    this.layout();
    window.addEventListener('resize', () => this.layout());
  }

  layout() {
    const availH = window.innerHeight - 290;
    const availW = Math.min(window.innerWidth, 520) - 16;
    const cell = Math.max(16, Math.floor(Math.min(availW / (COLUMN_COUNT + 2), availH / (ROW_COUNT + 1))));
    this.cell = cell;
    document.documentElement.style.setProperty('--cell', cell + 'px');
    const boardW = COLUMN_COUNT * cell;
    this.pf.style.width = boardW + cell * 2 + 'px';
    this.pf.style.height = ROW_COUNT * cell + cell + 'px';
    this.lane.style.top = ROW_COUNT * cell + 'px';
    this.lane.style.width = boardW + 'px';
    this.lane.style.height = cell + 'px';
    this.goal.style.left = boardW + cell * 0.25 + 'px';
    this.goal.style.top = ROW_COUNT * cell + 'px';
    this.goal.style.width = cell * 1.6 + 'px';
    this.goal.style.height = cell + 'px';
    this.overLine.style.top = (ROW_COUNT - GAME_OVER_HEIGHT) * cell + 'px';
    this.overLine.style.width = boardW + 'px';
    this.drawLaneLabels();
    this.drawStatic();
  }

  /** 通路に列番号を表示（右端が列1） */
  drawLaneLabels() {
    this.lane.innerHTML = '';
    for (let i = 0; i < COLUMN_COUNT; i++) {
      const d = document.createElement('div');
      d.className = 'lane-label';
      d.textContent = i + 1;
      d.style.width = this.cell + 'px';
      d.style.transform = `translate(${colIndexToScreenX(i) * this.cell}px,0)`;
      this.lane.appendChild(d);
    }
  }

  drawStatic() {
    const cell = this.cell;
    this.gridLayer.innerHTML = '';
    this.floorLayer.innerHTML = '';
    for (let x = 0; x < COLUMN_COUNT; x++) {
      for (let y = 0; y < ROW_COUNT; y++) {
        const d = document.createElement('div');
        d.className = 'cell grid-cell';
        d.style.transform = `translate(${x * cell}px,${y * cell}px)`;
        this.gridLayer.appendChild(d);
      }
    }
    // 階段状の床（列1が最も高い＝右が高い）
    for (let i = 0; i < COLUMN_COUNT; i++) {
      const x = colIndexToScreenX(i);
      for (let h = 0; h < floorHeight(i); h++) {
        const d = document.createElement('div');
        d.className = 'cell floor-cell';
        d.style.transform = `translate(${x * cell}px,${(ROW_COUNT - 1 - h) * cell}px)`;
        this.floorLayer.appendChild(d);
      }
    }
    this.refreshAll();
  }

  /* ---- 座標 ---- */
  blockPos(colIndex, stackIndex) {
    const h = floorHeight(colIndex) + stackIndex;
    return { x: colIndexToScreenX(colIndex) * this.cell, y: (ROW_COUNT - 1 - h) * this.cell };
  }
  lanePos(colIndex) {
    return { x: colIndexToScreenX(colIndex) * this.cell, y: ROW_COUNT * this.cell };
  }
  goalPos() {
    return { x: COLUMN_COUNT * this.cell + this.cell * 0.45, y: ROW_COUNT * this.cell };
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
  setPos(el, pos, dur = ANIM.drop) {
    el.style.setProperty('--t', dur + 'ms');
    el.style.transform = `translate(${pos.x}px,${pos.y}px)`;
  }

  /** 盤面上の全ブロックを正しい位置へ（手動制御中のものは除く） */
  syncBoard(board, dur = ANIM.insert) {
    const alive = new Set();
    board.columns.forEach((col, i) => {
      col.forEach((block, k) => {
        alive.add(block.id);
        const el = this.ensureEl(block);
        if (this.manual.has(block.id)) return;
        this.setPos(el, this.blockPos(i, k), dur);
      });
    });
    for (const [id, el] of this.els) {
      if (!alive.has(id) && !this.manual.has(id)) { el.remove(); this.els.delete(id); }
    }
  }
  refreshAll() { if (this._board) this.syncBoard(this._board, 0); }
  bindBoard(board) { this._board = board; this.syncBoard(board, 0); }

  /* ---- ゴースト ---- */
  showGhost(cells, landing) {
    const cell = this.cell;
    this.ghostLayer.innerHTML = '';
    for (const c of landing) {
      const d = document.createElement('div');
      d.className = 'cell ghost';
      const p = this.blockPos(c.colIndex, c.stackIndex);
      d.style.transform = `translate(${p.x}px,${p.y}px)`;
      this.ghostLayer.appendChild(d);
    }
    for (const c of cells) {
      const d = document.createElement('div');
      d.className = 'cell ghost-col';
      d.style.height = ROW_COUNT * cell + 'px';
      d.style.transform = `translate(${c.x * cell}px,0)`;
      this.ghostLayer.appendChild(d);
    }
  }
  clearGhost() { this.ghostLayer.innerHTML = ''; }

  /* ---- マンカラ演出 ---- */
  /** 発動列のブロックが下へ吸い込まれる */
  async suck(columnNumber, blocks) {
    const i = columnNumber - 1;
    const lane = this.lanePos(i);
    blocks.forEach((b, k) => {
      const el = this.ensureEl(b);
      this.manual.add(b.id);
      el.classList.add('travel');
      this.setPos(el, { x: lane.x, y: lane.y }, ANIM.suck);
    });
    await delay(ANIM.suck);
  }
  /** 下の通路を右へ運び、対象列へ下から押し込む */
  async deal(block, fromColumn, toColumn, board) {
    const el = this.ensureEl(block);
    const dist = Math.abs(fromColumn - toColumn);
    const lane = this.lanePos(toColumn - 1);
    this.setPos(el, lane, ANIM.travel * Math.max(1, dist));
    await delay(ANIM.travel * Math.max(1, dist));
    this.manual.delete(block.id);
    el.classList.remove('travel');
    this.syncBoard(board, ANIM.insert); // 既存ブロックが押し上げられる
    await delay(ANIM.insert);
  }
  /** ゴールへ */
  async toGoal(block, fromColumn) {
    const el = this.ensureEl(block);
    const g = this.goalPos();
    this.setPos(el, g, ANIM.travel * Math.max(1, fromColumn));
    await delay(ANIM.travel * Math.max(1, fromColumn));
    el.classList.add('goaled');
    this.goal.classList.add('hit');
    await delay(ANIM.goal);
    this.goal.classList.remove('hit');
    this.manual.delete(block.id);
    el.remove();
    this.els.delete(block.id);
  }
  showChain(chain, gained) {
    this.chainPop.textContent = chain >= 2 ? `${chain} CHAIN!  +${gained}` : `+${gained}`;
    this.chainPop.classList.remove('show');
    void this.chainPop.offsetWidth;
    this.chainPop.classList.add('show');
  }
  reset() {
    this.blockLayer.innerHTML = '';
    this.els.clear();
    this.manual.clear();
    this.clearGhost();
  }
}

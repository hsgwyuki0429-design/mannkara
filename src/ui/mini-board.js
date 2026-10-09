import { SIZE, ANIM, isInside, lineCells } from '../core/constants.js?v=202610090639';
import { ROTATION } from './renderer.js?v=202610090639';
import { stepCells } from '../core/battle.js?v=202610090639';

/**
 * 対戦で、相手の盤面を小さく映す（画面の右上）。盤面と同じ向き（直角が下の三角形）・同じブロックの塗り（.block c-色。盤面の種類の見た目もそのまま）。
 * 相手が置いたターン（core/game.js の turn と同じ形）を、相手の画面と同じ長さで再生する: 置いたブロックが弾む → 満杯になったラインが縮んで
 * 通路へ抜け → 残りが入る先のラインへすべりこむ。最後におじゃまの数字が減る。おじゃまは上から落ちてくる。
 * 小さいので、通路・番号・ゴールは描かない（動きの長さだけ本物と同じにして、相手の連鎖が終わる時刻と、おじゃまが届く時刻をそろえる）
 */
const STRETCH_Y = 1.04;
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

export class MiniBoard {
  constructor(root) {
    this.root = root;
    this.field = document.createElement('div');
    this.field.className = 'mini-field';
    this.wells = document.createElement('div');
    this.wells.className = 'mini-wells';
    this.blocks = document.createElement('div');
    this.blocks.className = 'mini-blocks';
    this.field.append(this.wells, this.blocks);
    root.appendChild(this.field);
    this.els = new Map();          // block id -> 要素
    this.queue = Promise.resolve();
    this.left = 0;                 // 再生の残り（ms）
    this.paused = false;
    this.gen = 0;
    this.cell = 12;
    this.base = 1;                 // 再生の速さ（オンライン対戦は、ピースを持っているときと同じ 3 倍）
  }

  /** マスの大きさ（px）を決めて並べ直す */
  layout(cell) {
    this.cell = Math.max(4, cell);
    const W = SIZE * this.cell;
    this.root.style.setProperty('--mcell', this.cell + 'px');
    const boxW = W * Math.SQRT2, boxH = (W / Math.SQRT2) * STRETCH_Y;
    Object.assign(this.root.style, { width: Math.ceil(boxW) + 'px', height: Math.ceil(boxH + 2) + 'px' });
    // 直角を下に（盤面と同じ 225° 回転）。斜辺のまん中が上のふちに来るように置く
    Object.assign(this.field.style, {
      width: W + 'px', height: W + 'px',
      left: boxW / 2 - W / 2 + 'px', top: -W / 2 + 1 + 'px',
      transform: `scaleY(${STRETCH_Y}) rotate(${ROTATION}deg)`,
    });
    this.wells.replaceChildren();
    for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
      if (!isInside(x, r)) continue;
      const d = document.createElement('i');
      d.className = 'cell well';
      d.style.transform = `translate(${x * this.cell}px,${r * this.cell}px)`;
      this.wells.appendChild(d);
    }
    for (const el of this.els.values()) if (el.__p) this.put(el, el.__p);
  }

  /** 盤面（core/board.js の Board）をそのまま映す（再生の途中のものは打ち切る） */
  reset(board) {
    this.gen++;
    this.queue = Promise.resolve();
    this.left = 0;
    this.blocks.replaceChildren();
    this.els.clear();
    if (board) for (const { block, x, r } of board.entries()) this.put(this.ensure(block), { x, r });
  }

  ensure(block) {
    let el = this.els.get(block.id);
    if (!el) {
      el = document.createElement('i');
      el.className = `cell block c-${block.color}`;
      if (block.color === 'garbage') {
        el.classList.add('garbage');
        el.__num = document.createElement('b');
        el.__num.className = 'gnum upright';
        el.appendChild(el.__num);
        this.num(el, block.garbage ?? 1);
      }
      this.blocks.appendChild(el);
      this.els.set(block.id, el);
    }
    return el;
  }
  num(el, n) {
    if (!el.__num) return;
    el.__num.textContent = n;
    el.classList.toggle('low', n <= 2);
    el.classList.toggle('wide', n >= 10);
  }
  put(el, p, scale = 1) {
    el.__p = p;
    el.style.transform = `translate(${p.x * this.cell}px,${p.r * this.cell}px)` + (scale !== 1 ? ` scale(${scale})` : '');
  }
  remove(id) { this.els.get(id)?.remove(); this.els.delete(id); }

  /** 再生の残り（ms。相手の画面での残りと同じ見積もり。速さで割った、ほんとうの時間） */
  playLeft() { return this.left / this.base; }
  setPaused(on) { this.paused = !!on; }

  /** 再生の列に並べる（順番に 1 つずつ） */
  enqueue(cost, fn) {
    const gen = this.gen;
    this.left += cost;
    this.queue = this.queue.then(() => (gen === this.gen ? fn() : null)).catch((e) => console.error(e)).finally(() => {
      if (gen === this.gen) this.left = Math.max(0, this.left - cost);
    });
    return this.queue;
  }

  /** 時間 ms のあいだ fn(割合 0→1) を毎フレーム呼ぶ（一時停止の間は止まる。再生が溜まったら速める） */
  tween(ms, fn) {
    const gen = this.gen;
    return new Promise((resolve) => {
      let t = 0, last = performance.now();
      const frame = (now) => {
        if (gen !== this.gen) { resolve(false); return; }
        const dt = Math.min(100, Math.max(0, now - last));
        last = now;
        if (!this.paused) t += dt * this.speed();
        const u = Math.min(1, t / ms);
        fn(u);
        if (u < 1) requestAnimationFrame(frame); else resolve(true);
      };
      requestAnimationFrame(frame);
    });
  }
  /** 再生が溜まっていたら少し速める（相手の画面より遅れすぎないように） */
  speed() { return this.base * (1 + Math.min(3, Math.max(0, this.left / this.base - 4000) / 3000)); }
  wait(ms) { return this.tween(ms, () => {}); }

  /**
   * 相手が置いたターンを再生する（turn = Game.placePiece の記録。placed / steps / chip）。
   * 返り値は、この再生が終わったときに解決する Promise
   */
  playTurn(turn) {
    const cost = turnCost(turn);
    return this.enqueue(cost, async () => {
      const gen = this.gen;
      for (const { block, x, r } of turn.placed) {
        const el = this.ensure(block);
        this.put(el, { x, r });
        if (!reducedMotion()) el.animate([{ scale: '1.25' }, { scale: '.9', offset: 0.3 }, { scale: '1' }], { duration: 240, easing: 'ease-out' });
      }
      for (const [i, step] of turn.steps.entries()) {
        if (i === 0) await this.charge(step);
        if (gen !== this.gen) return;
        await this.step(step);
        if (gen !== this.gen) return;
        await this.wait(ANIM.betweenChains);
      }
      if (gen !== this.gen) return;
      this.chip(turn.chip);
    });
  }

  async charge(step) {
    const els = step.stack.map((b) => this.els.get(b.id)).filter(Boolean);
    await this.tween(ANIM.charge, (u) => { for (const el of els) this.put(el, el.__p, 1 - 0.15 * u); });
  }

  /** 1 本の発動: ラインのブロックが通路のほう（斜辺の外）へ抜けて小さくなり、残りは入る先へすべりこむ */
  async step(step) {
    const { kind, n, stack, before, after } = step;
    const out = kind === 'col' ? { x: 0, r: 1 } : { x: 1, r: 0 };      // 斜辺の外への向き（縦は下・横は右）
    const els = stack.map((b) => ({ b, el: this.ensure(b), from: before.get(b.id) }));
    const trainT = 9 * ANIM.step;
    await this.tween(trainT, (u) => {
      const e = u * u * (3 - 2 * u), d = e * (n + 1.2);
      for (const { el, from } of els) if (from) this.put(el, { x: from.x + out.x * d, r: from.r + out.r * d }, Math.max(0, 1 - e * 1.25));
    });
    // 入る先のラインへ（押されるブロックも一緒に）
    const moves = [];
    for (const { b, el } of els) {
      const a = after.get(b.id);
      if (!a) { this.remove(b.id); continue; }
      const line = lineCells(kind, kind === 'col' ? SIZE - a.x : SIZE - a.r);
      const entry = line[0];
      moves.push({ el, from: { x: entry.x + out.x * 1.2, r: entry.r + out.r * 1.2 }, to: a, grow: true });
    }
    for (const [id, p] of before) {
      const a = after.get(id);
      if (!a || stack.some((s) => s.id === id) || (a.x === p.x && a.r === p.r)) continue;
      const el = this.els.get(id);
      if (el) moves.push({ el, from: p, to: a });
    }
    const enterT = Math.max(1, stepCells(step) - 9) * ANIM.step;
    if (moves.length) {
      await this.tween(enterT, (u) => {
        const e = 1 - Math.pow(1 - u, 2.2);
        for (const m of moves) this.put(m.el, { x: m.from.x + (m.to.x - m.from.x) * e, r: m.from.r + (m.to.r - m.from.r) * e }, m.grow ? Math.min(1, 0.4 + u * 1.5) : 1);
      });
    } else await this.wait(enterT);
    for (const [id, p] of after) { const el = this.els.get(id); if (el) this.put(el, p); }
  }

  /** おじゃまの数字が減る・0 で消える */
  chip(chip) {
    if (!chip) return;
    for (const { block, n } of chip.changed) {
      const el = this.els.get(block.id);
      if (!el) continue;
      this.num(el, n);
      if (!reducedMotion()) el.__num?.animate([{ scale: '1' }, { scale: '1.7', offset: 0.35 }, { scale: '1' }], { duration: 320 });
    }
    for (const { block } of chip.removed) {
      const el = this.els.get(block.id);
      if (!el) continue;
      if (reducedMotion()) { this.remove(block.id); continue; }
      el.animate([{ scale: '1' }, { scale: '1.3', offset: 0.3 }, { scale: '0' }], { duration: 260, easing: 'ease-in' }).onfinish = () => this.remove(block.id);
    }
  }

  /** おじゃまが落ちてくる（landed = [{ block, x, r, path }]） */
  playDrop(landed) {
    const cost = 300 + landed.length * 130;
    return this.enqueue(cost, async () => {
      const gen = this.gen;
      await Promise.all(landed.map(async ({ block, x, r, n, path }, i) => {
        await this.wait(i * 130);
        if (gen !== this.gen) return;
        const el = this.ensure(block);
        this.num(el, n ?? block.garbage);
        const pts = path?.length ? [{ x: path[0].x + 3, r: path[0].r + 3 }, ...path] : [{ x: x + 3, r: r + 3 }, { x, r }];
        await this.tween(300, (u) => {
          const f = Math.pow(u, 1.7) * (pts.length - 1), k = Math.min(pts.length - 2, Math.floor(f)), g = f - k;
          const a = pts[k], b = pts[k + 1];
          this.put(el, { x: a.x + (b.x - a.x) * g, r: a.r + (b.r - a.r) * g });
        });
        this.put(el, { x, r });
        if (!reducedMotion()) el.animate([{ scale: '1.2' }, { scale: '.85', offset: 0.3 }, { scale: '1' }], { duration: 260, easing: 'ease-out' });
      }));
    });
  }

  /** 盤面のどこか（x, r）の画面の座標（攻撃が飛び立つ場所など） */
  pointOf(x, r) {
    const fr = this.field.getBoundingClientRect(), c = this.cell, W = SIZE * c;
    const a = (ROTATION * Math.PI) / 180, lx = x * c - W / 2, ly = r * c - W / 2;
    return { x: fr.left + fr.width / 2 + lx * Math.cos(a) - ly * Math.sin(a), y: fr.top + fr.height / 2 + (lx * Math.sin(a) + ly * Math.cos(a)) * STRETCH_Y };
  }
  /** 斜辺のまん中の少し上（本物の盤面のゴールのあたり） */
  goalPoint() { return this.pointOf(SIZE + 0.5, SIZE + 0.5); }
}

/** 相手のターンの再生時間（core/battle.js の playDuration と同じ見積もり + 置いた弾み） */
export function turnCost(turn) {
  if (!turn.steps.length) return 120;
  return turn.steps.reduce((a, s) => a + stepCells(s) * ANIM.step + ANIM.betweenChains, ANIM.charge);
}

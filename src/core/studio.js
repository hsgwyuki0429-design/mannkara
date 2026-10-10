import { isInside, SIZE } from './constants.js?v=202610100228';
import { Board, createBlock } from './board.js?v=202610100228';
import { Piece, COLORS, seededRandom, seedOf } from './pieces.js?v=202610100228';
import * as Sim from './sim.js?v=202610100228';

/**
 * 撮影モード: 「光っている場所に1個置くだけで、大連鎖して全消し」になる盤面（動画映えする盤面）。
 * 盤面集は scripts/build-studio.mjs で作る（studio-library.js）。DOM 非依存。
 *
 * 盤面1つの書き方: "<盤面> <置く形>@<左上のx><左上のy> <ダミーの手駒> <ダミーの手駒>"
 *   盤面 = 36 マス（r = 0…7、x = 0…7 の順に盤面の中だけ）の埋まりを 1 ビットずつ並べた 16 進数（9 文字）
 *   ダミーの手駒 = 本物のゲームらしく見せるための、残りの2枠の手駒（置けるが、置いても全消しにはならない）
 * 置く形はトレイのまん中（STUDIO_SLOT）、ダミーは左右に出す
 */
export const STUDIO_SLOT = 1;
const INSIDE = [];
for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) INSIDE.push([x, r]);

export function encodeCells(cells) {
  const set = new Set(cells.map(([x, r]) => r * SIZE + x));
  let bits = '';
  for (const [x, r] of INSIDE) bits += set.has(r * SIZE + x) ? '1' : '0';
  let hex = '';
  for (let i = 0; i < bits.length; i += 4) hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  return hex;
}
export function decodeCells(hex) {
  const bits = [...hex].map((h) => parseInt(h, 16).toString(2).padStart(4, '0')).join('');
  return INSIDE.filter((_, i) => bits[i] === '1');
}

/** 盤面集の1行を読む { cells: [[x, r]…], piece, ox, oy, decoys: [名前, 名前] } */
export function parseStudio(code) {
  const [hex, move, ...decoys] = code.trim().split(/\s+/);
  const [piece, pos] = move.split('@');
  return { cells: decodeCells(hex), piece, ox: Number(pos[0]), oy: Number(pos[1]), decoys };
}

/**
 * ブロックの色: 本物のゲームで置いてきたように見えるよう、となり合うブロックを 2〜4 個ずつのまとまりにして、
 * まとまりごとに色を塗る（となりのまとまりとは、なるべく違う色）。同じ盤面はいつも同じ色
 */
export function colorCells(cells, seed) {
  const random = seededRandom(seed);
  const shuffle = (list) => {
    const a = [...list];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  };
  const key = (x, r) => r * SIZE + x;
  const filled = new Set(cells.map(([x, r]) => key(x, r)));
  const group = new Map();
  const order = shuffle(cells);
  const near = (x, r) => [[x + 1, r], [x - 1, r], [x, r + 1], [x, r - 1]].filter(([a, b]) => filled.has(key(a, b)));
  let g = 0;
  for (const [x, r] of order) {
    if (group.has(key(x, r))) continue;
    const size = 2 + Math.floor(random() * 3);
    const members = [[x, r]];
    group.set(key(x, r), g);
    for (let i = 0; i < members.length && members.length < size; i++) {
      for (const [a, b] of shuffle(near(...members[i]))) {
        if (members.length >= size || group.has(key(a, b))) continue;
        group.set(key(a, b), g);
        members.push([a, b]);
      }
    }
    g++;
  }
  const colorOfGroup = new Map();
  for (const [x, r] of order) {
    const id = group.get(key(x, r));
    if (colorOfGroup.has(id)) continue;
    const used = new Set();
    for (const [mx, mr] of cells) {
      if (group.get(key(mx, mr)) !== id) continue;
      for (const [a, b] of near(mx, mr)) { const c = colorOfGroup.get(group.get(key(a, b))); if (c) used.add(c); }
    }
    const free = COLORS.filter((c) => !used.has(c));
    const pool = free.length ? free : COLORS;
    colorOfGroup.set(id, pool[Math.floor(random() * pool.length)]);
  }
  return cells.map(([x, r]) => [x, r, colorOfGroup.get(group.get(key(x, r)))]);
}

/**
 * 盤面集の1行から、画面に出す状態（Game.importState の形）と、置く場所・連鎖数を作る。
 * chain / blocks は置いたときの連鎖数と、最初のブロックの数（一覧に出す用）
 */
export function studioState(code) {
  const st = parseStudio(code);
  const tray = [st.decoys[0] ?? null, null, st.decoys[1] ?? null];
  tray[STUDIO_SLOT] = st.piece;
  const board = colorCells(st.cells, seedOf(code));
  return {
    state: { v: 1, board, tray, planTray: null, score: {}, gameOver: false, dealing: null },
    target: { slot: STUDIO_SLOT, ox: st.ox, oy: st.oy, piece: st.piece },
    blocks: st.cells.length,
    chain: chainOf(st),
  };
}

/** 置いたときの連鎖数（全消しにならなければ 0）。残りの手駒（ダミー）を見て縦横を決めるのは本物のゲームと同じ */
export function chainOf(st) {
  const b = new Board();
  for (const [x, r] of st.cells) b.set(x, r, createBlock('blue'));
  const s = Sim.fromBoard(b), cells = new Piece(st.piece).cells;
  if (!Sim.canPlace(s, cells, st.ox, st.oy)) return 0;
  Sim.place(s, cells, st.ox, st.oy);
  const chain = Sim.resolveAll(s, Sim.restOf(st.decoys.map((n) => new Piece(n).cells)));
  return Sim.blocks(s) === 0 ? chain : 0;
}

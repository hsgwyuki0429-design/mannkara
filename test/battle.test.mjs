import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, createBlock, createGarbage, isGarbage } from '../src/core/board.js?v=202610100228';
import { resolveChains, resolveLine } from '../src/core/mancala.js?v=202610100228';
import * as Sim from '../src/core/sim.js?v=202610100228';
import { Game } from '../src/core/game.js?v=202610100228';
import { Piece, seededRandom, seedOf } from '../src/core/pieces.js?v=202610100228';
import { DealerCore } from '../src/core/dealer.js?v=202610100228';
import { bestMove, evaluate } from '../src/core/advisor.js?v=202610100228';
import { lineCells, isInside, SIZE } from '../src/core/constants.js?v=202610100228';
import {
  attackFor, marginBlocks, edgeOrder, chipOrder, edgeSpot, GarbageQueue, BattleSide, playDuration, ATTACK_MIN_CHAIN, ALL_CLEAR_ATTACK,
  MARGIN_MS, MARGIN_STEP_MS, MARGIN_MAX, marginStartOf,
} from '../src/core/battle.js?v=202610100228';

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const setLine = (b, kind, n, bits) => lineCells(kind, n).forEach(({ x, r }, k) => {
  const v = bits[k];
  b.set(x, r, v === 'g' ? createGarbage(3) : v ? createBlock('debug') : null);
});
const pat = (b, kind, n) => b.line(kind, n).map((v) => (isGarbage(v) ? 'g' : v ? 1 : 0));

test('おじゃまが入ったラインは、ほかが全部埋まっても満杯にならない（発動しない）', () => {
  const b = new Board();
  setLine(b, 'col', 3, [1, 'g', 1]);
  assert.equal(b.count('col', 3), 2);
  assert.equal(b.isFull('col', 3), false);
  assert.deepEqual(resolveChains(b), []);
  const s = Sim.fromBoard(b);
  assert.equal(Sim.lineCount(s, 'col', 3), 2);
  assert.deepEqual(Sim.fullLines(s), []);
  assert.equal(Sim.lineHasGarbage(s, 'col', 3), true);
  assert.equal(Sim.lineHasGarbage(s, 'col', 2), false);
});

test('おじゃまの上には置けない', () => {
  const b = new Board();
  b.set(0, 0, createGarbage(2));
  assert.equal(b.canPlace(new Piece('Dot0'), 0, 0), false);
  assert.equal(Sim.canPlace(Sim.fromBoard(b), new Piece('Dot0').cells, 0, 0), false);
});

test('流れこむブロックはおじゃまの手前で止まる（おじゃまは動かない壁）', () => {
  const b = new Board();
  setLine(b, 'col', 5, [0, 0, 'g', 0, 0]);
  assert.equal(b.insertBottom('col', 5, createBlock('x')), true);
  assert.deepEqual(pat(b, 'col', 5), [0, 1, 'g', 0, 0]);
});

test('押しこみはおじゃまの手前まで。手前におじゃままで空欄が無ければ、満杯と同じくゴールへ', () => {
  const b = new Board();
  setLine(b, 'col', 5, [1, 0, 'g', 0, 1]);
  const first = b.line('col', 5)[0];
  assert.equal(b.insertBottom('col', 5, createBlock('x')), true);
  assert.deepEqual(pat(b, 'col', 5), [1, 1, 'g', 0, 1]);
  assert.equal(b.line('col', 5)[1].id, first.id, '手前のブロックが奥へ 1 マス');
  assert.equal(b.insertBottom('col', 5, createBlock('x')), false, 'おじゃまより奥の空欄には届かない');
  assert.deepEqual(pat(b, 'col', 5), [1, 1, 'g', 0, 1]);
  const c = new Board();
  setLine(c, 'row', 3, ['g', 0, 0]);
  assert.equal(c.insertBottom('row', 3, createBlock('x')), false, '入口がおじゃまなら入れない');
});

test('おじゃまがあっても、軽い盤面（sim.js）は本体と同じ結果になる', () => {
  const random = rng(7);
  for (let t = 0; t < 400; t++) {
    const b = new Board();
    for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) {
      if (!isInside(x, r)) continue;
      const u = random();
      if (u < 0.08) b.set(x, r, createGarbage(1 + Math.floor(random() * 5)));
      else if (u < 0.62) b.set(x, r, createBlock('debug'));
    }
    // 満杯のラインを 1 本作ってから連鎖させる
    const kind = random() < 0.5 ? 'col' : 'row', n = 1 + Math.floor(random() * SIZE);
    if (!lineCells(kind, n).some(({ x, r }) => isGarbage(b.get(x, r)))) for (const { x, r } of lineCells(kind, n)) if (!b.get(x, r)) b.set(x, r, createBlock('debug'));
    const s = Sim.fromBoard(b);
    const chainBoard = resolveChains(b).length;
    const chainSim = Sim.resolveAll(s);
    assert.equal(chainSim, chainBoard, `連鎖数 (試行 ${t})`);
    assert.equal(Sim.keyOf(s), Sim.keyOf(Sim.fromBoard(b)), `連鎖のあとの盤面 (試行 ${t})`);
    for (const g of b.garbage()) assert.equal(Sim.isGarbageCell(s, g.r * SIZE + g.x), true, 'おじゃまは動かない');
  }
});

test('盤面のキーは、同じマスでもおじゃまとふつうのブロックを区別する', () => {
  const a = new Board(), b = new Board();
  a.set(0, 0, createBlock('x'));
  b.set(0, 0, createGarbage(1));
  assert.notEqual(Sim.keyOf(Sim.fromBoard(a)), Sim.keyOf(Sim.fromBoard(b)));
  assert.equal(typeof Sim.keyOf(Sim.fromBoard(new Board())), 'number', 'おじゃまが無いときは今までどおりの数');
});

test('連鎖のスナップショットにおじゃまは入らない（動かないので）', () => {
  const b = new Board();
  b.set(0, 0, createGarbage(4));
  b.set(7, 0, createBlock('red'));
  const snap = b.snapshot();
  assert.equal(snap.size, 1);
  assert.equal(b.garbage().length, 1);
});

test('攻撃: 1 連鎖から、連鎖の数を書いたおじゃまを 1 個（1 連鎖なら数字 1）。全消しは +5。マージンタイムで個数が増える', () => {
  assert.equal(ATTACK_MIN_CHAIN, 1);
  assert.equal(attackFor(0), 0, '連鎖していなければ送らない');
  assert.equal(attackFor(1), 1, '1 連鎖でも、数字 1 のおじゃまを送る');
  assert.equal(attackFor(2), 2);
  assert.equal(attackFor(5), 5);
  assert.equal(attackFor(1, true), 1 + ALL_CLEAR_ATTACK);
  assert.equal(attackFor(0, true), ALL_CLEAR_ATTACK);
  assert.equal(attackFor(3, true), 3 + ALL_CLEAR_ATTACK);
  assert.equal(marginBlocks(0), 1);
  assert.equal(marginBlocks(MARGIN_MS - 1), 1);
  assert.equal(marginBlocks(MARGIN_MS), 2);
  assert.equal(marginBlocks(MARGIN_MS + MARGIN_STEP_MS), 3);
  assert.equal(marginBlocks(MARGIN_MS * 100), MARGIN_MAX);
});

test('マージンタイムを過ぎると、同じ数字のおじゃまが何個も届く', () => {
  let t = MARGIN_MS + 1;
  const a = new BattleSide({ game: battleGame(31), now: () => t });
  a.startAt = 0;
  const sent = [];
  a.hooks.send = (x) => sent.push(x);
  a.placed({ steps: [{}, {}, {}] }, 100);
  assert.equal(sent[0].count, 2);
  const b = new BattleSide({ game: battleGame(32), now: () => t });
  b.receive(sent[0]);
  assert.deepEqual(b.queue.items.map((q) => q.n), [3, 3]);
});

test('おじゃまは、一番外側の辺（直角をはさむ 2 辺）の真ん中（角）から、外へ向かって置かれる', () => {
  const b = new Board();
  const put = (random) => { const p = edgeSpot((x, r) => !!b.get(x, r), random); if (p) b.set(p.x, p.r, createGarbage(1)); return p; };
  assert.deepEqual(put(), { x: 0, r: 0 }, '空の盤面では角から');
  assert.deepEqual([put(), put()], [{ x: 1, r: 0 }, { x: 0, r: 1 }], '次は角の両隣（左右の辺）');
  assert.deepEqual([put(), put()], [{ x: 2, r: 0 }, { x: 0, r: 2 }]);
  // 一番外側の辺（輪 0 = x が 0 か r が 0 の 15 マス）がすべて埋まるまで、次の辺（輪 1）には置かない
  const ring = (p) => Math.min(p.x, p.r);
  while (b.garbage().length < 15) assert.equal(ring(put()), 0);
  assert.equal(b.garbage().length, 15);
  const next = put();
  assert.deepEqual(next, { x: 1, r: 1 }, '外側が埋まったら、次の辺の角から');
  assert.equal(ring(next), 1);
  // random を渡すと、同じ距離の左右どちらを先にするかが変わる（置くマスの集まりは同じ）
  const c = new Board();
  const seen = new Set();
  for (let seed = 1; seed < 20; seed++) { c.set(0, 0, createGarbage(1)); const p = edgeSpot((x, r) => !!c.get(x, r), rng(seed)); seen.add(p.x + ',' + p.r); }
  assert.deepEqual([...seen].sort(), ['0,1', '1,0']);
});

test('おじゃまは上にブロックがあっても関係なく、外側の辺の空きマスに置かれる。ブロックのあるマスには置かない', () => {
  const b = new Board();
  // 角（0,0）の真上の列（画面で同じ縦の列）をブロックでふさいでも、角は空いているので角に置く
  for (const [x, r] of [[1, 1], [2, 2], [3, 3]]) b.set(x, r, createBlock('x'));
  assert.deepEqual(edgeSpot((x, r) => !!b.get(x, r)), { x: 0, r: 0 });
  // 角がブロックなら、そこは飛ばして次の空きマス
  b.set(0, 0, createBlock('x'));
  assert.deepEqual(edgeSpot((x, r) => !!b.get(x, r)), { x: 1, r: 0 });
  // 一番外側の辺がおじゃまとブロックだけで埋まったら、次の辺へ
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r) && Math.min(x, r) === 0 && !b.get(x, r)) b.set(x, r, createBlock('x'));
  assert.deepEqual(edgeSpot((x, r) => !!b.get(x, r)), { x: 2, r: 1 }, '次の辺の角（1,1）もブロックなら、その次の空き');
});

test('盤面が全部埋まっていれば置く場所は無い', () => {
  const b = new Board();
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) b.set(x, r, createBlock('x'));
  assert.equal(edgeSpot((x, r) => !!b.get(x, r)), null);
  assert.equal(edgeOrder().length, 36);
});

/** 対戦のルールの Game（手駒は同期で決める） */
function battleGame(seed) {
  const g = new Game({ random: rng(seed) });
  g.setBattle(true, { tight: 0, allClear: 0 });
  return g;
}

test('Game.dropGarbage: 落としたあと、どのピースも置けなければ詰み', () => {
  const g = new Game({ random: rng(5) });
  // 1 マス以外を全部埋める（ラインは満杯にしない: 各ラインに 1 つおじゃま）
  g.board = new Board();
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r) && x + r < 7) g.board.set(x, r, createGarbage(9));
  g.tray = [new Piece('Dot0'), null, null];
  assert.equal(g.hasMove(), true);
  const res = g.dropGarbage([{ id: 'a1', n: 3 }, { id: 'a2', n: 4 }]);
  assert.equal(res.landed.length + res.left.length, 2);
  // 一番上の段は 8 マス空いているので 2 個とも入る
  assert.equal(res.landed.length, 2);
  assert.equal(res.gameOver, false);
  for (let i = 0; i < 6; i++) g.dropGarbage([{ id: 'b' + i, n: 1 }]);
  assert.equal(g.gameOver, true, '置ける場所が無くなったら詰み');
});

test('削る順番は外側から: 一番外側の辺が先、辺の中は角から一番遠い端が先。内側（角に近いもの・内側の辺）はあと', () => {
  const o = chipOrder().map((c) => c.x + ',' + c.r);
  assert.deepEqual(o.slice(0, 6), ['7,0', '0,7', '6,0', '0,6', '5,0', '0,5'], '一番外側の辺の端から');
  assert.equal(o[14], '0,0', '一番外側の辺の中では、角が最後');
  assert.equal(o[15], '6,1', 'そのあとが 2 番目の辺');
  assert.equal(o.length, 36);
  // 置く順番（角から外へ）と、輪ごとの中身は同じで、輪の中だけが逆
  const e = edgeOrder().map((c) => c.x + ',' + c.r);
  assert.deepEqual(e.slice(0, 15).sort(), o.slice(0, 15).sort());
  const g = new Game({ random: rng(9) });
  g.board = new Board();
  g.board.set(0, 0, createGarbage(5)); g.board.set(5, 0, createGarbage(5)); g.board.set(1, 1, createGarbage(5));
  const hits = g.chipGarbage(11).hits.map((h) => [h.x, h.r]);
  assert.deepEqual(hits.slice(0, 5), Array(5).fill([5, 0]), '一番外側の辺の端 (5,0) が先に 5 つぶん');
  assert.deepEqual(hits.slice(5, 10), Array(5).fill([0, 0]), 'そのあと角 (0,0)');
  assert.deepEqual(hits[10], [1, 1], '内側の辺はいちばんあと');
});

test('Game.chipGarbage: 連鎖の数がそのまま合計。5 連鎖なら一番外側のおじゃま 1 個に合計 −5（1 段ごとに −1 ずつ）', () => {
  const g = new Game({ random: rng(9) });
  g.board = new Board();
  g.board.set(0, 0, createGarbage(9));      // 角
  g.board.set(3, 0, createGarbage(7));      // 一番外側の辺で角から一番遠い → いちばん先
  g.board.set(0, 1, createGarbage(2));
  const res = g.chipGarbage(5);
  assert.deepEqual(res.hits.map((h) => [h.step, h.damage, h.x, h.r, h.from, h.n, h.removed]),
    [[1, 1, 3, 0, 7, 6, false], [2, 2, 3, 0, 6, 5, false], [3, 3, 3, 0, 5, 4, false], [4, 4, 3, 0, 4, 3, false], [5, 5, 3, 0, 3, 2, false]]);
  assert.deepEqual(res.changed.map((c) => [c.x, c.r, c.n, c.from]), [[3, 0, 2, 7]], '減ったのは外側の 1 個だけ。合計 −5');
  assert.deepEqual(res.removed, []);
  assert.equal(g.board.get(3, 0).garbage, 2);
  assert.equal(g.board.get(0, 0).garbage, 9, '内側（角に近い）のおじゃまは減らない');
  assert.equal(g.board.get(0, 1).garbage, 2);
  for (let k = 1; k <= 8; k++) {                                        // 連鎖の数 k のとき、盤面のおじゃまの数字の合計はちょうど k 減る
    const h = new Game({ random: rng(1) });
    h.board = new Board();
    h.board.set(0, 0, createGarbage(20)); h.board.set(1, 0, createGarbage(20));
    const before = h.board.garbage().reduce((a, x) => a + x.block.garbage, 0);
    h.chipGarbage(k);
    assert.equal(before - h.board.garbage().reduce((a, x) => a + x.block.garbage, 0), k, `${k} 連鎖で合計 −${k}`);
  }
});

test('Game.chipGarbage: 一番外側のおじゃまが 0 になって消えたら、残りの段は次（内側）のおじゃまへ', () => {
  const g = new Game({ random: rng(9) });
  g.board = new Board();
  g.board.set(0, 0, createGarbage(9));
  g.board.set(1, 0, createGarbage(2));      // 外側（角から遠い）→ 先
  const res = g.chipGarbage(5);              // (1,0) −1 → 1 / −1 → 消える / 角 −1 → 8 / −2 → 7 / −3 → 6
  assert.deepEqual(res.hits.map((h) => [h.x, h.r, h.damage, h.n, h.removed]),
    [[1, 0, 1, 1, false], [1, 0, 2, 0, true], [0, 0, 1, 8, false], [0, 0, 2, 7, false], [0, 0, 3, 6, false]]);
  assert.deepEqual(res.removed.map((c) => [c.x, c.r, c.from]), [[1, 0, 2]]);
  assert.deepEqual(res.changed.map((c) => [c.x, c.r, c.n, c.from]), [[0, 0, 6, 9]]);
  assert.equal(g.board.get(1, 0), null);
  // おじゃまが連鎖の数より少なければ、あるぶんだけ（余りは捨てる）
  const h = new Game({ random: rng(9) });
  h.board = new Board();
  h.board.set(0, 0, createGarbage(1));
  assert.equal(h.chipGarbage(6).hits.length, 1);
  assert.deepEqual(new Game({ random: rng(1) }).chipGarbage(0), { hits: [], changed: [], removed: [] });
});

test('連鎖したら、一番外側のおじゃまに連鎖の数ぶんだけ（1 段ごとに −1 ずつ）。置いた瞬間に確定し、ターンの記録に残る', () => {
  const g = battleGame(13);
  g.board = Board.fromHeights([0, 2, 0, 0, 0, 0, 0, 0]);       // 縦2 にあと 0 個 → 置いて連鎖させる
  g.board.set(0, 0, createGarbage(5));
  g.board.set(0, 1, createGarbage(4));                         // 角から遠い（外側）→ 先に削られる
  for (const { x, r } of lineCells('col', 2)) g.board.set(x, r, null);
  g.board.set(6, 0, createBlock('x'));                       // 縦2 の奥。もう 1 個置けば満杯
  g.tray = [new Piece('Dot0'), new Piece('Dot0'), new Piece('Dot0')];
  const turn = g.placePiece(0, 6, 1);
  assert.equal(turn.steps.length, 2, '縦2 → 縦1 の 2 連鎖');
  // 2 連鎖 = 合計 −2 を、外側の (0,1) に（1 段目 −1 → 3、2 段目 さらに −1 で合計 −2 → 2）
  assert.deepEqual(turn.chip.hits.map((h) => [h.step, h.damage, h.x, h.r, h.n, h.removed]), [[1, 1, 0, 1, 3, false], [2, 2, 0, 1, 2, false]]);
  assert.deepEqual(turn.chip.changed.map((c) => [c.x, c.r, c.n]), [[0, 1, 2]]);
  assert.deepEqual(turn.chip.removed, []);
  assert.equal(g.board.get(0, 1).garbage, 2);
  assert.equal(g.board.get(0, 0).garbage, 5, '角に近い内側のおじゃまは減らない');
});

test('連鎖でブロックが無くなり、最後のおじゃまも消えたら全消し', () => {
  const g = battleGame(14);
  g.board = new Board();
  g.board.set(0, 0, createGarbage(1));
  g.board.set(6, 0, createBlock('x'));
  g.tray = [new Piece('Dot0'), new Piece('Dot0'), new Piece('Dot0')];
  const turn = g.placePiece(0, 6, 1);
  assert.equal(turn.chip.removed.length, 1);
  assert.equal(turn.allClear, true);
});

test('対戦でなければ、おじゃまを削らない（ふだんのゲームは今までどおり）', () => {
  const g = new Game({ random: rng(15) });
  g.board = new Board();
  g.board.set(0, 0, createGarbage(1));
  g.board.set(6, 0, createBlock('x'));
  g.tray = [new Piece('Dot0'), new Piece('Dot0'), new Piece('Dot0')];
  const turn = g.placePiece(0, 6, 1);
  assert.equal(turn.chip, null);
  assert.equal(g.board.get(0, 0).garbage, 1);
});

test('相殺（予告も削る）を使うときは、置いた瞬間に予告が削れる', () => {
  let t = 0;
  const g = battleGame(16);
  const side = new BattleSide({ game: g, now: () => t, offsetPending: true });
  side.receive({ id: 'x1', n: 2, readyIn: 5000 });
  side.receive({ id: 'x2', n: 7, readyIn: 5000 });
  const turn = { steps: [{}, {}, {}] };
  side.placed(turn, 2000);
  assert.deepEqual(side.queue.items.map((q) => [q.id, q.n]), [['x2', 4]]);
  assert.equal(turn.offset.removed.length, 1);
});

test('BattleSide: 1 回に置かれる個数に上限は無い（届いて準備ができたものは全部いっぺんに）', () => {
  let t = 0;
  const g = battleGame(17);
  const side = new BattleSide({ game: g, now: () => t });
  for (let i = 0; i < 12; i++) side.receive({ id: 'x' + i, n: 3, readyIn: 0 });
  assert.equal(side.tick().landed.length, 12);
  assert.equal(side.queue.items.length, 0);
});

test('BattleSide: 1 連鎖でも数字 1 のおじゃまを送る', () => {
  const sent = [];
  const side = new BattleSide({ game: battleGame(19), now: () => 0, hooks: { send: (a) => sent.push(a) } });
  assert.equal(side.placed({ steps: [{}] }, 300), 1);
  assert.deepEqual(sent.map((a) => [a.n, a.count]), [[1, 1]]);
  assert.equal(side.placed({ steps: [] }, 0), 0, '連鎖しなければ送らない');
});

test('マージンタイム: 個数が n 個になる時刻', () => {
  assert.equal(marginStartOf(2), MARGIN_MS);
  assert.equal(marginStartOf(3), MARGIN_MS + MARGIN_STEP_MS);
  assert.equal(marginStartOf(MARGIN_MAX), MARGIN_MS + (MARGIN_MAX - 2) * MARGIN_STEP_MS);
  assert.equal(marginBlocks(marginStartOf(4) - 1), 3);
  assert.equal(marginBlocks(marginStartOf(4)), 4);
});

test('BattleSide: 落ちて置けなくなったら負け', () => {
  let t = 0, over = 0;
  const g = battleGame(18);
  g.board = new Board();
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r) && (x + r < 7 || x > 0)) g.board.set(x, r, createGarbage(9));
  g.tray = [new Piece('Dot0'), null, null];
  const side = new BattleSide({ game: g, now: () => t, hooks: { over: () => over++ } });
  side.receive({ id: 'x', n: 3, readyIn: 0 });
  side.tick();
  assert.equal(g.gameOver, true);
  assert.equal(over, 1);
  assert.equal(side.over, true);
});

test('連鎖の再生時間の見積もり（相手の画面で、その連鎖がいつ終わるか）', () => {
  assert.equal(playDuration([]), 0);
  const b = Board.fromHeights([0, 0, 0, 0, 5, 0, 0, 0]);
  const g = new Game({ random: rng(1) });
  g.board = b;
  const steps = g.resolve();
  assert.ok(steps.length >= 2);
  assert.ok(playDuration(steps) > 1000);
});

test('盤面を短い文字にして送り、相手の画面で同じ盤面に戻せる（おじゃまの数字も）', async () => {
  const { packBoard, unpackBoard, samePack } = await import('../src/core/battle.js?v=202610100228');
  const b = new Board();
  b.set(0, 0, createGarbage(12));
  b.set(3, 2, createBlock('red'));
  b.set(7, 0, createBlock('purple'));
  b.set(1, 0, createGarbage(2));
  const p = packBoard(b);
  assert.equal(p.s.length, 36);
  assert.deepEqual(p.g, [12, 2]);
  const c = unpackBoard(JSON.parse(JSON.stringify(p)));
  assert.equal(samePack(packBoard(c), p), true);
  assert.equal(c.get(0, 0).garbage, 12);
  assert.equal(c.get(3, 2).color, 'red');
});

test('相手の画面の写し（Game.mirror）は、置いた手と残りの手駒だけで、本物とまったく同じ盤面になる（連鎖・おじゃまを削るのも）', async () => {
  const { packBoard, samePack, BattleSide: Side } = await import('../src/core/battle.js?v=202610100228');
  for (let seed = 1; seed <= 4; seed++) {
    const g = battleGame(100 + seed);
    const mirror = Game.mirror(rng(9));
    let t = 0;
    const side = new Side({ game: g, now: () => t, random: rng(seed) });
    for (let turnNo = 0; turnNo < 60 && !g.gameOver; turnNo++) {
      t += 1500;
      // ときどき、おじゃまが届いて落ちる（落ちた場所は相手へも送る）
      if (turnNo % 5 === 2) side.receive({ id: `x${turnNo}`, n: 2 + (turnNo % 7), count: 1 + (turnNo % 2), readyIn: 0 });
      const drop = side.tick();
      if (drop) for (const l of drop.landed) mirror.board.set(l.x, l.r, createGarbage(l.n, 'o' + l.block.id));
      const m = bestMove(g.board, g.tray, { budgetMs: 5 });
      if (!m) break;
      const msg = { p: g.tray[m.slot].name, ox: m.ox, oy: m.oy };
      const turn = g.placePiece(m.slot, m.ox, m.oy);
      msg.rest = turn.rest;
      mirror.tray = [new Piece(msg.p), ...msg.rest.map((n) => new Piece(n))].concat([null, null]).slice(0, 3);
      const mt = mirror.placePiece(0, msg.ox, msg.oy);
      assert.ok(mt, `写しにも置ける (seed ${seed} turn ${turnNo})`);
      assert.equal(mt.steps.length, turn.steps.length, '連鎖の数が同じ');
      assert.equal(samePack(packBoard(mirror.board), packBoard(g.board)), true, `盤面が同じ (seed ${seed} turn ${turnNo})`);
    }
  }
});

test('対戦の手駒: 同じ種なら 2 人とも同じ順番で出て、使った枠にすぐ次が入る', () => {
  const seed = seedOf('room-1:0');
  assert.equal(seed, seedOf('room-1:0'));
  assert.notEqual(seed, seedOf('room-1:1'), '何戦目かで変わる');
  const a = new Game({ random: rng(1), battle: { rates: null, seed } });
  const b = new Game({ random: rng(2), battle: { rates: null, seed } });
  const names = (g) => g.tray.map((p) => p && p.name);
  assert.deepEqual(names(a), names(b), '最初の手駒が同じ');
  // 置く枠も置く場所もちがっても、出てくる順番は同じ
  const seqA = [], seqB = [];
  for (let k = 0; k < 6; k++) {
    for (const [g, seq, pick] of [[a, seqA, 0], [b, seqB, 2]]) {
      const m = bestMove(g.board, g.tray, { budgetMs: 5 });
      if (!m) continue;
      const before = names(g);
      const turn = g.placePiece(m.slot, m.ox, m.oy);
      assert.equal(turn.refilled, true);
      assert.equal(turn.refillSlot, m.slot, '使った枠に補充');
      assert.deepEqual(names(g).filter((_, i) => i !== m.slot), before.filter((_, i) => i !== m.slot), 'ほかの枠はそのまま');
      seq.push(g.tray[m.slot].name);
      void pick;
    }
  }
  const n = Math.min(seqA.length, seqB.length);
  assert.ok(n >= 3);
  assert.deepEqual(seqA.slice(0, n), seqB.slice(0, n), '補充される手駒の順番が同じ');
  const c = new Game({ random: rng(3), battle: { rates: null, seed: seed + 1 } });
  assert.notDeepEqual(names(c), names(a), 'ちがう種なら、ちがう手駒');
  // 対戦をやめたら、ふだんの決め方に戻る
  a.setBattle(false); a.reset();
  assert.equal(a.stream, null);
  assert.equal(a.tray.filter(Boolean).length, 3);
  assert.equal(typeof seededRandom(5)(), 'number');
});

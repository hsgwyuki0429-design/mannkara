import test from 'node:test';
import assert from 'node:assert/strict';
import { Board, createBlock, createGarbage, isGarbage } from '../src/core/board.js?v=202610091147';
import { resolveChains, resolveLine } from '../src/core/mancala.js?v=202610091147';
import * as Sim from '../src/core/sim.js?v=202610091147';
import { Game } from '../src/core/game.js?v=202610091147';
import { Piece, seededRandom, seedOf } from '../src/core/pieces.js?v=202610091147';
import { DealerCore } from '../src/core/dealer.js?v=202610091147';
import { bestMove, evaluate } from '../src/core/advisor.js?v=202610091147';
import { lineCells, isInside, SIZE } from '../src/core/constants.js?v=202610091147';
import {
  attackFor, marginBlocks, dropPath, GarbageQueue, BattleSide, playDuration, ATTACK_MIN_CHAIN, ALL_CLEAR_ATTACK,
  MARGIN_MS, MARGIN_STEP_MS, MARGIN_MAX, DROP_MAX,
} from '../src/core/battle.js?v=202610091147';

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

test('攻撃: 2 連鎖から、連鎖の数を書いたおじゃまを 1 個。全消しは +5。マージンタイムで個数が増える', () => {
  assert.equal(ATTACK_MIN_CHAIN, 2);
  assert.equal(attackFor(0), 0);
  assert.equal(attackFor(1), 0);
  assert.equal(attackFor(2), 2);
  assert.equal(attackFor(5), 5);
  assert.equal(attackFor(1, true), ALL_CLEAR_ATTACK);
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

test('おじゃまは V 字の盤面の一番低いところ（直角の角）から積もる', () => {
  const b = new Board();
  const random = rng(3);
  const at = () => { const p = dropPath((x, r) => !!b.get(x, r), random); b.set(p.x, p.r, createGarbage(1)); return p; };
  const p1 = at();
  assert.deepEqual([p1.x, p1.r], [0, 0], '空の盤面では一番下の角');
  const p2 = at(), p3 = at();
  assert.deepEqual([[p2.x, p2.r], [p3.x, p3.r]].map(([x, r]) => x + r).sort(), [1, 1], '次は 1 段上の 2 マス');
  const p4 = at();
  assert.equal(p4.x + p4.r, 2);
  // 道のりは盤面の上から始まり、1 歩ずつ下（x + r が減る）へ進んで、空いているマスだけを通る
  for (const p of [p1, p2, p3, p4]) {
    assert.ok(p.path[0].x + p.path[0].r >= SIZE, '盤面の上から落ちてくる');
    for (let i = 1; i < p.path.length; i++) {
      const a = p.path[i - 1], c = p.path[i];
      assert.ok(c.x + c.r < a.x + a.r, '下へ進む');
      assert.ok(Math.abs(c.x - a.x) <= 1 && Math.abs(c.r - a.r) <= 1);
    }
    const last = p.path.at(-1);
    assert.deepEqual([last.x, last.r], [p.x, p.r]);
  }
});

test('おじゃまはブロックをすり抜けない（上からふさがれた穴には入らない）', () => {
  const b = new Board();
  // 一番上の段（斜辺に沿った 8 マス）を全部埋めると、上から落ちてくる道が無い
  for (let x = 0; x < SIZE; x++) b.set(x, SIZE - 1 - x, createBlock('x'));
  assert.equal(dropPath((x, r) => !!b.get(x, r), rng(1)), null);
  // 1 か所だけ空けると、その下へ落ちていく
  b.set(3, 4, null);
  const p = dropPath((x, r) => !!b.get(x, r), rng(1));
  assert.ok(p && p.x + p.r <= 7);
  for (const q of p.path) if (isInside(q.x, q.r)) assert.equal(b.get(q.x, q.r), null, '通るマスは空いている');
});

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

test('Game.chipGarbage: 連鎖の数だけ数字が減り、0 で消える', () => {
  const g = new Game({ random: rng(9) });
  g.board = new Board();
  g.board.set(0, 0, createGarbage(5));
  g.board.set(1, 0, createGarbage(2));
  const res = g.chipGarbage(3);
  assert.deepEqual(res.changed.map((c) => [c.x, c.r, c.n, c.from]), [[0, 0, 2, 5]]);
  assert.deepEqual(res.removed.map((c) => [c.x, c.r, c.from]), [[1, 0, 2]]);
  assert.equal(g.board.get(1, 0), null);
  assert.equal(g.board.get(0, 0).garbage, 2);
});

test('途中の保存にも、おじゃまの数字が残る', () => {
  const g = new Game({ random: rng(9) });
  g.board.set(0, 0, createGarbage(6));
  const st = JSON.parse(JSON.stringify(g.exportState()));
  const h = new Game({ random: rng(10) });
  h.importState(st);
  assert.equal(isGarbage(h.board.get(0, 0)), true);
  assert.equal(h.board.get(0, 0).garbage, 6);
});

test('手駒の決め方・おすすめも、おじゃまを動かない壁として読む', () => {
  const core = new DealerCore(rng(4));
  const garbage = [0, 1, 8];                // (0,0) (1,0) (0,1)
  const res = core.deal([], 0, 0, garbage);
  assert.equal(res.names.length, 3);
  const m = core.hint([], ['O0', null, null], garbage);
  assert.ok(m);
  const cells = new Piece('O0').cells.map((c) => (m.oy + c.y) * SIZE + m.ox + c.x);
  for (const i of garbage) assert.equal(cells.includes(i), false, 'おじゃまの上には置かない');
});

test('おすすめの盤面の良さ: おじゃまが入ったラインは「あと 1 個」に数えない', () => {
  const b = new Board();
  setLine(b, 'col', 3, [1, 'g', 0]);
  const c = new Board();
  setLine(c, 'col', 3, [1, 1, 0]);
  assert.ok(evaluate(Sim.fromBoard(c)) > evaluate(Sim.fromBoard(b)));
});

test('予告: 自分の連鎖で全部が削れ、0 になったら消える。落ちるのは相手の連鎖が終わってから', () => {
  const q = new GarbageQueue();
  q.add({ id: 'a', n: 5, readyAt: 100 });
  q.add({ id: 'b', n: 2, readyAt: 300 });
  assert.equal(q.add({ id: 'a', n: 9 }), false, '同じおじゃまは 2 回入れない');
  assert.deepEqual(q.offset(2), { changed: [{ id: 'a', n: 3, from: 5 }], removed: [{ id: 'b', from: 2 }] });
  assert.equal(q.total, 3);
  assert.deepEqual(q.ready(50), []);
  assert.deepEqual(q.take(150).map((g) => g.id), ['a']);
  assert.equal(q.items.length, 0);
});

/** 対戦のルールの Game（手駒は同期で決める） */
function battleGame(seed) {
  const g = new Game({ random: rng(seed) });
  g.setBattle(true, { tight: 0, allClear: 0 });
  return g;
}

test('BattleSide: 置いて連鎖したら送る。届いたおじゃまは、相手の連鎖が終わったらすぐ落ちる（自分が連鎖中なら、その連鎖が終わったらすぐ）', () => {
  let t = 0, busy = false;
  const now = () => t;
  const g = battleGame(11);
  const sent = [], drops = [];
  const side = new BattleSide({ game: g, now, random: rng(2), busy: () => busy, hooks: { send: (a) => sent.push(a), drop: (r) => drops.push(r) } });
  // 2 連鎖のターン
  const turn = { steps: [{}, {}], allClear: false };
  assert.equal(side.placed(turn, 1200), 2);
  assert.deepEqual(sent, [{ id: 'a1', n: 2, count: 1, readyIn: 1200 }]);
  assert.deepEqual(turn.attack, sent[0], 'ターンの記録にも残す（画面で飛ばす）');
  assert.equal(side.placed({ steps: [{}] }, 0), 0, '1 連鎖では送らない');
  // 相手から届く（相手の連鎖はあと 1000ms）
  side.receive({ id: 'x1', n: 4, readyIn: 1000 });
  assert.equal(side.tick(), null, '相手の連鎖の最中は落ちない');
  t = 1000;
  const res = side.tick();
  assert.equal(res.landed.length, 1, '相手の連鎖が終わったら、置かなくてもすぐ落ちる');
  assert.equal(res.landed[0].block.garbage, 4);
  assert.deepEqual([res.landed[0].x, res.landed[0].r], [0, 0]);
  assert.equal(drops.length, 1);
  // 自分が連鎖している間に、相手の連鎖が終わった
  side.receive({ id: 'x2', n: 3, readyIn: 500 });
  busy = true;
  t = 2000;
  assert.equal(side.tick(), null, '自分の連鎖の再生中は落ちない');
  busy = false;
  assert.equal(side.tick().landed.length, 1, '自分の連鎖が終わったらすぐ落ちる');
});

test('BattleSide: 上までふさがって落とせなかったら、次に置くまで待つ', () => {
  let t = 0;
  const g = battleGame(12);
  g.board = new Board();
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) g.board.set(x, r, createBlock('x'));
  const side = new BattleSide({ game: g, now: () => t, random: rng(2) });
  side.receive({ id: 'x1', n: 2, readyIn: 0 });
  assert.equal(side.tick(), null);
  assert.equal(side.stuck, true);
  assert.equal(side.queue.items.length, 1, '予告に残る');
  side.placed({ steps: [] }, 0);
  assert.equal(side.stuck, false, '置いたら、もう一度落とせるか試す');
});

test('連鎖したら、その数だけ盤面のおじゃまが削れる（置いた瞬間に確定し、ターンの記録に残る）', () => {
  const g = battleGame(13);
  g.board = Board.fromHeights([0, 2, 0, 0, 0, 0, 0, 0]);       // 縦2 にあと 0 個 → 置いて連鎖させる
  g.board.set(0, 0, createGarbage(5));
  g.board.set(0, 1, createGarbage(1));
  for (const { x, r } of lineCells('col', 2)) g.board.set(x, r, null);
  g.board.set(6, 0, createBlock('x'));                       // 縦2 の奥。もう 1 個置けば満杯
  g.tray = [new Piece('Dot0'), new Piece('Dot0'), new Piece('Dot0')];
  const turn = g.placePiece(0, 6, 1);
  assert.equal(turn.steps.length, 2, '縦2 → 縦1 の 2 連鎖');
  assert.deepEqual(turn.chip.changed.map((c) => [c.x, c.r, c.n]), [[0, 0, 3]]);
  assert.deepEqual(turn.chip.removed.map((c) => [c.x, c.r]), [[0, 1]]);
  assert.equal(g.board.get(0, 0).garbage, 3);
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

test('BattleSide: 1 回に落ちるのは DROP_MAX 個まで（残りは次）', () => {
  let t = 0;
  const g = battleGame(17);
  const side = new BattleSide({ game: g, now: () => t });
  for (let i = 0; i < DROP_MAX + 2; i++) side.receive({ id: 'x' + i, n: 3, readyIn: 0 });
  assert.equal(side.tick().landed.length, DROP_MAX);
  assert.equal(side.queue.items.length, 2);
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
  const { packBoard, unpackBoard, samePack } = await import('../src/core/battle.js?v=202610091147');
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
  const { packBoard, samePack, BattleSide: Side } = await import('../src/core/battle.js?v=202610091147');
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

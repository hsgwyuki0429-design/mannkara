import { Board, createBlock } from '../src/core/board.js';
import { resolveChains, resolveColumn, nextActivation } from '../src/core/mancala.js';
import { Piece, PieceGenerator, SHAPES } from '../src/core/pieces.js';
import { Game } from '../src/core/game.js';
import { isInside, capacity, toColSlot, toScreen, SIZE } from '../src/core/constants.js';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
}
const H = (b) => b.heights;                                   // [列1 … 列8]
const pattern = (b, i) => b.columns[i].map((v) => (v ? 1 : 0)); // 下→上
/** 列 i に下から pattern(1/0) を置く */
function setCol(b, i, bits) { bits.forEach((v, k) => { b.columns[i][k] = v ? createBlock('debug') : null; }); }

console.log('盤面形状: 8×8 の三角形、列N は N マス');
{
  eq([...Array(SIZE)].map((_, i) => capacity(i)), [1,2,3,4,5,6,7,8], '容量 = 列番号');
  let n = 0; for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r)) n++;
  eq(n, 36, 'マス数 36 (= 8+7+…+1)');
  eq(isInside(7, 0), true, '列1 は上端の1マスだけ');
  eq(isInside(7, 1), false, '列1 の2マス目は無い');
  eq(isInside(0, 7), true, '列8 は下端まである');
  eq(toColSlot(0, 7), { colIndex: 7, slot: 0 }, '列8 の一番下 = slot0');
  eq(toScreen(0, 0), { x: 7, r: 0 }, '列1 slot0 = 右上');
}

console.log('重力なし: 置いた場所に残る');
{
  const b = new Board();
  b.place(new Piece('1'), 0, 0);                  // 列8 の一番上
  eq(pattern(b, 7), [0,0,0,0,0,0,0,1], '列8 の最上段に浮いたまま');
  eq(b.canPlace(new Piece('1'), 0, 0), false, '埋まったマスには置けない');
  eq(b.canPlace(new Piece('2h'), 6, 1), false, '三角形の外には置けない');
}

console.log('Case A: 列1が埋まる -> ゴール');
{
  const b = Board.fromHeights([1,0,0,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(steps.map((s) => s.column), [1], '列1 発動');
  eq(H(b), [0,0,0,0,0,0,0,0], '空になる');
}

console.log('Case B: 列2 が満杯 -> 列1へ1個 + ゴール -> 列1 発動');
{
  const b = Board.fromHeights([0,2,0,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(steps.map((s) => s.column), [2,1], '列2 -> 列1');
  eq(H(b), [0,0,0,0,0,0,0,0], '空になる');
}

console.log('Case C: 列5 が満杯 -> 列4,3,2,1,ゴール');
{
  const b = Board.fromHeights([0,0,0,0,5,0,0,0]);
  const step = resolveColumn(b, 5);
  eq(step.moves.map((m) => m.to), [4,3,2,1,'goal'], '配る順');
  eq(step.moves.at(-1).block.id, step.stack[0].id, 'ゴールへ行くのは一番下のブロック');
}

console.log('押し上げ: 一番下の空欄までだけが上がり、空欄が1つ消える');
{
  const b = new Board();
  setCol(b, 3, [1,0,1,0]);                 // 列4: 下から ■□■□
  const ids = b.columns[3].map((v) => v?.id ?? null);
  b.insertBottom(3, createBlock('x'));
  eq(pattern(b, 3), [1,1,1,0], '■■■□ になる（下の空欄が埋まる）');
  eq(b.columns[3][1].id, ids[0], '元の一番下が1段上がった');
  eq(b.columns[3][2].id, ids[2], '空欄より上のブロックは動かない');
}
{
  const b = new Board();
  setCol(b, 3, [0,1,1,0]);                 // 列4: □■■□ -> 押し込むと一番下の空欄(slot0)が埋まるだけ
  b.insertBottom(3, createBlock('x'));
  eq(pattern(b, 3), [1,1,1,0], '□■■□ -> ■■■□');
}

console.log('穴あき列への配布で満杯になり連鎖');
{
  const b = new Board();
  setCol(b, 4, [1,1,1,1,1]);               // 列5 満杯
  setCol(b, 3, [0,1,1,1]);                 // 列4 は一番下だけ空欄
  const steps = resolveChains(b);
  eq(steps[0].column, 5, '列5 発動');
  eq(steps[1].column, 1, '列1 が最小なので先');
  eq(steps.some((s) => s.column === 4), true, '列4 も押し上げで満杯になり発動');
}

console.log('Case G/H: 複数の列が同時に満杯 -> 最小番号から、毎回再判定');
{
  const b = Board.fromHeights([0,2,3,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(steps[0].column, 2, '最初は列2');
  eq(steps.map((s) => s.column), [2,1,3,1], '列2 -> 1 -> 3 -> 1');
  eq(H(b), [0,1,0,0,0,0,0,0], '列2 に1個残る');
}

console.log('Case I: 長い連鎖でも毎回最小番号を1列ずつ');
{
  const b = Board.fromHeights([1,2,3,4,5,6,7,8]);
  // 全マス埋まっている = 横ラインも全部満杯なので、先に横ラインが全部消える
  const steps = resolveChains(b);
  eq(steps[0].type, 'rows', '横ラインが先');
  eq(H(b), [0,0,0,0,0,0,0,0], '全消し');
}
{
  // 穴あき列を押し上げで次々に満杯にしていく連鎖
  const b = new Board();
  setCol(b, 4, [1,1,1,1,1]);   // 列5 満杯
  setCol(b, 3, [0,1,1,1]);     // 列4 一番下だけ空欄
  setCol(b, 2, [0,1,1]);       // 列3
  setCol(b, 1, [0,1]);         // 列2
  const steps = resolveChains(b);
  eq(steps.map((s) => s.column), [5,1,2,1,3,1,4,1,2,1], '10連鎖');
  eq(H(b), [0,0,1,0,0,0,0,0], '列3 に1個残る');
}
{
  // ランダム盤面: 各ステップが「その時点の最優先」と一致するか
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let ok = true;
  for (let t = 0; t < 300; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.7) b.set(x, r, createBlock('x'));
    const check = b.clone();
    for (const s of resolveChains(b)) {
      const act = nextActivation(check);
      if (!act || act.type !== s.type || (s.type === 'column' && act.column !== s.column)) { ok = false; break; }
      if (s.type === 'column') resolveColumn(check, s.column); else act.rows.forEach((r) => check.clearRow(r));
    }
    if (nextActivation(b) !== null) ok = false;
  }
  eq(ok, true, 'ランダム300盤面で優先順位どおり・最後は発動なし');
}

console.log('横ライン: 揃ったらその場で消えてゴール扱い');
{
  const b = new Board();
  for (let x = 0; x < 3; x++) b.set(x, 5, createBlock('x'));   // r=5 は3マス (x=0..2)
  const steps = resolveChains(b);
  eq(steps.map((s) => s.type), ['rows'], '横ライン発動');
  eq(steps[0].goals, 3, '3個ゴール');
  eq(b.totalBlocks(), 0, '消えた');
}
{
  const b = new Board();
  b.set(0, 7, createBlock('x'));                              // r=7 は1マス（列8の一番下）
  eq(resolveChains(b).map((s) => s.type), ['rows'], '左下の1マスは置いた瞬間に消える');
}
{
  const b = new Board();
  for (let x = 0; x < 7; x++) b.set(x, 0, createBlock('x'));  // 最上段 8マス中7マス
  eq(nextActivation(b), null, '1マス足りない横ラインは発動しない');
}

console.log('Case J: 同じ形が複数出ても動作する');
{
  const gen = new PieceGenerator(() => 0);
  const tray = gen.spawnTray(3);
  eq(tray.map((p) => p.name), ['1','1','1'], '同じ形3つ');
  eq(SHAPES.every((s) => s.cells.length >= 1), true, '全形状が有効');
}

console.log('Game: 3つ使い切るまで補充しない / 置けなくなったらゲームオーバー');
{
  const g = new Game({ random: () => 0 });           // 常に 1マスピース
  eq(g.tray.length, 3, 'トレイは3つ');
  await g.placePiece(0, 0, 0);
  eq(g.tray.filter(Boolean).length, 2, '1つ使うと残り2');
  await g.placePiece(1, 1, 0);
  await g.placePiece(2, 2, 0);
  eq(g.tray.filter(Boolean).length, 3, '使い切ったら3つ補充');
  eq(g.score.score > 0, true, 'スコアが入る');
}
{
  const g = new Game({ random: () => 0.999 });
  // 盤面を市松模様で埋めて、大きいピースを置けなくする
  for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && (x + r) % 2 === 0) g.board.set(x, r, createBlock('x'));
  eq(g.hasMove(), g.tray.some((p) => p.size === 1), '1マス以外は置けない');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

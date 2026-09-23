import { Board, createBlock } from '../src/core/board.js';
import { resolveChains, resolveLine, nextActivation } from '../src/core/mancala.js';
import { Piece, PieceGenerator, SHAPES } from '../src/core/pieces.js';
import { Game } from '../src/core/game.js';
import { isInside, lineCells, SIZE } from '../src/core/constants.js';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
}
const pat = (b, kind, n) => b.line(kind, n).map((v) => (v ? 1 : 0));     // slot0(斜辺側)→奥
function setLine(b, kind, n, bits) {
  lineCells(kind, n).forEach(({ x, r }, k) => b.set(x, r, bits[k] ? createBlock('debug') : null));
}
const seq = (steps) => steps.map((s) => (s.kind === 'col' ? 'c' : 'r') + s.n).join(' ');
const transpose = (b) => { const t = new Board(); for (const { block, x, r } of b.entries()) t.set(r, x, { ...block }); return t; };

console.log('盤面形状とライン');
{
  let n = 0; for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r)) n++;
  eq(n, 36, 'マス数 36');
  eq(lineCells('col', 1), [{ x: 7, r: 0 }], '縦1 = 右上の1マス');
  eq(lineCells('row', 1), [{ x: 0, r: 7 }], '横1 = 左下の1マス');
  eq(lineCells('col', 3), [{ x: 5, r: 2 }, { x: 5, r: 1 }, { x: 5, r: 0 }], '縦列の slot0 は下端');
  eq(lineCells('row', 3), [{ x: 2, r: 5 }, { x: 1, r: 5 }, { x: 0, r: 5 }], '横列の slot0 は右端');
}

console.log('重力なし');
{
  const b = new Board();
  b.place(new Piece('1'), 0, 0);
  eq(b.get(0, 0) != null && b.totalBlocks() === 1, true, '置いた場所に残る');
  eq(b.canPlace(new Piece('2h'), 6, 1), false, '三角形の外には置けない');
}

console.log('縦列: A〜C');
{
  const b = Board.fromHeights([1,0,0,0,0,0,0,0]);
  eq(seq(resolveChains(b)), 'c1', 'A: 縦1 -> ゴール');
  const b2 = Board.fromHeights([0,2,0,0,0,0,0,0]);
  eq(seq(resolveChains(b2)), 'c2 c1', 'B: 縦2 -> 縦1');
  const b3 = Board.fromHeights([0,0,0,0,5,0,0,0]);
  const st = resolveLine(b3, 'col', 5);
  eq(st.moves.map((m) => m.to), [4,3,2,1,'goal'], 'C: 縦4,3,2,1,ゴール');
  eq(st.moves.at(-1).block.id, st.stack[0].id, 'ゴールへ行くのは下端のブロック');
}

console.log('横列: 縦列と同じ挙動');
{
  const b = new Board();
  setLine(b, 'row', 3, [1,1,1]);                 // 横3 満杯（r=5, x=0..2）
  const st = resolveLine(b, 'row', 3);
  eq(st.moves.map((m) => m.to), [2,1,'goal'], '横2, 横1, ゴールへ配る');
  eq(st.moves.at(-1).block.id, st.stack[0].id, 'ゴールへ行くのは右端のブロック');
  eq(pat(b, 'row', 2), [1,0], '横2 の右端に入る');
  eq(pat(b, 'row', 1), [1], '横1 に入る');
}
{
  const b = new Board();
  setLine(b, 'row', 4, [1,0,1,1]);               // 横4: 右から ■□■■
  const ids = b.line('row', 4).map((v) => v?.id ?? null);
  b.insertBottom('row', 4, createBlock('x'));
  eq(pat(b, 'row', 4), [1,1,1,1], '右端から押し込み、一番近い空欄まで左へずれる');
  eq(b.line('row', 4)[1].id, ids[0], '右端のブロックが1マス左へ');
  eq(b.line('row', 4)[3].id, ids[3], '空欄より奥は動かない');
}
{
  const b = new Board();
  setLine(b, 'row', 2, [1,1]);
  eq(seq(resolveChains(b)), 'r2 r1', '横2 -> 横1 の連鎖');
  eq(b.totalBlocks(), 0, '空になる');
}

console.log('押し上げ（縦）: 一番下の空欄までだけが上がる');
{
  const b = new Board();
  setLine(b, 'col', 4, [1,0,1,0]);
  const ids = b.line('col', 4).map((v) => v?.id ?? null);
  b.insertBottom('col', 4, createBlock('x'));
  eq(pat(b, 'col', 4), [1,1,1,0], '■□■□ -> ■■■□');
  eq(b.line('col', 4)[1].id, ids[0], '元の一番下が1段上がった');
  eq(b.line('col', 4)[2].id, ids[2], '空欄より上は動かない');
}

console.log('優先順位: 縦横まとめて最小番号、同番号なら縦が先');
{
  const b = new Board();
  setLine(b, 'col', 3, [1,1,1]);
  setLine(b, 'row', 2, [1,1]);
  eq(nextActivation(b), { kind: 'row', n: 2 }, '縦3 より 横2 が先');
}
{
  const b = new Board();
  setLine(b, 'col', 2, [1,1]);
  setLine(b, 'row', 2, [1,1]);
  eq(nextActivation(b), { kind: 'col', n: 2 }, '縦2 と 横2 なら縦2 が先');
}
{
  const b = Board.fromHeights([0,2,3,0,0,0,0,0]);
  eq(seq(resolveChains(b)).startsWith('c2 c1 c3'), true, '縦2 -> 縦1 -> 縦3 …（再判定しながら）');
}

console.log('長い連鎖（穴あきラインを押し込みで埋めていく）');
{
  const b = new Board();
  setLine(b, 'col', 5, [1,1,1,1,1]);
  setLine(b, 'col', 4, [0,1,1,1]);
  setLine(b, 'col', 3, [0,1,1]);
  setLine(b, 'col', 2, [0,1]);
  const steps = resolveChains(b);
  eq(steps.length >= 8, true, `連鎖数 ${steps.length}: ${seq(steps)}`);
}
{
  // ランダム盤面: 各ステップが「その時点の最優先」と一致し、最後は発動なし
  let seed = 11;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let ok = true;
  for (let t = 0; t < 300 && ok; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.7) b.set(x, r, createBlock('x'));
    const check = b.clone();
    for (const s of resolveChains(b)) {
      const act = nextActivation(check);
      if (!act || act.kind !== s.kind || act.n !== s.n) { ok = false; break; }
      resolveLine(check, act.kind, act.n);
    }
    if (nextActivation(b) !== null) ok = false;
  }
  eq(ok, true, 'ランダム300盤面で優先順位どおり');
}
{
  // 対称性: 縦横を入れ替えた盤面では、縦と横が入れ替わった同じ連鎖が起きる（同番号の同時満杯が無い場合）
  let seed = 5, checked = 0, ok = true;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 400; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.55) b.set(x, r, createBlock('x'));
    const tb = transpose(b);
    // 同番号の縦横が同時に満杯になる局面（タイブレークで縦優先）がある盤面は対称にならないので除外
    const hasTie = (bb) => { const c = bb.clone(); for (let a; (a = nextActivation(c)); ) { if (c.fullLines().some((l) => l.n === a.n && l.kind !== a.kind)) return true; resolveLine(c, a.kind, a.n); } return false; };
    if (hasTie(b) || hasTie(tb)) continue;
    const s1 = resolveChains(b), s2 = resolveChains(tb);
    const flip = seq(s1).replace(/c/g, 'X').replace(/r/g, 'c').replace(/X/g, 'r');
    checked++;
    if (flip !== seq(s2)) { ok = false; break; }
  }
  eq(ok && checked > 50, true, `縦横入れ替えで対称な連鎖になる（${checked}盤面）`);
}

console.log('一番長いライン（縦8・横8）について');
{
  const b = new Board();
  setLine(b, 'col', 8, [1,1,1,1,1,1,1,1]);
  eq(nextActivation(b), { kind: 'row', n: 1 }, '縦8 が満杯なら角の横1 も満杯なので横1 が先に発動する');
}

console.log('トレイ・ゲームオーバー');
{
  const gen = new PieceGenerator(() => 0);
  eq(gen.spawnTray(3).map((p) => p.name), ['1','1','1'], 'J: 同じ形が複数出てもよい');
  eq(SHAPES.every((s) => s.cells.length >= 1), true, '全形状が有効');
  const g = new Game({ random: () => 0 });
  await g.placePiece(0, 0, 0);
  eq(g.tray.filter(Boolean).length, 2, '1つ使うと残り2');
  await g.placePiece(1, 1, 0);
  await g.placePiece(2, 2, 0);
  eq(g.tray.filter(Boolean).length, 3, '使い切ったら3つ補充');
  eq(g.score.score > 0, true, 'スコアが入る');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

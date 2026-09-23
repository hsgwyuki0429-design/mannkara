import { Board, createBlock } from '../src/core/board.js?v=202609230405';
import { resolveChains, resolveLine, nextActivation } from '../src/core/mancala.js?v=202609230405';
import { Piece, PieceGenerator, SHAPES } from '../src/core/pieces.js?v=202609230405';
import { Game, isSolvable } from '../src/core/game.js?v=202609230405';
import { isInside, lineCells, SIZE } from '../src/core/constants.js?v=202609230405';

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
  b.place(new Piece('O0'), 0, 0);
  eq(b.get(0, 0) != null && b.get(1, 1) != null && b.totalBlocks() === 4, true, '置いた場所に残る');
  eq(b.canPlace(new Piece('I0'), 5, 1), false, '三角形の外には置けない');
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

console.log('優先順位: 縦横まとめて番号が大きい方が先、同番号なら縦が先');
{
  const b = new Board();
  setLine(b, 'col', 3, [1,1,1]);
  setLine(b, 'row', 2, [1,1]);
  eq(nextActivation(b), { kind: 'col', n: 3 }, '縦3 と 横2 なら縦3 が先');
}
{
  const b = new Board();
  setLine(b, 'row', 4, [1,1,1,1]);
  setLine(b, 'col', 2, [1,1]);
  eq(nextActivation(b), { kind: 'row', n: 4 }, '横4 と 縦2 なら横4 が先');
}
{
  const b = new Board();
  setLine(b, 'col', 2, [1,1]);
  setLine(b, 'row', 2, [1,1]);
  eq(nextActivation(b), { kind: 'col', n: 2 }, '縦2 と 横2 なら縦2 が先');
}
{
  const b = Board.fromHeights([0,2,3,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(seq(steps), 'c3 c2 c1', '縦3 -> 縦2 -> 縦1（大きい方から）');
  eq(steps[0].goals, 2, '縦3 の配布先の縦2 は満杯なので、その1個はゴールへ（計2個）');
  eq(b.totalBlocks(), 0, '全部ゴールへ');
}
{
  const b = new Board();
  setLine(b, 'col', 8, [1,1,1,1,1,1,1,1]);
  eq(nextActivation(b), { kind: 'col', n: 8 }, '縦8 と角の横1 が満杯なら縦8 が先（縦8 も発動できる）');
}

console.log('長い連鎖（穴あきラインを押し込みで埋めていく）');
{
  const b = new Board();
  setLine(b, 'col', 5, [1,1,1,1,1]);
  setLine(b, 'col', 4, [0,1,1,1]);
  setLine(b, 'col', 3, [0,1,1]);
  setLine(b, 'col', 2, [0,1]);
  const steps = resolveChains(b);
  eq(steps[0].n === 5 && steps[1].n === 4, true, `押し込みで埋まった縦4 が次に発動: ${seq(steps)}`);
  eq(b.totalBlocks(), 0, '全部ゴールへ');
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

console.log('手駒: テトロミノのみ');
{
  eq(SHAPES.length, 19, 'テトロミノの全向き 19 種');
  eq(SHAPES.every((s) => s.cells.length === 4), true, 'すべて4マス');
  eq([...new Set(SHAPES.map((s) => s.type))].sort().join(''), 'IJLOSTZ', '7種類');
  const gen = new PieceGenerator(() => 0);
  eq(gen.spawnTray(3).map((p) => p.name), ['I0','I0','I0'], 'J: 同じ形が複数出てもよい');
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g2 = new PieceGenerator(rnd), cnt = {};
  for (let i = 0; i < 14000; i++) { const t = g2.next().type; cnt[t] = (cnt[t] || 0) + 1; }
  eq(Object.values(cnt).every((v) => v > 1700 && v < 2300), true, `7種類がほぼ均等 ${JSON.stringify(cnt)}`);
}

console.log('連鎖ピース: 約10% の確率で、置けば発動が起きるテトロミノ');
{
  let seed = 9; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new Game({ random: rnd });
  // 何も発動しない盤面を作る：縦1 以外のいくつかを埋める
  setLine(g.board, 'col', 3, [1,1,0]);
  setLine(g.board, 'row', 5, [0,1,1,1,0]);
  const chainers = g.chainPieces();
  eq(chainers.length > 0, true, `発動を起こせる向きが見つかる (${chainers.length}種)`);
  // その向きは実際にどこかへ置けば発動する
  const ok = chainers.every(({ name }) => {
    const p = new Piece(name);
    for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) {
      if (!g.board.canPlace(p, ox, oy)) continue;
      const b = g.board.clone(); b.place(p, ox, oy);
      if (nextActivation(b)) return true;
    }
    return false;
  });
  eq(ok, true, '選ばれる向きは必ず発動を起こせる');
  // 確率: spawnTray で通常抽選(next)を通らなかった枠 = 連鎖ピースとして選ばれた枠
  let total = 0;
  const g3 = new Game({ random: rnd }); g3.board = g.board.clone();
  const origNext = g3.generator.next.bind(g3.generator);
  let naturalCount = 0;
  g3.generator.next = () => { naturalCount++; return origNext(); };
  for (let i = 0; i < 4000; i++) { g3.spawnTray(); total += 3; }
  const rate = (total - naturalCount) / total;
  eq(rate > 0.085 && rate < 0.115, true, `連鎖ピースの割合 ${(rate * 100).toFixed(1)}%`);
}

console.log('トレイ保証: 必ず1つは置ける / 9割は3つとも置ける');
{
  // 置ける場所が限られた盤面: 右上の角まわりだけ空ける
  const b = new Board();
  for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r)) b.set(x, r, createBlock('x'));
  [[4,0],[5,0],[6,0],[7,0]].forEach(([x, r]) => b.set(x, r, null));    // 横8 の右4マスだけ空き
  eq(isSolvable(b, [new Piece('I0')]), true, 'I横 は置ける');
  eq(isSolvable(b, [new Piece('O0')]), false, 'O は置けない');
  // I横 を置くと横8 が揃って発動し、スペースが空くので2つ目以降も置ける可能性がある
  eq(typeof isSolvable(b, [new Piece('I0'), new Piece('O0'), new Piece('T0')]), 'boolean', '連鎖込みで判定できる');
}
{
  let seed = 21; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  let trays = 0, oneFits = 0, solvable = 0, unavoidable = 0;
  for (let t = 0; t < 250; t++) {
    const g = new Game({ random: rnd });
    // ランダムに埋めた盤面（発動が起きない状態まで解決しておく）
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.6) g.board.set(x, r, createBlock('x'));
    resolveChains(g.board);
    if (!SHAPES.some((sh) => g.board.fits(new Piece(sh.name)))) { unavoidable++; continue; }
    const tray = g.spawnTray();
    trays++;
    if (tray.some((p) => g.board.fits(p))) oneFits++;
    if (isSolvable(g.board, tray)) solvable++;
  }
  eq(oneFits, trays, `必ず1つ以上置ける (${oneFits}/${trays})`);
  eq(solvable / trays >= 0.9, true, `3つとも置ける割合 ${(solvable / trays * 100).toFixed(0)}% (>= 90%)`);
}

console.log('ゲーム進行');
{
  const g = new Game({ random: () => 0.5 });
  const placeAny = async (slot) => {
    for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) if (g.canPlace(slot, ox, oy)) return g.placePiece(slot, ox, oy);
    return false;
  };
  eq(g.tray.length, 3, 'トレイは3つ');
  await placeAny(0);
  eq(g.tray.filter(Boolean).length, 2, '1つ使うと残り2');
  await placeAny(1); await placeAny(2);
  eq(g.tray.filter(Boolean).length, 3, '使い切ったら3つ補充');
  eq(g.score.score > 0, true, 'スコアが入る');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

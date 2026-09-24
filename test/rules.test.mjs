import { Board, createBlock } from '../src/core/board.js?v=202609240209';
import { resolveChains, resolveLine, nextActivation, decide } from '../src/core/mancala.js?v=202609240209';
import { Piece, PieceGenerator, SHAPES, TYPE_WEIGHTS } from '../src/core/pieces.js?v=202609240209';
import { Game, isSolvable } from '../src/core/game.js?v=202609240209';
import { planAllClear, countWays, spots } from '../src/core/planner.js?v=202609240209';
import * as Sim from '../src/core/sim.js?v=202609240209';
import { isInside, lineCells, SIZE, MAX_BLOCKS, targetWays, TIGHT_MIN_SPOTS } from '../src/core/constants.js?v=202609240209';

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
  eq(pat(b, 'row', 2), [0,1], '空の横2 には一番奥（左端）に入る');
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

console.log('配られたブロックは、ブロックか壁に当たる手前まで奥へ進む');
{
  const b = new Board();
  b.insertBottom('col', 5, createBlock('x'));
  eq(pat(b, 'col', 5), [0,0,0,0,1], '空の縦5 -> 一番奥（壁の手前）');
  b.insertBottom('col', 5, createBlock('x'));
  eq(pat(b, 'col', 5), [0,0,0,1,1], '奥のブロックに当たる手前まで進む');
  b.insertBottom('col', 5, createBlock('x'));
  eq(pat(b, 'col', 5), [0,0,1,1,1], 'もう1個も同じく手前まで');
  const r = new Board();
  r.insertBottom('row', 4, createBlock('x'));
  eq(pat(r, 'row', 4), [0,0,0,1], '空の横4 -> 一番奥（左端）');
}
{
  const b = new Board();
  setLine(b, 'col', 6, [0,0,1,0,0,1]);
  const ids = b.line('col', 6).map((v) => v?.id ?? null);
  b.insertBottom('col', 6, createBlock('x'));
  eq(pat(b, 'col', 6), [0,1,1,0,0,1], '途中のブロックに当たる手前で止まる（奥の空欄は飛び越えない）');
  eq([b.line('col', 6)[2].id, b.line('col', 6)[5].id], [ids[2], ids[5]], '他のブロックは動かない');
}
{
  const b = Board.fromHeights([0,0,0,0,5,0,0,0]);
  resolveLine(b, 'col', 5);
  eq([4,3,2,1].map((n) => pat(b, 'col', n).at(-1)), [1,1,1,1], '縦5 発動: 空の縦4〜1 には一番奥に入る');
}

console.log('満杯より1個少ないラインだけは、手前のブロックを奥へ詰めて埋める');
{
  const b = new Board();
  setLine(b, 'col', 4, [1,0,1,1]);
  const ids = b.line('col', 4).map((v) => v?.id ?? null);
  eq(b.insertBottom('col', 4, createBlock('x')), true, '入れる');
  eq(pat(b, 'col', 4), [1,1,1,1], '■□■■ -> ■■■■（満杯になる）');
  eq(b.line('col', 4)[1].id, ids[0], '元の一番手前が1マス奥へ');
  eq([b.line('col', 4)[2].id, b.line('col', 4)[3].id], [ids[2], ids[3]], '空欄より奥は動かない');
}
{
  const b = new Board();
  setLine(b, 'col', 4, [1,1,1,0]);
  b.insertBottom('col', 4, createBlock('x'));
  eq(pat(b, 'col', 4), [1,1,1,1], '■■■□ -> 3個とも奥へ詰めて満杯');
}

console.log('手前の端が埋まっていて進めないとき（満杯より2個以上少ない）は入れずにゴールへ');
{
  const b = new Board();
  setLine(b, 'col', 4, [1,0,1,0]);
  eq(b.insertBottom('col', 4, createBlock('x')), false, '■□■□ には入れない');
  eq(pat(b, 'col', 4), [1,0,1,0], '盤面は変わらない');
  const f = new Board();
  setLine(f, 'col', 3, [1,1,1]);
  eq(f.insertBottom('col', 3, createBlock('x')), false, '満杯にも入れない');
}
{
  const b = new Board();
  setLine(b, 'col', 3, [1,1,1]);
  setLine(b, 'col', 2, [1,0]);                // 縦2 は満杯より1個少ない -> 詰めて入る
  setLine(b, 'col', 1, []);
  const st = resolveLine(b, 'col', 3);
  eq(st.moves.map((m) => m.to), [2,1,'goal'], '縦2・縦1 に配り、最後はゴール');
}

// ---- 仕様をそのまま書いた参照実装（本体とは独立したメモ）----
const refMemo = new Map();
const refKey = (b) => b.grid.flat().map((v) => (v ? 1 : 0)).join('');
function refLen(b) {
  const k = refKey(b);
  if (refMemo.has(k)) return refMemo.get(k);
  const bb = b.clone(); let n = 0;
  for (let a; (a = refNext(bb)); ) { resolveLine(bb, a.kind, a.n); n++; }
  refMemo.set(k, n);
  return n;
}
function refNext(b) {
  const lines = b.fullLines();
  if (!lines.length) return null;
  const minOf = (k) => { const ns = lines.filter((l) => l.kind === k).map((l) => l.n); return ns.length ? { kind: k, n: Math.min(...ns) } : null; };
  const c = minOf('col'), r = minOf('row');
  if (!c || !r) return c ?? r;
  const len = (act) => { const bb = b.clone(); resolveLine(bb, act.kind, act.n); return 1 + refLen(bb); };
  return len(r) > len(c) ? r : c;
}

console.log('優先順位: 同じ向きは小さい番号から / 縦横両方なら連鎖が大きい向きの小さい番号から');
{
  const b = Board.fromHeights([0,2,3,0,0,0,0,0]);
  eq(seq(resolveChains(b)), 'c2 c1 c3 c1', '縦2 と 縦3 なら縦2 から');
  eq(b.heights, [0,1,0,0,0,0,0,0], '縦2 に1個残る');
}
{
  const b = new Board();
  setLine(b, 'row', 3, [1,1,1]); setLine(b, 'row', 5, [1,1,1,1,1]);
  eq(nextActivation(b), { kind: 'row', n: 3 }, '横3 と 横5 なら横3 から');
}
{
  const b = new Board();
  b.set(7, 0, createBlock('x'));             // 縦1（連鎖1）
  b.set(0, 6, createBlock('x')); b.set(1, 6, createBlock('x'));   // 横2（横2 -> 横1 で連鎖2以上）
  // 縦1 から始めても 横2 から始めても、最後まで数えると3連鎖で同じ -> 縦から
  eq(decide(b), { act: { kind: 'col', n: 1 }, tie: true }, '合計の連鎖数が同じなら縦から');
  eq(seq(resolveChains(b)), 'c1 r2 r1', '縦1 -> 横2 -> 横1');
}
{
  const b = new Board();
  b.set(7, 0, createBlock('x')); b.set(0, 7, createBlock('x'));  // 縦1 と 横1（どちらも連鎖1）
  const d = decide(b);
  eq([d.act, d.tie], [{ kind: 'col', n: 1 }, true], '連鎖数が同じなら縦');
}
{
  const b = new Board();
  setLine(b, 'col', 8, [1,1,1,1,1,1,1,1]);
  eq(nextActivation(b), refNext(b), '縦8 と角の横1: 参照実装と一致');
}

console.log('長い連鎖（穴あきラインを押し込みで埋めていく）');
{
  const b = new Board();
  setLine(b, 'col', 5, [1,1,1,1,1]);
  setLine(b, 'col', 4, [0,1,1,1]);
  setLine(b, 'col', 3, [0,1,1]);
  setLine(b, 'col', 2, [0,1]);
  const steps = resolveChains(b);
  eq(seq(steps), 'c5 c1 c2 c1 c3 c1 c4 c1 c2 c1', '押し込みで埋まった列が小さい順に次々発動（10連鎖）');
  eq(b.heights, [0,0,1,0,0,0,0,0], '縦3 に1個残る');
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
      const act = refNext(check);
      if (!act || act.kind !== s.kind || act.n !== s.n) { ok = false; break; }
      resolveLine(check, act.kind, act.n);
    }
    if (nextActivation(b) !== null) ok = false;
  }
  eq(ok, true, 'ランダム300盤面で、毎ステップ参照実装（仕様どおり）と一致');
}
{
  // 「縦横両方あって、連鎖が大きいので横を選んだ」局面が実際に起きていること
  let seed = 77, rowWins = 0, colWins = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 400; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.7) b.set(x, r, createBlock('x'));
    const kinds = new Set(b.fullLines().map((l) => l.kind));
    if (kinds.size < 2) continue;
    const d = decide(b);
    if (d.tie) continue;
    if (d.act.kind === 'row') rowWins++; else colWins++;
  }
  eq(rowWins > 0 && colWins > 0, true, `縦横両方ある局面で 横を選択 ${rowWins} / 縦を選択 ${colWins}（どちらも起きる）`);
}
{
  // 対称性: 縦横を入れ替えた盤面では、縦と横が入れ替わった同じ連鎖が起きる（同番号の同時満杯が無い場合）
  let seed = 5, checked = 0, ok = true;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 400; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.55) b.set(x, r, createBlock('x'));
    const tb = transpose(b);
    // 縦横の連鎖数が同じ局面（タイブレークで縦優先）がある盤面は対称にならないので除外
    const hasTie = (bb) => { const c = bb.clone(); for (let d; (d = decide(c)).act; ) { if (d.tie) return true; resolveLine(c, d.act.kind, d.act.n); } return false; };
    if (hasTie(b) || hasTie(tb)) continue;
    const s1 = resolveChains(b), s2 = resolveChains(tb);
    const flip = seq(s1).replace(/c/g, 'X').replace(/r/g, 'c').replace(/X/g, 'r');
    checked++;
    if (flip !== seq(s2)) { ok = false; break; }
  }
  eq(ok && checked > 50, true, `縦横入れ替えで対称な連鎖になる（${checked}盤面）`);
}

console.log('手駒: テトロミノ + ブロックブラストの形');
{
  const types = (list) => [...new Set(list.map((s) => s.type))].sort().join(' ');
  eq(SHAPES.filter((s) => s.cells.length === 4 && 'IOTSZJL'.includes(s.type) && s.type.length === 1).length, 19, 'テトロミノの全向き 19 種');
  eq(types(SHAPES), 'Dot I I2 I3 I5 J L O O3 R S T V3 V5 Z', '15種類');
  eq(SHAPES.find((s) => s.name === 'O30').cells.length, 9, '3×3');
  eq(SHAPES.filter((s) => s.type === 'V5').every((s) => s.cells.length === 5), true, '大きいL は5マス');
  const norm = (cells) => cells.map(([x, y]) => `${x},${y}`).sort().join(' ');
  eq(new Set(SHAPES.map((s) => norm(s.cells))).size, SHAPES.length, '同じ形の向きが重複していない');
  eq(new Set(SHAPES.map((s) => s.name)).size, SHAPES.length, '名前が重複していない');
  eq(SHAPES.every((s) => s.cells.some(([x]) => x === 0) && s.cells.some(([, y]) => y === 0)), true, 'セルは左上に詰めてある');
  eq(SHAPES.every((s) => new Piece(s.name).width + new Piece(s.name).height <= 8), true, 'どの形も三角形の盤面に入る');
  const gen = new PieceGenerator(() => 0);
  eq(gen.spawnTray(3).map((p) => p.name), ['I0','I0','I0'], 'J: 同じ形が複数出てもよい');
  let seed = 3; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g2 = new PieceGenerator(rnd), cnt = {}, N = 40000;
  for (let i = 0; i < N; i++) { const t = g2.next().type; cnt[t] = (cnt[t] || 0) + 1; }
  const total = Object.values(TYPE_WEIGHTS).reduce((a, b) => a + b, 0);
  const off = Object.entries(TYPE_WEIGHTS).filter(([t, w]) => Math.abs((cnt[t] || 0) / N - w / total) > 0.006).map(([t]) => t);
  eq(off, [], `種類ごとの出現率が重みどおり ${JSON.stringify(cnt)}`);
}

console.log('探索用の軽い盤面（sim.js）は本体と同じ結果になる');
{
  let seed = 31, ok = true;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 400 && ok; t++) {
    const b = new Board(), p = rnd();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < p) b.set(x, r, createBlock('x'));
    const s = Sim.fromBoard(b);
    const n = Sim.resolveAll(s);
    if (n !== resolveChains(b).length || Sim.keyOf(s) !== Sim.keyOf(Sim.fromBoard(b)) || Sim.blocks(s) !== b.totalBlocks()) ok = false;
  }
  eq(ok, true, 'ランダム400盤面で連鎖数と最後の盤面が一致');
}

console.log('連鎖ピース: 約10% の確率で、置けば発動が起きる形');
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
  // 確率: 1回の抽選(drawTray)で通常抽選(next)を通らなかった枠 = 連鎖ピースとして選ばれた枠
  let total = 0;
  const g3 = new Game({ random: rnd }); g3.board = g.board.clone();
  const origNext = g3.generator.next.bind(g3.generator);
  let naturalCount = 0;
  g3.generator.next = () => { naturalCount++; return origNext(); };
  for (let i = 0; i < 4000; i++) { g3.drawTray(); total += 3; }
  const rate = (total - naturalCount) / total;
  eq(rate > 0.085 && rate < 0.115, true, `連鎖ピースの割合 ${(rate * 100).toFixed(1)}%`);
}

console.log('トレイ保証: 埋まり具合に関係なく必ず詰まない置き方がある / 置き方の数は埋まるほど減る');
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
/** ブロックが lo〜hi 個で、どのラインも満杯でない（発動が起きない）盤面を作る */
function boardWithBlocks(rnd, lo, hi) {
  const cells = [];
  for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r)) cells.push([x, r]);
  for (;;) {
    const target = lo + Math.floor(rnd() * (hi - lo + 1));
    const b = new Board();
    for (const [x, r] of [...cells].sort(() => rnd() - 0.5)) {
      if (b.totalBlocks() >= target) break;
      b.set(x, r, createBlock('x'));
      if (b.fullLines().length) b.set(x, r, null);
    }
    if (b.totalBlocks() === target) return b;
  }
}
{
  eq(MAX_BLOCKS, 28, '連鎖が終わった盤面に残せるのは最大 28 個（16本すべてに空きが要る）');
  let seed = 19, max = 0; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 300; t++) {
    const b = new Board();
    for (let x = 0; x < 8; x++) for (let r = 0; r < 8; r++) if (isInside(x, r) && rnd() < 0.9) b.set(x, r, createBlock('x'));
    resolveChains(b);
    max = Math.max(max, b.totalBlocks());
  }
  eq(max <= MAX_BLOCKS, true, `ランダムに埋めて連鎖させた盤面も 28 個以下（最大 ${max}）`);
}
{
  // 置き方の数え方: 置き終えた盤面（連鎖後）の種類の数。すべての順番・場所を素直に試す参照実装と比べる
  const brute = (s, names) => {
    const ends = new Set();
    const rec = (st, rest) => {
      if (!rest.length) { ends.add(Sim.keyOf(st)); return; }
      rest.forEach((n, i) => {
        const cells = new Piece(n).cells;
        for (const [ox, oy] of Sim.placements(st, cells)) {
          const b = Sim.cloneSim(st); Sim.place(b, cells, ox, oy); Sim.resolveAll(b);
          rec(b, rest.filter((_, j) => j !== i));
        }
      });
    };
    rec(s, names);
    return ends.size;
  };
  let seed = 17, same = true, nonzero = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const small = SHAPES.filter((sh) => sh.cells.length <= 4).map((sh) => sh.name);
  for (let t = 0; t < 25; t++) {
    const s = Sim.fromBoard(boardWithBlocks(rnd, 18, 26));
    const names = [0, 1, 2].map(() => small[Math.floor(rnd() * small.length)]);
    const c = countWays(s, names).count;
    if (c !== brute(s, names)) same = false;
    if (c) nonzero++;
  }
  eq(same && nonzero > 5, true, `置き方の数は、全部の順番・場所を試した参照実装と一致（25盤面, うち ${nonzero} 盤面で1通り以上）`);
  const empty = Sim.fromBoard(new Board());
  eq(countWays(empty, ['O30']).count, spots(empty, 'O30'), '1つだけなら置ける場所の数と同じ');
  eq(countWays(Sim.fromBoard(new Board()), ['Dot0', 'Dot0', 'Dot0'], 50).count, 50, 'cap で打ち切る');
  eq(targetWays(0) > targetWays(0.5) && targetWays(0.5) > targetWays(0.8) && targetWays(1) === 1, true,
    `置き方の目標は埋まるほど減る（空 ${targetWays(0)} / 半分 ${targetWays(0.5)} / 8割 ${targetWays(0.8)} / 満杯 ${targetWays(1)}）`);
}
{
  let seed = 21; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const byFill = [[1, 6], [10, 14], [19, 23], [24, 27]].map(([lo, hi]) => {
    let trays = 0, solvable = 0; const ways = [];
    for (let t = 0; t < 80; t++) {
      const g = new Game({ random: rnd });
      g.allClearTray = () => null; g.searchTight = () => null;       // ふつうの決め方だけを見る
      g.board = boardWithBlocks(rnd, lo, hi);
      if (!SHAPES.some((sh) => g.board.fits(new Piece(sh.name)))) continue;
      const tray = g.spawnTray();
      trays++;
      const w = countWays(Sim.fromBoard(g.board), tray.map((p) => p.name), 400).count;
      if (w > 0) solvable++;
      ways.push(w);
    }
    ways.sort((a, b) => a - b);
    return { lo, hi, trays, solvable, median: ways[ways.length >> 1] };
  });
  for (const f of byFill) eq(f.solvable, f.trays, `ブロック ${f.lo}〜${f.hi} 個: 必ず詰まない置き方がある (${f.solvable}/${f.trays})`);
  const med = byFill.slice(0, 3).map((f) => f.median);
  eq(med[0] > med[1] && med[1] > med[2], true, `置き方の数（中央値）は埋まるほど減る ${byFill.map((f) => `${f.lo}〜${f.hi}個: ${f.median}`).join(' / ')}`);
}

console.log('ときどき「1つずつなら置けるのに、3つとも置ける置き方は1〜2通り」の組み合わせ');
{
  let seed = 29, found = 0, ok = true, tries = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 20; t++) {
    const g = new Game({ random: rnd });
    g.board = boardWithBlocks(rnd, 3, 12);
    const s = Sim.fromBoard(g.board);
    tries++;
    const pick = g.searchTight(s);
    if (!pick) continue;
    found++;
    const names = pick.tray.map((p) => p.name);
    const w = countWays(s, names).count;
    if (!(w >= 1 && w <= 2) || !names.every((n) => spots(s, n) >= TIGHT_MIN_SPOTS)) ok = false;
  }
  eq(ok && found > 0, true, `置き方は1〜2通り・どの形も1つずつなら ${TIGHT_MIN_SPOTS} か所以上に置ける (${found}/${tries} 盤面で見つかった)`);
}
{
  // 補充のたびに約10%（見つからなければ次の補充で探し直すので、出る割合もおよそ10%）
  let seed = 31, tight = 0, n = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new Game({ random: rnd });
  g.allClearTray = () => null;
  for (let i = 0; i < 300; i++) {
    g.board = boardWithBlocks(rnd, 3, 12); g.history = new Set();
    g.spawnTray(); n++;
    if (g.lastLineup.kind === 'tight') tight++;
  }
  eq(tight / n > 0.05 && tight / n < 0.15, true, `置き方の少ない組み合わせの割合 ${(tight / n * 100).toFixed(0)}%`);
  let high = 0;
  for (let i = 0; i < 60; i++) { g.board = boardWithBlocks(rnd, 17, 27); g.spawnTray(); if (g.lastLineup.kind === 'tight') high++; }
  eq(high, 0, '6割以上埋まっているときは出さない（ふつうの目標がもともと少ない）');
}

console.log('詰む組み合わせは「8割以上・詰まない置き方が1通りだけ・置くと前の盤面に戻る」ときだけ');
{
  let seed = 37; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  // 置き方が1通りだけの組み合わせがある、8割以上の盤面を探す
  let setup = null;
  for (let t = 0; t < 400 && !setup; t++) {
    const g = new Game({ random: rnd });
    g.board = boardWithBlocks(rnd, 23, 27);
    const s = Sim.fromBoard(g.board);
    for (let k = 0; k < 30 && !setup; k++) {
      const tray = g.drawTray(), w = countWays(s, tray.map((p) => p.name));
      if (w.count === 1) setup = { g, tray, end: [...w.ends][0] };
    }
  }
  eq(!!setup, true, '（前提）8割以上で置き方1通りの組み合わせがある盤面');
  const { g, tray, end } = setup;
  const s = Sim.fromBoard(g.board);
  g.allClearTray = () => null;
  g.drawTray = ((orig) => function () { return this.onlyThis ? this.onlyThis.map((p) => new Piece(p.name)) : orig.call(this); })(g.drawTray);
  // その組み合わせしか引けないとき: 置き終えた盤面が初めてなら、詰まない（その組み合わせ）を配る
  g.onlyThis = tray; g.history = new Set();
  let dealt = g.spawnTray();
  eq([g.lastLineup.kind, countWays(s, dealt.map((p) => p.name)).count], ['normal', 1], 'ループしないなら、置き方1通りでも詰まない組み合わせを配る');
  // 置き終えた盤面が前に配った時の盤面と同じ（ループ）なら、詰む組み合わせを配る
  g.history = new Set([end]);
  g.drawTray = ((orig) => { let n = 0; return function () { return n++ < 40 ? this.onlyThis.map((p) => new Piece(p.name)) : (this.onlyThis = null, orig.call(this)); }; })(g.drawTray);
  dealt = g.spawnTray();
  eq(g.lastLineup.kind, 'stuck', 'ループするなら詰む組み合わせを配ってよい');
  eq(countWays(s, dealt.map((p) => p.name), 1).count === 0 && dealt.some((p) => g.board.fits(p)), true, '配ったのは詰む（でも1つは置ける）組み合わせ');
  // 8割未満なら、ループしても詰む組み合わせは配らない
  const low = new Game({ random: rnd });
  low.allClearTray = () => null; low.searchTight = () => null;
  low.board = boardWithBlocks(rnd, 10, 14);
  const ls = Sim.fromBoard(low.board);
  let only = null;
  for (let k = 0; k < 400 && !only; k++) { const tr = low.drawTray(); const w = countWays(ls, tr.map((p) => p.name)); if (w.count === 1) only = { tr, w }; }
  if (only) {
    low.drawTray = function () { return only.tr.map((p) => new Piece(p.name)); };
    low.history = new Set(only.w.ends);
    const d = low.spawnTray();
    eq(countWays(ls, d.map((p) => p.name), 1).count, 1, '8割未満ならループしても詰まない組み合わせを配る');
  }
}

console.log('全消しのチャンス: 2割以下（5個以下）の盤面で約20%、6個置いたところで全消しできる手駒');
{
  let seed = 41; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const seq = planAllClear(new Board(), { depth: 6, random: rnd, budgetMs: 1000 });
  eq(seq?.length, 6, '空の盤面から6手の手順が見つかる');
  const b = new Board(), left = [];
  for (const m of seq) {
    const p = new Piece(m.name);
    if (!b.canPlace(p, m.ox, m.oy)) { left.push('x'); break; }
    b.place(p, m.ox, m.oy);
    resolveChains(b);
    left.push(b.totalBlocks());
  }
  eq(left.at(-1) === 0 && left.slice(0, -1).every((n) => n > 0), true, `本体で置いても6個目でちょうど全消し（残り ${left.join(' → ')}）`);
  eq(seq.filter((m) => m.name.startsWith('Dot')).length <= 1, true, '1マスの形は1個まで');
}
{
  // ブロックが少し残った盤面から: 見つかった手順は本体でも全消しになる
  let seed = 43, found = 0, ok = true;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 20; t++) {
    const b = boardWithBlocks(rnd, 1, 5);                // 2割以下
    const seq = planAllClear(b, { depth: 6, random: rnd, budgetMs: 200 });
    if (!seq) continue;
    found++;
    const c = b.clone();
    for (const m of seq) { c.place(new Piece(m.name), m.ox, m.oy); resolveChains(c); }
    if (c.totalBlocks() !== 0) ok = false;
  }
  eq(ok && found > 0, true, `残りがある盤面でも手順どおりなら全消し (${found}/20 で手順あり)`);
}
/** pieces を順番自由で全部置いて、最後の盤面が goal(sim) を満たす置き方 [{slot, ox, oy}] を探す */
function findPlay(board, tray, goal) {
  const rec = (s, rest) => {
    if (!rest.length) return goal(s) ? [] : null;
    for (const [k, { slot, piece }] of rest.entries()) {
      for (const [ox, oy] of Sim.placements(s, piece.cells)) {
        const b = Sim.cloneSim(s); Sim.place(b, piece.cells, ox, oy); Sim.resolveAll(b);
        const tail = rec(b, rest.filter((_, j) => j !== k));
        if (tail) return [{ slot, ox, oy }, ...tail];
      }
    }
    return null;
  };
  return rec(Sim.fromBoard(board), tray.map((piece, slot) => ({ slot, piece })));
}
{
  let seed = 47; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new Game({ random: rnd });
  // ブロックが少し残った盤面でチャンスを引いた状態（空の盤面は別の決め方）
  for (let tries = 0; tries < 30; tries++) {
    g.board = boardWithBlocks(rnd, 1, 3); g.plan = null; g.wantAllClear = true;
    g.tray = g.spawnTray();
    if (g.plan) break;
  }
  eq(!!g.plan && g.tray.length === 3, true, '1回目の3つを配り、2回目は計画として持つ');
  const first = findPlay(g.board, g.tray, (s) => Sim.keyOf(s) === g.plan.key);
  let last = null;
  for (const m of first ?? []) last = g.placePiece(m.slot, m.ox, m.oy);
  eq(!!last?.refilled, true, '1回目を計画どおりに置き切れる');
  const second = findPlay(g.board, g.tray, (s) => Sim.blocks(s) === 0);
  for (const m of second ?? []) last = g.placePiece(m.slot, m.ox, m.oy);
  eq([!!second, last?.allClear, g.board.totalBlocks()], [true, true, 0], '2回目の3つで全消し（turn.allClear）');
}
{
  // 計画と違う置き方をしたときは、今の盤面から3つで全消しできる組を探し直す（見つかれば配る）
  let seed = 53, replanned = 0, ok = true;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let t = 0; t < 15; t++) {
    const g = new Game({ random: rnd });
    g.board = boardWithBlocks(rnd, 1, 4);
    g.plan = { key: -1, rest: [] };
    const tray = g.spawnTray();
    const seq = findPlay(g.board, tray, (s) => Sim.blocks(s) === 0);
    if (seq) replanned++;
  }
  eq(replanned > 0, true, `探し直した3つで全消しできる (${replanned}/15)`);
}
{
  // 確率: 2割以下（空ではない）の盤面で補充するたびに約20%でチャンス（手順が見つかるまで次の補充でも探す）
  let seed = 59, chances = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new Game({ random: rnd }), N = 300;
  for (let i = 0; i < N; i++) {
    g.board = boardWithBlocks(rnd, 1, 5); g.plan = null; g.wantAllClear = false;
    g.spawnTray();
    if (g.plan || g.wantAllClear) chances++;
  }
  eq(chances / N > 0.15 && chances / N < 0.25, true, `全消しのチャンスを引く割合 ${(chances / N * 100).toFixed(0)}%`);
  // 2割を超える盤面では起きない
  let over = 0;
  for (let i = 0; i < 100; i++) {
    g.board = boardWithBlocks(rnd, 6, 14); g.plan = null; g.wantAllClear = false;
    g.spawnTray();
    if (g.plan) over++;
  }
  eq(over, 0, '2割を超える盤面では全消しの手駒は出ない');
}
{
  // 盤面が空のときは約40%で「この3つを置き切ると全消し」の組み合わせ
  let seed = 61, hits = 0, ok = true, dots = 0;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const g = new Game({ random: rnd }), N = 300;
  for (let i = 0; i < N; i++) {
    g.board = new Board(); g.plan = null; g.wantAllClear = false;
    const tray = g.spawnTray();
    if (g.lastLineup.kind !== 'allClear') continue;
    hits++;
    if (g.plan) ok = false;                                      // 3つで完結する（2回目の計画は持たない）
    if (hits <= 30) {
      const play = findPlay(g.board, tray, (s) => Sim.blocks(s) === 0);
      if (!play) ok = false;
      if (tray.some((p) => p.type === 'Dot')) dots++;
    }
  }
  eq(hits / N > 0.33 && hits / N < 0.47, true, `空の盤面で全消しの組み合わせになる割合 ${(hits / N * 100).toFixed(0)}%`);
  eq(ok, true, '配った3つを置き切ると全消しできる（30組で確認）');
  eq(dots <= 3, true, `1マスの形はなるべく使わない（30組中 ${dots} 組）`);
  // 実際に置いて全消しになる
  g.board = new Board();
  for (let k = 0; k < 20 && g.lastLineup?.kind !== 'allClear'; k++) { g.board = new Board(); g.plan = null; g.tray = g.spawnTray(); }
  let last = null;
  for (const m of findPlay(g.board, g.tray, (s) => Sim.blocks(s) === 0) ?? []) last = g.placePiece(m.slot, m.ox, m.oy);
  eq(last?.allClear, true, '3つ目で ALL CLEAR（turn.allClear）');
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

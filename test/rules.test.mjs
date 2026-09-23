import { Board, createBlock } from '../src/core/board.js?v=202609230548';
import { resolveChains, resolveLine, nextActivation, decide } from '../src/core/mancala.js?v=202609230548';
import { Piece, PieceGenerator, SHAPES } from '../src/core/pieces.js?v=202609230548';
import { Game, isSolvable } from '../src/core/game.js?v=202609230548';
import { isInside, lineCells, SIZE } from '../src/core/constants.js?v=202609230548';

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

console.log('空のラインへ配られたブロックは一番奥まで進む');
{
  const b = new Board();
  b.insertBottom('col', 5, createBlock('x'));
  eq(pat(b, 'col', 5), [0,0,0,0,1], '空の縦5 -> 一番奥（上端）');
  b.insertBottom('col', 5, createBlock('x'));
  eq(pat(b, 'col', 5), [1,0,0,0,1], '空でなければ手前の端から（押す相手が無いので手前に入る）');
  const r = new Board();
  r.insertBottom('row', 4, createBlock('x'));
  eq(pat(r, 'row', 4), [0,0,0,1], '空の横4 -> 一番奥（左端）');
}
{
  const b = Board.fromHeights([0,0,0,0,5,0,0,0]);
  resolveLine(b, 'col', 5);
  eq([4,3,2,1].map((n) => pat(b, 'col', n).at(-1)), [1,1,1,1], '縦5 発動: 空の縦4〜1 には一番奥に入る');
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

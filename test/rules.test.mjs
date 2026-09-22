import { Board } from '../src/core/board.js';
import { resolveChains, resolveColumn } from '../src/core/mancala.js';
import { PieceGenerator, Piece } from '../src/core/pieces.js';
import { Game } from '../src/core/game.js';
import { requiredCount } from '../src/core/constants.js';

let pass = 0, fail = 0;
function eq(actual, expected, name) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a === e) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}\n       expected ${e}\n       actual   ${a}`); }
}
// heights[0] = 列1 … heights[7] = 列8
const H = (b) => b.heights;

console.log('Case A: 列1が1個 -> ゴールへ入り0個');
{
  const b = Board.fromHeights([1,0,0,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(H(b), [0,0,0,0,0,0,0,0], 'board empty');
  eq(steps.map(s => s.column), [1], 'chain = 列1 のみ');
  eq(steps[0].moves.map(m => m.to), ['goal'], '列1の1個はゴール');
}

console.log('Case B: 列2が2個 -> 列1へ1個+ゴール1個 -> 列1が発動');
{
  const b = Board.fromHeights([0,2,0,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(steps.map(s => s.column), [2,1], '列2 -> 列1 の2連鎖');
  eq(steps[0].moves.map(m => m.to), [1,'goal'], '列2の配り先');
  eq(H(b), [0,0,0,0,0,0,0,0], 'board empty');
}

console.log('Case C: 列5が5個 -> 列4,3,2,1,ゴール');
{
  const b = Board.fromHeights([0,0,0,0,5,0,0,0]);
  const step = resolveColumn(b, 5);
  eq(step.moves.map(m => m.to), [4,3,2,1,'goal'], '配り順');
  eq(H(b), [1,1,1,1,0,0,0,0], '各列に1個ずつ');
}

console.log('Case D: 列4が5個 -> 発動しない');
{
  const b = Board.fromHeights([0,0,0,5,0,0,0,0]);
  eq(b.findExactColumns(), [], '発動可能列なし');
  eq(resolveChains(b).length, 0, '発動0回');
}

console.log('Case E: 列4が3個 + マンカラで下から1個 -> 4個で発動');
{
  const b = Board.fromHeights([0,0,0,3,5,0,0,0]); // 列5発動で列4へ1個入る
  const steps = resolveChains(b);
  // 列5発動で列4が3->4個になり、以降も毎回「最小番号優先」で再判定される
  eq(steps.map(s => s.column), [5,1,4,1,2,1], '列5発動後 列4が4個になり発動する');
  eq(steps.filter(s => s.column === 4).length, 1, '列4が発動した');
  eq(H(b), [0,0,2,0,0,0,0,0], '列3に2個だけ残る');
}

console.log('Case F: 列4が3個 + 通常配置で一度に2個 -> 5個で発動しない');
{
  const b = Board.fromHeights([0,0,0,3,0,0,0,0]);
  // 列4 = screenX 4（左端0 = 列8）。縦向きOは無いので2セルを列4へ積む
  b.placeCells([{x:4,y:0,color:'t'},{x:4,y:1,color:'t'}]);
  eq(b.height(3), 5, '列4 = 5個');
  eq(b.findExactColumns(), [], '発動しない');
}

console.log('Case G: 列2と列5が同時 -> 列2を先に');
{
  const b = Board.fromHeights([0,2,0,0,5,0,0,0]);
  const steps = resolveChains(b);
  eq(steps[0].column, 2, '最初は列2');
  eq(steps.map(s => s.column), [2,1,5,1], '毎回再判定して最小番号を発動');
  eq(H(b), [0,1,1,1,0,0,0,0], '残り盤面');
}

console.log('Case H: 列2と列3が同時 -> 列2が先（列3先行で列2を超過させない）');
{
  const b = Board.fromHeights([0,2,3,0,0,0,0,0]);
  const steps = resolveChains(b);
  eq(steps[0].column, 2, '最初は列2');
  eq(steps.map(s => s.column), [2,1,3,1], '列2を先に処理し、毎回再判定');
  eq(steps.findIndex(s => s.column === 2) < steps.findIndex(s => s.column === 3), true, '列3より列2が先');
  eq(H(b), [0,1,0,0,0,0,0,0], '列2に1個残る');
}

console.log('Case I: 長い連鎖でも毎回 最小番号1列ずつ');
{
  const start = [1,2,3,4,5,6,7,8]; // 全列がちょうど必要数
  const b = Board.fromHeights(start);
  const steps = resolveChains(b);
  eq(steps.length > 5, true, `連鎖数 ${steps.length} > 5`);
  let okOrder = true;
  const check = Board.fromHeights(start);
  for (const s of steps) {
    const cands = check.findExactColumns();
    if (s.column !== Math.min(...cands)) okOrder = false;
    resolveColumn(check, s.column);
  }
  eq(okOrder, true, '常に最小番号を発動している');
  eq(H(b), check.heights, '再現一致');
}

console.log('Case J: 候補3つに同じテトロミノが出ても動作する');
{
  const gen = new PieceGenerator(() => 0.99); // 常に最後の種類
  const cs = gen.spawnCandidates([], 3);
  eq(cs.map(c => c.type), ['L','L','L'], '同種3つ');
  eq(cs.every(c => c.cells.length === 4), true, 'セル数4');
}

console.log('Extra: 完全一致判定は height === required のみ');
{
  for (let i = 0; i < 8; i++) {
    const req = requiredCount(i);
    const over = Board.fromHeights(Array.from({length:8},(_,k)=>k===i?req+1:0));
    if (over.findExactColumns().length !== 0) { fail++; console.log(`  FAIL 列${i+1} 超過で発動`); }
  }
  pass++; console.log('  ok   超過列は発動しない');
}

console.log('Extra: 通常のライン消去は存在しない');
{
  const b = Board.fromHeights([9,9,9,9,9,9,9,9]);
  eq(resolveChains(b).length, 0, '横一列でも何も起きない');
}

console.log('Extra: Game 経由の1手（連鎖含む）');
{
  const g = new Game({ random: () => 0 });
  g.board = Board.fromHeights([0,1,0,0,0,0,0,0]); // 列2にあと1個で発動
  await g.placePiece(0, 4); // I 横向き -> 列1,2 にも乗る
  eq(g.board.isOverflow(), false, 'オーバーフローなし');
  eq(g.score.score > 0, true, `スコア加算 ${g.score.score}`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

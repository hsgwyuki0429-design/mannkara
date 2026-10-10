// 撮影モードの盤面集のテスト: どの盤面も、決めた手駒を決めた場所に置くと本物のゲームで全消しになる
// 使い方: node --test test/studio.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { Game } from '../src/core/game.js?v=202610100228';
import { Board, createBlock } from '../src/core/board.js?v=202610100228';
import { Piece } from '../src/core/pieces.js?v=202610100228';
import { isInside } from '../src/core/constants.js?v=202610100228';
import { STUDIO_BOARDS } from '../src/core/studio-library.js?v=202610100228';
import { studioState, parseStudio, encodeCells, decodeCells, colorCells, STUDIO_SLOT } from '../src/core/studio.js?v=202610100228';

test('盤面の書き方: 書いて読むと同じマス', () => {
  const cells = [[0, 0], [7, 0], [0, 7], [3, 4], [2, 2]];
  const back = decodeCells(encodeCells(cells));
  assert.deepEqual(new Set(back.map(String)), new Set(cells.map(String)));
  assert.equal(encodeCells(cells).length, 9);
});

test('盤面集はたくさんあり、同じ盤面は無い', () => {
  assert.ok(STUDIO_BOARDS.length >= 50, `${STUDIO_BOARDS.length} 個`);
  assert.equal(new Set(STUDIO_BOARDS.map((c) => c.split(' ')[0])).size, STUDIO_BOARDS.length);
});

test('どの盤面も: 連鎖が終わった盤面で、決めた場所に置くと本物のゲームで 10 連鎖以上して全消し', () => {
  for (const code of STUDIO_BOARDS) {
    const { state, target, chain, blocks } = studioState(code);
    const game = new Game();
    game.importState(state);
    game.scripted = true;
    assert.equal(game.board.fullLines().length, 0, code);
    assert.equal(game.board.totalBlocks(), blocks, code);
    assert.equal(game.tray[STUDIO_SLOT].name, target.piece, code);
    const turn = game.placePiece(STUDIO_SLOT, target.ox, target.oy);
    assert.ok(turn, code);
    assert.ok(turn.allClear, code);
    assert.equal(game.board.totalBlocks(), 0, code);
    assert.equal(turn.steps.length, chain, code);
    assert.ok(chain >= 10, code);
    assert.ok(!game.gameOver, code);
  }
});

test('ダミーの手駒は盤面に置ける・置く手駒とは別の種類', () => {
  for (const code of STUDIO_BOARDS) {
    const st = parseStudio(code);
    const b = new Board();
    for (const [x, r] of st.cells) b.set(x, r, createBlock('blue'));
    assert.equal(st.decoys.length, 2, code);
    for (const name of st.decoys) {
      assert.ok(b.fits(new Piece(name)), code);
      assert.notEqual(new Piece(name).type, new Piece(st.piece).type, code);
    }
  }
});

test('ブロックの色: 盤面の中・同じ盤面はいつも同じ色', () => {
  const { cells } = parseStudio(STUDIO_BOARDS[0]);
  const a = colorCells(cells, 7), b = colorCells(cells, 7);
  assert.deepEqual(a, b);
  for (const [x, r, color] of a) { assert.ok(isInside(x, r)); assert.ok(color); }
});

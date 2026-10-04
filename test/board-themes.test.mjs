import test from 'node:test';
import assert from 'node:assert/strict';
import { outlineLoops, glassGroups, glassPath } from '../src/ui/glass.js?v=202610040525';
import { readBoardTheme, saveBoardTheme, BOARD_THEME_KEY, BOARD_THEMES } from '../src/ui/board-themes.js?v=202610040525';

const area = (loop) => loop.reduce((sum, p, i) => {
  const q = loop[(i + 1) % loop.length];
  return sum + p.x * q.y - q.x * p.y;
}, 0) / 2;

test('all 511 arrangements of a 3×3 grid preserve occupied area and exposed perimeter', () => {
  for (let bits = 1; bits < 512; bits++) {
    const cells = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) })).filter((_, i) => bits & (1 << i));
    const loops = outlineLoops(cells);
    assert.equal(loops.reduce((sum, loop) => sum + area(loop), 0), cells.length, `area for ${bits}`);
    const expected = cells.reduce((sum, c) => sum + [[0, -1], [1, 0], [0, 1], [-1, 0]].filter(([dx, dy]) => !cells.some((n) => n.x === c.x + dx && n.y === c.y + dy)).length, 0);
    const perimeter = loops.reduce((sum, loop) => sum + loop.reduce((s, p, i) => {
      const q = loop[(i + 1) % loop.length]; return s + Math.abs(p.x - q.x) + Math.abs(p.y - q.y);
    }, 0), 0);
    assert.equal(perimeter, expected, `perimeter for ${bits}`);
    assert.doesNotMatch(glassPath(cells), /NaN|Infinity|undefined/);
  }
});

test('the 36-cell triangular board has a single seamless outline', () => {
  const cells = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8 - y; x++) cells.push({ x, y });
  const loops = outlineLoops(cells);
  assert.equal(loops.length, 1);
  assert.equal(area(loops[0]), 36);
  assert.equal((glassPath(cells).match(/ Z/g) || []).length, 1);
});

test('a ring keeps its hole, while cells touching at a corner remain separate', () => {
  const ring = Array.from({ length: 9 }, (_, i) => ({ x: i % 3, y: Math.floor(i / 3) })).filter((c) => c.x !== 1 || c.y !== 1);
  assert.deepEqual(outlineLoops(ring).map(area).sort((a, b) => a - b), [-1, 9]);
  assert.equal(outlineLoops([{ x: 0, y: 0 }, { x: 1, y: 1 }]).length, 2);
});

test('only orthogonally adjacent cells of the same color are joined', () => {
  const cells = [{ x: 0, y: 0, color: 'green' }, { x: 1, y: 0, color: 'green' },
    { x: 2, y: 0, color: 'purple' }, { x: 2, y: 1, color: 'green' }];
  assert.deepEqual(glassGroups(cells).map((g) => g.length), [2, 1, 1]);
  assert.equal(cells.length, 4);
});

test('theme selection is persistent and does not alter game saves, scores or mode', () => {
  const values = new Map([['blockmancala-save', 'game'], ['blockmancala-best', '943475'], ['blockmancala-mode', 'learn']]);
  globalThis.localStorage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.equal(readBoardTheme(), 'gem');
  assert.equal(saveBoardTheme('glass'), 'glass');
  assert.equal(readBoardTheme(), 'glass');
  assert.equal(values.get('blockmancala-save'), 'game');
  assert.equal(values.get('blockmancala-best'), '943475');
  assert.equal(values.get('blockmancala-mode'), 'learn');
  values.set(BOARD_THEME_KEY, 'unknown');
  assert.equal(readBoardTheme(), 'gem');
});

test('the 3D board can be chosen and is remembered like the other boards', () => {
  const values = new Map([['blockmancala-save', 'game']]);
  globalThis.localStorage = { getItem: (key) => values.get(key), setItem: (key, value) => values.set(key, value) };
  assert.ok(BOARD_THEMES.some((t) => t.id === '3d'));
  assert.equal(saveBoardTheme('3d'), '3d');
  assert.equal(readBoardTheme(), '3d');
  assert.equal(values.get('blockmancala-save'), 'game');
  assert.equal(saveBoardTheme('gem'), 'gem');
  assert.equal(readBoardTheme(), 'gem');
});

test('unavailable storage does not prevent selecting a board', () => {
  globalThis.localStorage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  assert.equal(readBoardTheme(), 'gem');
  assert.equal(saveBoardTheme('glass'), 'glass');
  assert.equal(saveBoardTheme('unexpected'), 'gem');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { chainTouchesPlacement } from '../src/ui/chain-overlap.js?v=202610061243';

const pos = (pairs) => new Map(pairs.map(([id, x, r]) => [id, { x, r }]));

test('連鎖が触れないマスへの配置は再生速度を変えない', () => {
  const step = { kind: 'col', n: 2, stack: [{ id: 1 }], before: pos([[1, 6, 1]]), after: pos([[1, 5, 2]]) };
  assert.equal(chainTouchesPlacement([step], [{ x: 0, r: 0 }]), false);
});

test('発動ライン・途中の通路・押し込まれるマスへの配置は干渉と判定する', () => {
  const step = {
    kind: 'col', n: 3, stack: [{ id: 1 }],
    before: pos([[1, 5, 2], [2, 4, 1]]),
    after: pos([[1, 4, 0], [2, 4, 0]]),
  };
  assert.equal(chainTouchesPlacement([step], [{ x: 5, r: 0 }]), true, '発動ライン');
  assert.equal(chainTouchesPlacement([step], [{ x: 4, r: 2 }]), true, '盤面へ入る通路');
  assert.equal(chainTouchesPlacement([step], [{ x: 4, r: 1 }]), true, '押し込まれるマス');
});

test('横方向の連鎖と複数マスのピースも判定する', () => {
  const step = { kind: 'row', n: 3, stack: [{ id: 1 }], before: pos([[1, 2, 5]]), after: pos([[1, 0, 4]]) };
  assert.equal(chainTouchesPlacement([step], [{ x: 0, r: 0 }, { x: 2, r: 4 }]), true);
  assert.equal(chainTouchesPlacement([step], [{ x: 0, r: 0 }, { x: 1, r: 1 }]), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { tightRateFor, TIGHT_RATE_EASY, TIGHT_RATE_NEAR_BEST, TIGHT_RATE_OVER_BEST } from '../src/core/difficulty.js?v=202610051342';
import { TIGHT_RATE } from '../src/core/constants.js?v=202610051342';
import { Game } from '../src/core/game.js?v=202610051342';

test('ひっかけの確率: 出来が分からなければふつう', () => {
  assert.equal(tightRateFor(0, null), TIGHT_RATE);
  assert.equal(tightRateFor(500, undefined), TIGHT_RATE);
});
test('ベストが無い・最近うまくいっていない → ほとんど出さない', () => {
  assert.equal(tightRateFor(100, { best: 0, recent: [] }), TIGHT_RATE_EASY);
  assert.equal(tightRateFor(100, { best: 10000, recent: [2000, 3000, 1000] }), TIGHT_RATE_EASY);
});
test('ふつうに遊べている → ふつう', () => {
  assert.equal(tightRateFor(1000, { best: 10000, recent: [7000, 6000] }), TIGHT_RATE);
  assert.equal(tightRateFor(1000, { best: 10000, recent: [] }), TIGHT_RATE);
});
test('自己ベストが近い → 多め、超えたらさらに多め（うまくいっていない人でも）', () => {
  assert.equal(tightRateFor(8600, { best: 10000, recent: [7000] }), TIGHT_RATE_NEAR_BEST);
  assert.equal(tightRateFor(10001, { best: 10000, recent: [7000] }), TIGHT_RATE_OVER_BEST);
  assert.equal(tightRateFor(9000, { best: 10000, recent: [100] }), TIGHT_RATE_NEAR_BEST);
  assert.ok(TIGHT_RATE_EASY < TIGHT_RATE && TIGHT_RATE < TIGHT_RATE_NEAR_BEST && TIGHT_RATE_NEAR_BEST < TIGHT_RATE_OVER_BEST);
});
test('Game は skill があれば、配るたびにその確率を使う', () => {
  const g = new Game({ random: () => 0.5 });
  assert.equal(g.tightRate, TIGHT_RATE);
  g.skill = { best: 0, recent: [] };
  g.spawnTray();
  assert.equal(g.tightRate, TIGHT_RATE_EASY);
  g.score.score = 20000; g.skill = { best: 10000, recent: [] };
  g.spawnTray();
  assert.equal(g.tightRate, TIGHT_RATE_OVER_BEST);
});

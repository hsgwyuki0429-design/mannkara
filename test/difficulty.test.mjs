import test from 'node:test';
import assert from 'node:assert/strict';
import { allClearRateFor, ALL_CLEAR_RATE_MAX, ALL_CLEAR_RATE_AT_BEST, ALL_CLEAR_RATE_MIN, tightRateFor, TIGHT_RATE_STRUGGLING, TIGHT_RATE_AT_BEST, TIGHT_RATE_MAX, TIGHT_COOLDOWN } from '../src/core/difficulty.js?v=202610090554';
import { TIGHT_RATE, ALL_CLEAR_RATE } from '../src/core/constants.js?v=202610090554';
import { Game } from '../src/core/game.js?v=202610090554';


const near = (a, b) => Math.abs(a - b) < 1e-9;
const S = (best, recent = [], games = 10) => ({ best, recent, games });

test('出来が分からなければ 5%', () => {
  assert.equal(tightRateFor(0, null), TIGHT_RATE);
});
test('最初の 3 ゲーム・ベスト無しは 0%', () => {
  assert.equal(tightRateFor(100, S(0)), 0);
  assert.equal(tightRateFor(100, S(5000, [], 2)), 0);
  assert.equal(tightRateFor(100, S(5000, [], 3)), TIGHT_RATE);
});
test('うまくいっていない → 2%、ふつう → 5%', () => {
  assert.equal(tightRateFor(100, S(10000, [2000, 3000])), TIGHT_RATE_STRUGGLING);
  assert.equal(tightRateFor(100, S(10000, [7000, 6000])), TIGHT_RATE);
});
test('ベストの 80% → 100% で 5% → 12% へなめらかに、超えたら最大 18% まで', () => {
  assert.ok(near(tightRateFor(8000, S(10000)), TIGHT_RATE));
  assert.ok(near(tightRateFor(9000, S(10000)), (TIGHT_RATE + TIGHT_RATE_AT_BEST) / 2));
  assert.ok(near(tightRateFor(10000, S(10000)), TIGHT_RATE_AT_BEST));
  assert.ok(near(tightRateFor(11500, S(10000)), (TIGHT_RATE_AT_BEST + TIGHT_RATE_MAX) / 2));
  assert.equal(tightRateFor(50000, S(10000)), TIGHT_RATE_MAX);
  // うまくいっていない人でも、ベストが近ければ上げる
  assert.ok(near(tightRateFor(10000, S(10000, [100])), TIGHT_RATE_AT_BEST));
  let prev = 0;
  for (let s = 0; s <= 20000; s += 100) { const r = tightRateFor(s, S(10000)); assert.ok(r >= prev - 1e-12); prev = r; }
});
test('ひっかけを配った直後の 2 回の補充は出さない', () => {
  const g = new Game({ random: () => 0.5 });         // 全消しのチャンス（20%）は引かず、確率 1 のひっかけは必ず狙う
  g.tightRate = 1;
  let searched = 0;
  const real = g.searchTight.bind(g);
  g.searchTight = (start) => { searched++; const p = real(start); return p ?? { kind: 'tight', tray: g.searchTray(start, 0).tray, count: 1 }; };
  g.spawnTray();
  assert.equal(searched, 1);
  assert.equal(g.tightCooldown, TIGHT_COOLDOWN);
  for (let i = 0; i < TIGHT_COOLDOWN; i++) g.spawnTray();
  assert.equal(searched, 1);                          // 2 回は狙わない
  assert.equal(g.tightCooldown, 0);
  g.spawnTray();
  assert.equal(searched, 2);                          // その次からまた狙う
});

test('全消しのチャンス: 新しい人・うまくいっていない人は最大 40%、ふつうは 25%、ベストに近づくほど下げる（下限 10%）', () => {
  assert.equal(ALL_CLEAR_RATE_MAX, 0.4);
  assert.equal(allClearRateFor(0, null), ALL_CLEAR_RATE);
  assert.equal(allClearRateFor(100, S(0)), ALL_CLEAR_RATE_MAX);
  assert.equal(allClearRateFor(100, S(5000, [], 2)), ALL_CLEAR_RATE_MAX);
  assert.equal(allClearRateFor(100, S(10000, [2000, 3000])), ALL_CLEAR_RATE_MAX);
  assert.equal(allClearRateFor(1000, S(10000, [7000, 6000])), ALL_CLEAR_RATE);
  assert.ok(near(allClearRateFor(8000, S(10000)), ALL_CLEAR_RATE));
  assert.ok(near(allClearRateFor(9000, S(10000)), (ALL_CLEAR_RATE + ALL_CLEAR_RATE_AT_BEST) / 2));
  assert.ok(near(allClearRateFor(10000, S(10000)), ALL_CLEAR_RATE_AT_BEST));
  assert.equal(allClearRateFor(50000, S(10000)), ALL_CLEAR_RATE_MIN);
  let prev = 1;
  for (let s2 = 8000; s2 <= 14000; s2 += 100) { const r = allClearRateFor(s2, S(10000)); assert.ok(r <= prev + 1e-12); prev = r; }
});
test('Game は skill があれば、全消しのチャンスの確率も出来に合わせる', () => {
  const g = new Game({ random: () => 0.5 });
  g.skill = { best: 0, recent: [], games: 0 };
  g.spawnTray();
  assert.equal(g.allClearRate, ALL_CLEAR_RATE_MAX);
  g.score.score = 20000; g.skill = { best: 10000, recent: [], games: 20 };
  g.spawnTray();
  assert.equal(g.allClearRate, ALL_CLEAR_RATE_MIN);
});

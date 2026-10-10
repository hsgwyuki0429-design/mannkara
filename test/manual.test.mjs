import test from 'node:test';
import assert from 'node:assert/strict';
import { MANUAL_HTML as built, manualModule } from '../scripts/build-manual.mjs';
import { MANUAL_HTML as shipped } from '../src/ui/manual-content.js?v=202610100522';
import {
  chainMultiplier, streakMultiplier, SCORE_PER_GOAL, ALL_CLEAR_BONUS, ALL_CLEAR_BOOST, ALL_CLEAR_BOOST_TURNS,
  SCORE_PER_PERFECT_FIT_CELL, SCORE_PER_RECT_CELL, SIZE,
} from '../src/core/constants.js?v=202610100522';
import { ATTACK_MIN_CHAIN, ALL_CLEAR_ATTACK, MARGIN_MS, MARGIN_STEP_MS, MARGIN_MAX, BATTLE_SPEED } from '../src/core/battle.js?v=202610100522';

const text = built.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, '');

test('説明書（src/ui/manual-content.js）は、生成プログラムの今の出力と同じ（直したら node scripts/build-manual.mjs）', () => {
  assert.equal(shipped, built);
  assert.ok(manualModule().includes(JSON.stringify(built)));
});

test('説明書の作り: 10 の節・もくじ・図 7 つ。ゲームの画面と id が重ならない（mn- で始まる）', () => {
  assert.equal((built.match(/<section id="mn-/g) || []).length, 10);
  assert.equal((built.match(/<svg class="fig"/g) || []).length, 7);
  assert.equal((built.match(/<svg class="mn-defs"/g) || []).length, 1, '図の部品（グラデーション・矢印）は 1 か所だけ');
  const ids = [...built.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 10);
  for (const id of ids) assert.match(id, /^mn-/, `id ${id}`);
  assert.equal(new Set(ids).size, ids.length, 'id が重ならない');
  for (const m of built.matchAll(/data-go="([^"]+)"/g)) assert.ok(ids.includes(m[1]), `もくじの行き先 ${m[1]}`);
});

test('説明書の数字は、ゲームの今のルールと合っている（スコア・連鎖・コンボ・ボーナス）', () => {
  assert.ok(text.includes(`1個につき ${SCORE_PER_GOAL}点`));
  for (let n = 1; n <= 12; n++) assert.ok(text.includes(`${n}連鎖×${chainMultiplier(n)}`), `${n} 連鎖`);
  for (const [n, v] of [[1, '1'], [2, '1.1'], [3, '1.21'], [5, '1.46'], [10, '2.36'], [12, '2.85']]) {
    assert.ok(text.includes(`COMBO ${n}×${v}`), `COMBO ${n}`);
    assert.equal(streakMultiplier(n).toFixed(2).replace(/\.?0+$/, ''), v, `COMBO ${n} の倍率`);
  }
  assert.ok(text.includes(`+${SCORE_PER_PERFECT_FIT_CELL}点`) && text.includes(`+${SCORE_PER_RECT_CELL}点`));
  assert.ok(text.includes(`+${ALL_CLEAR_BONUS.toLocaleString('en-US')}点`));
  assert.ok(text.includes(`${ALL_CLEAR_BOOST_TURNS}手のあいだ`) && text.includes(`×${ALL_CLEAR_BOOST}`));
  assert.ok(text.includes('36マス') && SIZE === 8);
  // 例: COMBO 1 の手で、3 連鎖目にゴールへ 2 個 → 2 × 100 × 4 = 800
  assert.equal(2 * SCORE_PER_GOAL * chainMultiplier(3), 800);
  assert.ok(text.includes('2個 × 100点 × 4倍 ＝ 800点'));
});

test('説明書の数字は、対戦の今のルールと合っている', () => {
  assert.equal(ATTACK_MIN_CHAIN, 1);
  assert.ok(text.includes('1連鎖から送れます'));
  assert.ok(text.includes(`数字に＋${ALL_CLEAR_ATTACK}`));
  const sec = (ms) => `${Math.floor(ms / 60000)}分${String(Math.round((ms % 60000) / 1000)).padStart(2, '0')}秒`;
  assert.ok(text.includes(`${Math.floor(MARGIN_MS / 60000)}分${Math.round((MARGIN_MS % 60000) / 1000)}秒から`) && text.includes(sec(MARGIN_MS).replace('分', '分')) === true);
  assert.ok(text.includes(`${MARGIN_STEP_MS / 1000}秒ごとに1個ずつ増えて、最大${MARGIN_MAX}個`));
  assert.ok(BATTLE_SPEED > 0);
  assert.ok(text.includes('レート1000から'));
  // 削る量は連鎖の数ぶんの合計（5 連鎖なら −5）
  assert.ok(text.includes('5連鎖なら合計−5'));
});

test('説明書に、累計のプレイ数（ゲーム数）の表示の話は無い', () => {
  assert.ok(!text.includes('ゲーム数') && !text.includes('プレイ数'));
});

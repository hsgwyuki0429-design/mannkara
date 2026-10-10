// Google アナリティクス: 測定 ID が空・不正・開発環境のときは何も読み込まず、何も送らないこと。有効なときは gtag.js を 1 回だけ読み込むこと
import test from 'node:test';
import assert from 'node:assert/strict';
import { createAnalytics, GA_ID } from '../src/ui/analytics.js?v=202610100522';

function env({ host = 'blockmancala.pages.dev', dnt = null } = {}) {
  const scripts = [];
  const doc = { createElement: () => ({}), head: { appendChild: (s) => scripts.push(s) } };
  const win = { location: { hostname: host }, navigator: { doNotTrack: dnt } };
  return { doc, win, scripts };
}

test('測定 ID が空なら無効（読み込まない・送らない）', () => {
  const e = env();
  const a = createAnalytics({ id: '', doc: e.doc, win: e.win });
  a.track('x');
  assert.equal(a.enabled, false);
  assert.equal(e.scripts.length, 0);
  assert.equal(e.win.dataLayer, undefined);
});

test('形式が違う ID は無効', () => {
  for (const id of ['UA-1234-1', 'G-', 'abc', 'G-xx"><script>']) {
    const e = env();
    assert.equal(createAnalytics({ id, doc: e.doc, win: e.win }).enabled, false, id);
    assert.equal(e.scripts.length, 0);
  }
});

test('開発環境・トラッキング拒否（DNT）では送らない', () => {
  for (const o of [{ host: 'localhost' }, { host: '127.0.0.1' }, { dnt: '1' }]) {
    const e = env(o);
    assert.equal(createAnalytics({ id: 'G-ABC123DEF4', doc: e.doc, win: e.win }).enabled, false);
    assert.equal(e.scripts.length, 0);
  }
});

test('有効な ID なら gtag.js を読み込み、config とイベントを送る', () => {
  const e = env();
  const a = createAnalytics({ id: 'G-ABC123DEF4', doc: e.doc, win: e.win });
  assert.equal(a.enabled, true);
  assert.equal(e.scripts.length, 1);
  assert.match(e.scripts[0].src, /googletagmanager\.com\/gtag\/js\?id=G-ABC123DEF4$/);
  a.track('solo_over', { score: 1200 });
  const sent = e.win.dataLayer.map((x) => [...x]);
  assert.deepEqual(sent[1].slice(0, 2), ['config', 'G-ABC123DEF4']);
  assert.deepEqual(sent[2], ['event', 'solo_over', { score: 1200 }]);
});

test('出荷時の GA_ID は空か正しい形式のどちらか', () => {
  assert.ok(GA_ID === '' || /^G-[A-Z0-9]{6,12}$/.test(GA_ID));
});

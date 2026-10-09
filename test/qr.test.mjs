import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { makeQr } from '../src/ui/qr.js?v=202610091103';

// 正解は Python の qrcode（pip install qrcode）で作った行列（型番・誤り訂正・マスクを決め打ち。バイトモード）
const REF = JSON.parse(readFileSync(new URL('./qr-reference.json', import.meta.url), 'utf8'));

test('QR コード: Python の qrcode と同じ行列になる（型番 1〜10・誤り訂正 L/M/Q/H・マスク 8 種）', () => {
  assert.ok(REF.length >= 50);
  for (const c of REF) {
    const q = makeQr(c.text, { ecl: c.ecl, minVersion: c.v, mask: c.m });
    assert.equal(q.version, c.v, `${c.ecl} v${c.v}`);
    assert.deepEqual(q.modules.map((r) => r.map((v) => (v ? 1 : 0)).join('')), c.rows, `${c.text.slice(0, 12)} ${c.ecl} v${c.v} mask${c.m}`);
  }
});

test('QR コード: ゲームの URL は誤り訂正 H（まん中にロゴを置いても読める）で型番 4 に入る。マスクは失点の少ないもの', () => {
  const q = makeQr('https://blockmancala.pages.dev/', { ecl: 'H' });
  assert.equal(q.version, 4);
  assert.equal(q.size, 33);
  assert.ok(q.mask >= 0 && q.mask < 8);
  assert.throws(() => makeQr('x'.repeat(400), { ecl: 'H' }));
});

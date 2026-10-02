import test from 'node:test';
import assert from 'node:assert/strict';
import {
  Ambient, ambientLook, comboLook, nextCalm, skipOlive, hexToOklch, oklchToHex, contrastWithWhite, wrapHue, hueDelta,
  ORIGIN, BASE_HUE, TONES, MIN_CONTRAST,
} from '../src/ui/ambient.js?v=202610021033';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const hue = (hex) => hexToOklch(hex).h;

/** 最低限の DOM（要素・スタイル・アニメーション・meta）。層の重なりと色の指定だけ確かめる */
function fakeDoc() {
  const style = () => ({ props: {}, setProperty(k, v) { this.props[k] = v; }, getPropertyValue(k) { return this.props[k]; } });
  const el = () => {
    const e = {
      style: style(), children: [], attrs: {}, anims: [],
      setAttribute(k, v) { e.attrs[k] = v; },
      append(c) { e.children.push(c); },
      animate(frames, opts) { const a = { frames, opts, canceled: false, cancel() { a.canceled = true; } }; e.anims.push(a); return a; },
    };
    return e;
  };
  const meta = el();
  return { createElement: () => el(), body: { prepend(c) { this.child = c; } }, documentElement: { style: style() }, querySelector: (s) => (s.includes('theme-color') ? meta : null), meta };
}
const make = ({ reduced = false } = {}) => {
  const doc = fakeDoc();
  const a = new Ambient({ doc, win: { matchMedia: () => ({ matches: reduced }) } });
  a.shown = [];
  const real = a.show.bind(a);
  a.show = (look, ms) => { a.shown.push({ hue: look.hue, tone: look.tone, ms }); real(look, ms); };
  return { a, doc };
};
const stop = (a) => { a.clearHold(); for (const t of a.hops) clearTimeout(t); a.hops.clear(); };

test('色相の計算: 一周にそろえ、近い方まわりの角度を返す', () => {
  assert.equal(wrapHue(370), 10); assert.equal(wrapHue(-30), 330);
  assert.equal(hueDelta(350, 10), 20); assert.equal(hueDelta(10, 350), -20);
  assert.ok(Math.abs(Math.abs(hueDelta(0, 180)) - 180) < 1e-9);
});

test('最初の色は今の背景（#2451c4 / #2e60d6）そのもの。同じ明るさ・鮮やかさの青を作っても数値が合う', () => {
  const look = ambientLook(BASE_HUE, 'base');
  assert.equal(look.lo, ORIGIN.lo); assert.equal(look.hi, ORIGIN.hi);
  // 元の青から読み取った明るさ・鮮やかさで同じ色相の色を作り直すと、元の青（8bit の丸め 1〜2 以内）に戻る
  const again = oklchToHex(TONES.base.L, TONES.base.C, BASE_HUE);
  const d = (a, b) => [1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  assert.ok(d(again, ORIGIN.lo).every((v) => v <= 2), `${again} vs ${ORIGIN.lo}`);
});

test('どの色相・どの濃さでも、白い固定の文字が読める（縁の色 4.5 以上、中央の明るい色も 4.3 以上）', () => {
  for (const tone of Object.keys(TONES)) {
    for (let h = 0; h < 360; h += 2) {
      const { lo, hi } = ambientLook(h, tone);
      assert.ok(contrastWithWhite(lo) >= 4.5, `${tone} ${h}° lo ${lo} ${contrastWithWhite(lo).toFixed(2)}`);
      assert.ok(contrastWithWhite(hi) >= MIN_CONTRAST - 0.02, `${tone} ${h}° hi ${hi} ${contrastWithWhite(hi).toFixed(2)}`);
    }
  }
});

test('明るさは色相を回しても同じ（base は今の青と同じ L、soft は淡く、deep は濃い）', () => {
  for (let h = 0; h < 360; h += 5) {
    const base = hexToOklch(ambientLook(h, 'base').lo), soft = hexToOklch(ambientLook(h, 'soft').lo), deep = hexToOklch(ambientLook(h, 'deep').lo);
    assert.ok(Math.abs(base.L - TONES.base.L) < 0.012, `${h}° base L ${base.L}`);
    assert.ok(soft.L > base.L + 0.02 && deep.L < base.L - 0.05, `${h}° ${soft.L} ${base.L} ${deep.L}`);
  }
});

test('色相はほぼ指定どおり（鮮やかさを縮めても色相は動かない）で、中央のほうが明るい', () => {
  for (const tone of Object.keys(TONES)) {
    for (let h = 0; h < 360; h += 20) {
      const look = ambientLook(h, tone);
      if (hexToOklch(look.lo).C > 0.05) assert.ok(Math.abs(hueDelta(hue(look.lo), h)) < 4, `${tone} ${h}° → ${hue(look.lo)}`);
      assert.ok(hexToOklch(look.hi).L > hexToOklch(look.lo).L);
    }
  }
});

test('同じ色相と濃さなら同じ色を使い回す（背景の層は色ごとに作り直さない）', () => {
  assert.equal(ambientLook(123.4, 'soft'), ambientLook(123.4, 'soft'));
  assert.notEqual(ambientLook(123.4, 'soft'), ambientLook(123.4, 'deep'));
  assert.equal(ambientLook(10, 'nope').tone, 'base');
});

test('コンボの色: 1コンボごとに色相が進み、5 の倍数で大きく進む。オリーブ色には落ち着かない', () => {
  const calm = { hue: BASE_HUE, tone: 'base' };
  const a = comboLook(calm, 2), b = comboLook(calm, 3), c = comboLook(calm, 4), d = comboLook(calm, 5);
  assert.equal(a.tone, 'soft'); assert.equal(b.tone, 'deep'); assert.equal(c.tone, 'base');
  assert.ok(Math.abs(hueDelta(a.hue, b.hue) - 34) < 1e-6 && Math.abs(hueDelta(b.hue, c.hue) - 34) < 1e-6);
  assert.ok(hueDelta(c.hue, d.hue) > 60, '5 の倍数では大きく進む');
  for (let h = 0; h < 360; h += 7) for (let s = 2; s <= 40; s++) {
    const l = comboLook({ hue: h, tone: 'base' }, s);
    assert.ok(!(l.hue > 80 && l.hue < 138), `calm ${h} streak ${s} → ${l.hue}`);
  }
  assert.equal(skipOlive(100), 142); assert.equal(skipOlive(60), 60); assert.equal(skipOlive(200), 200);
  assert.equal(nextCalm({ hue: 60, tone: 'base' }, 1).hue, 142, '60° + 27° = 87° はオリーブ域なので越える');
  assert.equal(nextCalm({ hue: 200, tone: 'base' }, 1).hue, 227);
});

test('ふだんの色は、発動しない手が5回続くたびに進む（それまでは動かない）', async () => {
  const { a } = make();
  for (let i = 0; i < 4; i++) a.turn({ steps: [], streak: 0 });
  assert.equal(a.shown.length, 0); assert.equal(a.layers.filter((l) => l.on).length, 0);
  a.turn({ steps: [], streak: 0 });
  assert.equal(a.shown.length, 1);
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.shown[0].hue) - 27) < 1e-6);
  assert.equal(a.shown[0].tone, 'soft');
  stop(a);
});

test('コンボはグラデーション、5 の倍数は一気に（短い重ね）。コンボが途切れたらふだんの色へ戻る', async () => {
  const { a } = make();
  a.turn({ steps: [1], streak: 2 });
  assert.equal(a.shown.at(-1).ms, 1400);
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.shown.at(-1).hue) - 34) < 1e-6);
  a.turn({ steps: [1], streak: 5 });
  assert.ok(a.shown.at(-1).ms >= 90 && a.shown.at(-1).ms <= 200, '一気に変わる');
  const before = a.shown.length;
  a.turn({ steps: [], streak: 0 });                        // コンボ終了 → ふだんの色（最初は元の青）へ
  stop(a);                                                 // 遠い色からは、続きの小さな重ねを予約する
  assert.ok(a.shown.length > before);
  assert.equal(a.rest.hue, BASE_HUE);
});

test('遠い色へのグラデーションは、40° 以内の小さな重ねを続ける。一気に変わるときは 1 回', async () => {
  const { a } = make();
  a.go(BASE_HUE + 160, 'base', 60);
  await wait(110);
  assert.ok(a.shown.length >= 4, `重ね ${a.shown.length} 回`);
  let prev = BASE_HUE;
  for (const s of a.shown) { assert.ok(Math.abs(hueDelta(prev, s.hue)) <= 40.001, `${prev} → ${s.hue}`); prev = s.hue; }
  assert.ok(Math.abs(hueDelta(prev, BASE_HUE + 160)) < 1e-6);
  const n = a.shown.length;
  a.go(BASE_HUE - 100, 'base', 100, { snap: true });
  assert.equal(a.shown.length, n + 1);
  stop(a);
});

test('全消しは色相を 1 周して、少し先の色で止まる', () => {
  const { a } = make();
  a.celebrate('clear');
  assert.equal(a.shown.length, 1, '最初の重ね。続きは時間をおいて予約される');
  assert.equal(a.hops.size, 9, '1 周を 10 回の小さな重ねに分ける');
  const total = 360 + hueDelta(BASE_HUE, a.calm.hue);
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.shown[0].hue) - total / 10) < 1e-6);
  assert.ok(total / 10 <= 40, '1 回の重ねは 40° 以内');
  assert.equal(a.shown[0].tone, 'soft');
  assert.ok(Math.abs(hueDelta(a.hue, a.calm.hue)) < 1e-6, '行き先はふだんの色の少し先');
  stop(a);
});

test('お祝いの色を見せている間は、手が置かれても色を上書きしない（落ち着く先だけ覚える）', () => {
  const { a } = make();
  a.celebrate('best');
  const n = a.shown.length;
  a.turn({ steps: [1], streak: 3 });
  assert.equal(a.shown.length, n);
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.rest.hue) - 68) < 1e-6);
  a.celebrate('best');                                     // 続けて来ても重ねない
  assert.equal(a.shown.length, n);
  a.reset();                                               // リスタートでお祝いは打ち切り、元の青へ
  assert.equal(a.holdTimer, 0);
  assert.equal(a.hue, BASE_HUE); assert.equal(a.tone, 'base');
  stop(a);
});

test('Amazing 以上の連鎖は一気に明るい別の色へ（それ未満では変えない）', () => {
  const { a } = make();
  a.chain(3); assert.equal(a.shown.length, 0);
  a.chain(4);
  assert.equal(a.shown.length, 1); assert.equal(a.shown[0].tone, 'soft');
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.shown[0].hue)) > 100);
  stop(a);
});

test('動きを減らす設定では、遠い色へも小さな重ね 1 回を、ゆっくり（急な点滅にしない）', () => {
  const { a } = make({ reduced: true });
  a.go(BASE_HUE + 160, 'base', 100);
  assert.equal(a.shown.length, 1); assert.ok(a.shown[0].ms >= 700);
  a.go(BASE_HUE + 10, 'base', 100, { snap: true });
  assert.ok(a.shown.at(-1).ms >= 90);
  stop(a);
});

test('層の入れ替え: 新しい色は一番上へ opacity だけで重ね、覆い終わったら下の層を外し、ブラウザのバーの色も合わせる', () => {
  const { a, doc } = make();
  a.go(BASE_HUE + 30, 'base', 500);
  a.go(BASE_HUE + 60, 'base', 500);
  const on = a.layers.filter((l) => l.on);
  assert.equal(on.length, 2);
  assert.ok(on[1].z > on[0].z);
  assert.deepEqual(on[1].anim.frames, [{ opacity: 0 }, { opacity: 1 }]);
  on[1].anim.onfinish();                                   // 上の層が全面を覆った
  assert.equal(a.layers.filter((l) => l.on).length, 1);
  assert.equal(on[0].el.style.display, 'none'); assert.equal(on[1].el.style.opacity, '1');
  assert.equal(doc.meta.attrs.content, ambientLook(BASE_HUE + 60, 'base').lo);
  assert.equal(doc.documentElement.style.props['--amb-glow'], ambientLook(BASE_HUE + 60, 'base').glow);
  for (let i = 0; i < 10; i++) a.show(ambientLook(i * 30, 'base'), 300);       // 層が足りなくなっても、一番古い層を使い回す
  assert.ok(a.layers.every((l) => a.layers.filter((m) => m.z === l.z).length === 1));
  stop(a);
});

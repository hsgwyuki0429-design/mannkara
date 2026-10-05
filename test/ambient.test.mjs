import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Ambient, ambientLook, comboLook, comboStyle, COMBO_STYLE, nextHue, nextTone, skipOlive, hexToOklch, oklchToHex, contrastWithWhite, wrapHue, hueDelta,
  ORIGIN, BASE_HUE, TONES, MIN_CONTRAST, BOARD, BOARD_VARS, boardLook, PLATE_SETS, CALM_EVERY, CALM_MS, COMBO_MS, SNAP_MS,
} from '../src/ui/ambient.js?v=202610051326';

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
  const byId = { fever: el(), danger: el(), sceneTint: el() };            // 同系色の重ね（--amb-glow）を使う要素
  return { createElement: () => el(), body: { style: { background: '' }, prepend(c) { this.child = c; } }, documentElement: { style: style() }, getElementById: (id) => byId[id] ?? null, byId, querySelector: (s) => (s.includes('theme-color') ? meta : null), meta };
}
/** 種を決めた乱数（0〜1）。同じ種なら同じ並びになる */
const rng = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
const make = ({ reduced = false, rand = () => 0.5 } = {}) => {
  const doc = fakeDoc();
  const a = new Ambient({ doc, rand, win: { matchMedia: () => ({ matches: reduced }) } });
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

test('最初の色は今の背景（styles.css の --bg / --bg-hi と同じ #3a6adf / #4479f2）そのもの。同じ明るさ・鮮やかさの青を作っても数値が合う', () => {
  const look = ambientLook(BASE_HUE, 'base');
  assert.equal(look.lo, ORIGIN.lo); assert.equal(look.hi, ORIGIN.hi);
  const css = readFileSync(new URL('../src/ui/styles.css?v=202610051326', import.meta.url), 'utf8');
  assert.ok(css.includes(`--bg:${ORIGIN.lo}; --bg-hi:${ORIGIN.hi};`), 'styles.css の背景と同じ（最初の 1 枚目は CSS のまま見える）');
  for (const f of ['../index.html', '../manifest.webmanifest']) assert.ok(readFileSync(new URL(f, import.meta.url), 'utf8').includes(ORIGIN.lo), `${f} の theme-color / background_color も同じ`);
  // 元の青から読み取った明るさ・鮮やかさで同じ色相の色を作り直すと、元の青（8bit の丸め 1〜2 以内）に戻る
  const again = oklchToHex(TONES.base.L, TONES.base.C, BASE_HUE);
  const d = (a, b) => [1, 3, 5].map((i) => Math.abs(parseInt(a.slice(i, i + 2), 16) - parseInt(b.slice(i, i + 2), 16)));
  assert.ok(d(again, ORIGIN.lo).every((v) => v <= 2), `${again} vs ${ORIGIN.lo}`);
});

test('どの色相・どの濃さでも、白い固定の文字が読める（縁の色 4.0 以上、中央の明るい色も MIN_CONTRAST = 3.6 以上。明るくしたぶん、以前の 4.5 / 4.3 から下げた）', () => {
  assert.equal(MIN_CONTRAST, 3.6);
  for (const tone of Object.keys(TONES)) {
    for (let h = 0; h < 360; h += 2) {
      const { lo, hi } = ambientLook(h, tone);
      assert.ok(contrastWithWhite(lo) >= 4.0, `${tone} ${h}° lo ${lo} ${contrastWithWhite(lo).toFixed(2)}`);
      assert.ok(contrastWithWhite(hi) >= MIN_CONTRAST - 0.02, `${tone} ${h}° hi ${hi} ${contrastWithWhite(hi).toFixed(2)}`);
    }
  }
});

test('明るさは色相を回しても同じ（base は今の青と同じ L、soft は淡く、deep は濃い）。白との対比で下げるのは、輝度の高い緑〜青緑の淡い段だけ', () => {
  for (let h = 0; h < 360; h += 5) {
    const base = hexToOklch(ambientLook(h, 'base').lo), soft = hexToOklch(ambientLook(h, 'soft').lo), deep = hexToOklch(ambientLook(h, 'deep').lo);
    assert.ok(Math.abs(base.L - TONES.base.L) < 0.012, `${h}° base L ${base.L}`);
    assert.ok(soft.L > base.L && deep.L < base.L - 0.035, `${h}° ${soft.L} ${base.L} ${deep.L}`);
    if (h < 70 || h > 270) assert.ok(soft.L > base.L + 0.02, `${h}° 赤・桃・紫の淡い段は、ふだんの色よりはっきり淡い ${soft.L} ${base.L}`);
    assert.ok(deep.L > 0.47, `${h}° 濃い段も暗くしすぎない（以前のふだんの青 0.478 と同じくらいまで）${deep.L}`);
  }
});

test('背景は以前より明るい（動画映り）: 最初の青の明るさは 0.478 → 0.558。どの色相でもふだんの色は以前より 0.07 以上明るく、濃い段も以前のふだんの青と同じくらい', () => {
  assert.ok(Math.abs(hexToOklch(ORIGIN.lo).L - 0.558) < 0.004, `${hexToOklch(ORIGIN.lo).L}`);
  const OLD = 0.478;
  for (let h = 0; h < 360; h += 10) {
    assert.ok(hexToOklch(ambientLook(h, 'base').lo).L > OLD + 0.07, `${h}° base`);
    assert.ok(hexToOklch(ambientLook(h, 'deep').lo).L > OLD + 0.02, `${h}° deep`);
  }
  // 白い小さな文字のための下限: 緑〜青緑の淡い段（輝度が高い）だけ、明るさを下げて中央の対比を保つ
  const green = ambientLook(150, 'soft'); assert.ok(hexToOklch(green.lo).L < TONES.soft.L - 0.01);
  assert.ok(contrastWithWhite(green.hi) >= MIN_CONTRAST - 0.02);
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
});

test('コンボの色の進み方はコンボごとに引き直す（向き・幅・濃さの回り始めがばらつく）。向きが逆なら逆に進む', () => {
  const r = rng(7), styles = Array.from({ length: 200 }, () => comboStyle(r));
  assert.ok(styles.some((s) => s.dir > 0) && styles.some((s) => s.dir < 0), '向きは両方ある');
  assert.ok(styles.every((s) => s.step >= 22 && s.step <= 38 && s.jump >= 48 && s.jump <= 88), '幅は決めた範囲');
  assert.ok(new Set(styles.map((s) => Math.round(s.step))).size > 8, '幅はばらつく');
  assert.deepEqual([...new Set(styles.map((s) => s.tone))].sort(), [0, 1, 2]);
  const calm = { hue: 200, tone: 'base' };
  const up = comboLook(calm, 3, { dir: 1, step: 30, jump: 60, tone: 0 }), down = comboLook(calm, 3, { dir: -1, step: 30, jump: 60, tone: 0 });
  assert.ok(Math.abs(hueDelta(200, up.hue) - 60) < 1e-6 && Math.abs(hueDelta(200, down.hue) + 60) < 1e-6);
  assert.equal(comboLook(calm, 2, { ...COMBO_STYLE, tone: 1 }).tone, 'deep', '濃さの回り始めもずれる');
  for (let h = 0; h < 360; h += 9) for (let k = 0; k < 20; k++) {
    for (let st = 2; st <= 30; st++) { const l = comboLook({ hue: h, tone: 'base' }, st, comboStyle(r)); assert.ok(!(l.hue > 80 && l.hue < 138), `${h} ${st} → ${l.hue}`); }
  }
});

test('ふだんの色の並びは毎回ちがう: 幅と向きがばらつき、最近の色の近くには戻らず、オリーブ色にならない', () => {
  const seqs = []; let tight = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const r = rng(seed);
    let hue = BASE_HUE, dir = 1, recent = [BASE_HUE];
    const seq = [], steps = [];
    for (let i = 0; i < 60; i++) {
      const n = nextHue(hue, { recent, dir, rand: r });
      assert.ok(!(n.hue > 80 && n.hue < 138), `オリーブ域 ${n.hue}`);
      const gap = Math.min(...recent.map((q) => Math.abs(hueDelta(q, n.hue))));
      if (gap < 40) tight++;
      assert.ok(gap >= 12, `${i}: ${n.hue} は最近の色 ${recent.map(Math.round)} に近すぎる（${gap}°）`);
      steps.push(hueDelta(hue, n.hue));
      hue = n.hue; dir = n.dir; recent = [...recent, hue].slice(-4); seq.push(Math.round(hue));
    }
    assert.ok(steps.some((d) => d > 0) && steps.some((d) => d < 0), `向きが入れ替わる（種 ${seed}）`);
    assert.ok(new Set(steps.map((d) => Math.round(Math.abs(d) / 10))).size >= 5, '幅がばらつく');
    assert.ok(Math.max(...steps.map(Math.abs)) <= 180 && Math.min(...steps.map(Math.abs)) >= 40, '前の色の近くへも、反対側の極端な所へも行かない');
    seqs.push(seq.join(','));
  }
  assert.ok(tight <= 360 * 0.05, `最近の色の 40° 以内に落ち着いたのは ${tight} / 360 回（ほとんど起きない）`);
  assert.equal(new Set(seqs).size, seqs.length, '種ごとに並びがちがう');
  const covered = new Set(); for (const q of seqs) for (const h of q.split(',')) covered.add(Math.floor(h / 30));
  assert.ok(covered.size >= 8, '色相の輪のあちこちを通る');
});

test('濃さも毎回選ぶ（3 種類とも出る。淡い・濃いが同じ濃さで続かない）', () => {
  const r = rng(11);
  let prev = 'base'; const seen = new Set();
  for (let i = 0; i < 300; i++) { const t = nextTone(prev, r); seen.add(t); if (prev !== 'base') assert.notEqual(t, prev, `${i}: ${prev} が続いた`); prev = t; }
  assert.deepEqual([...seen].sort(), ['base', 'deep', 'soft']);
});

test('色の変わり方はゆっくり（ふだんは 8 手に 1 回・5 秒かけて、コンボは 2 秒以上、一気にでも 0.4 秒以上）', () => {
  assert.ok(CALM_EVERY >= 8 && CALM_MS >= 5000 && COMBO_MS >= 2000 && SNAP_MS >= 400, `${CALM_EVERY} ${CALM_MS} ${COMBO_MS} ${SNAP_MS}`);
});

test('ふだんの色は、発動しない手が 8 回続くたびに、5 秒かけて進む（それまでは動かない）。コンボ中は数えない', async () => {
  const { a } = make({ rand: rng(3) });
  for (let i = 0; i < CALM_EVERY - 1; i++) a.turn({ steps: [], streak: 0 });
  assert.equal(a.shown.length, 0); assert.equal(a.layers.filter((l) => l.on).length, 0);
  a.turn({ steps: [], streak: 0 });
  assert.equal(a.shown.length, 1);
  const d = Math.abs(hueDelta(BASE_HUE, a.calm.hue)), n = Math.max(1, Math.min(10, Math.ceil(d / 40)));
  assert.ok(Math.abs(a.shown[0].ms - (n === 1 ? CALM_MS : (CALM_MS / n) * 1.5)) < 1e-6, `重ね 1 回の長さ ${a.shown[0].ms}（全体 ${CALM_MS}ms を ${n} 回に分ける）`);
  assert.ok(d >= 40 && d <= 176, `進む幅 ${d}`);
  assert.deepEqual(a.recent.map(Math.round), [Math.round(BASE_HUE), Math.round(a.calm.hue)]);
  stop(a);
  const b = make({ rand: rng(3) }).a;                                    // コンボで進んだ手は、発動しない手に数えない
  for (let i = 0; i < CALM_EVERY - 1; i++) b.turn({ steps: [], streak: 0 });
  b.turn({ steps: [1], streak: 2 });
  assert.equal(b.calm.hue, BASE_HUE, '8 手目がコンボなら、ふだんの色は動かない');
  stop(b);
});

test('コンボはグラデーション、5 の倍数は一気に（短い重ね）。コンボが途切れたらふだんの色へ戻る。次のコンボは進み方を引き直す', async () => {
  const { a } = make({ rand: rng(5) });
  a.turn({ steps: [1], streak: 2 });
  assert.equal(a.shown.at(-1).ms, Math.round(a.shown.at(-1).ms) && a.shown.at(-1).ms, 'ms');
  assert.ok(a.combo, 'コンボが始まったら進み方を引く');
  const style = a.combo, first = a.shown.at(-1).hue;
  assert.ok(Math.abs(hueDelta(BASE_HUE, first) - style.dir * style.step) < 1e-6 || skipOlive(wrapHue(BASE_HUE + style.dir * style.step)) === first);
  a.turn({ steps: [1], streak: 3 });
  assert.equal(a.combo, style, '同じコンボの間は、進み方を変えない');
  a.turn({ steps: [1], streak: 5 });
  assert.ok(a.shown.at(-1).ms >= 90 && a.shown.at(-1).ms <= SNAP_MS + 1, '一気に変わる（それでも 0.4 秒かけて）');
  const before = a.shown.length;
  a.turn({ steps: [], streak: 0 });                        // コンボ終了 → ふだんの色（最初は元の青）へ
  stop(a);                                                 // 遠い色からは、続きの小さな重ねを予約する
  assert.ok(a.shown.length > before);
  assert.equal(a.rest.hue, BASE_HUE); assert.equal(a.combo, null, 'コンボが途切れたら捨てる');
  a.turn({ steps: [1], streak: 2 });
  assert.notEqual(a.combo, style, '次のコンボは引き直す');
  stop(a);
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

test('全消しは色相をぐるりと 1 周して（向きはばらす）、次のふだんの色で止まる', () => {
  const ways = new Set();
  for (const seed of [2, 9, 4, 6, 12, 15]) {
    const { a } = make({ rand: rng(seed) });
    a.celebrate('clear'); ways.add(a.dir);
    assert.equal(a.shown.length, 1, '最初の重ね。続きは時間をおいて予約される');
    assert.equal(a.hops.size, 9, '1 周を 10 回の小さな重ねに分ける');
    assert.equal(Math.sign(hueDelta(BASE_HUE, a.shown[0].hue)), a.dir, '1 周する向きは、ふだんの色が進む向き（毎回ばらける）');
    assert.equal(a.shown[0].tone, 'soft');
    assert.ok(Math.abs(hueDelta(a.hue, a.calm.hue)) < 1e-6, '行き先は次のふだんの色');
    assert.ok(Math.abs(hueDelta(BASE_HUE, a.calm.hue)) >= 40, '前の色の近くには止まらない');
    stop(a);
  }
  assert.equal(ways.size, 2, '1 周する向きは両方ある');
});

test('お祝いの色を見せている間は、手が置かれても色を上書きしない（落ち着く先だけ覚える）', () => {
  const { a } = make();
  a.celebrate('best');
  const n = a.shown.length;
  a.turn({ steps: [1], streak: 3 });
  assert.equal(a.shown.length, n);
  assert.deepEqual(a.rest, comboLook(a.calm, 3, a.combo), '落ち着く先（コンボの色）だけ覚える');
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
  assert.ok(Math.abs(hueDelta(BASE_HUE, a.shown[0].hue)) > 85);
  assert.equal(a.shown[0].ms, SNAP_MS);
  stop(a);
});

test('Amazing 以上の連鎖・新記録の別の色への跳びは、向きと幅がばらつき、オリーブ色にはならない', () => {
  const r = rng(21), dirs = new Set(), hues = [];
  for (let i = 0; i < 80; i++) {
    const { a } = make({ rand: r });
    a.hue = (i * 37) % 360;                                  // 色相をばらして始める
    const from = a.hue;
    if (i % 2) a.chain(i % 4 ? 4 : 5); else a.celebrate('best');
    const to = a.shown.at(-1).hue;
    assert.ok(!(to > 80 && to < 138), `${from}° → ${to}°（オリーブ域）`);
    dirs.add(Math.sign(hueDelta(from, to)));
    hues.push(Math.round(Math.abs(hueDelta(from, to))));
    stop(a);
  }
  assert.deepEqual([...dirs].sort(), [-1, 1], '向きは両方ある');
  assert.ok(new Set(hues).size > 15, '幅もばらつく');
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
  assert.equal(on.length, 3, '今の色の層（下敷き）+ 重ねた 2 枚');
  assert.ok(on[1].z > on[0].z && on[2].z > on[1].z);
  assert.deepEqual(on[2].anim.frames, [{ opacity: 0 }, { opacity: 1 }]);
  on[1].anim.onfinish();                                   // 途中の層が覆い終わっても、上にまだ重ねている層があるうちは落ち着かない
  assert.equal(a.root.hidden, false); assert.equal(on[0].el.style.display, 'none', '覆われた下敷きは外れる');
  assert.equal(a.layers.filter((l) => l.on).length, 2);
  on[2].anim.onfinish();                                   // 一番上の層が全面を覆った
  assert.equal(a.layers.filter((l) => l.on).length, 0, '落ち着いたら層は全部片づく');
  assert.equal(doc.meta.attrs.content, ambientLook(BASE_HUE + 60, 'base').lo);
  const glow = ambientLook(BASE_HUE + 60, 'base').glow;
  for (const id of ['fever', 'danger', 'sceneTint']) assert.equal(doc.byId[id].style.props['--amb-glow'], glow, `${id} へ同系色`);
  assert.equal(doc.documentElement.style.props['--amb-glow'], undefined, 'ルートには書かない（書くと全要素のスタイルを計算し直す）');
  for (let i = 0; i < 10; i++) a.show(ambientLook(i * 30, 'base'), 300);       // 層が足りなくなっても、一番古い層を使い回す
  assert.ok(a.layers.every((l) => a.layers.filter((m) => m.z === l.z).length === 1));
  stop(a);
});

test('色が落ち着いている間は全面の層を使わない: 変わり始めに今の色の層を下に敷き、覆い終わったら body に描いて層を片づける', () => {
  const { a, doc } = make();
  assert.equal(a.root.hidden, true, '最初は層なし（body の今の青）');
  assert.equal(a.layers.filter((l) => l.on).length, 0);
  a.go(BASE_HUE + 30, 'base', 500);
  assert.equal(a.root.hidden, false);
  const on = a.layers.filter((l) => l.on);
  assert.equal(on.length, 2, '今の色の層 + 新しい色の層');
  assert.equal(on[0].el.style.opacity, '1'); assert.equal(on[0].el.style.props['--lo'], ORIGIN.lo); assert.equal(on[0].el.style.props['--hi'], ORIGIN.hi);
  assert.equal(on[1].el.style.opacity, '0', '新しい色は 0 から重ねる');
  on[1].anim.onfinish();
  assert.equal(a.root.hidden, true);
  assert.ok(a.layers.every((l) => !l.on && l.el.style.display === 'none' && !l.anim));
  const look = ambientLook(BASE_HUE + 30, 'base');
  assert.ok(doc.body.style.background.includes(look.lo) && doc.body.style.background.includes(look.hi) && doc.body.style.background.includes('radial-gradient(90% 55% at 50% 30%'), doc.body.style.background);
  assert.equal(a.settled, look);
  a.go(BASE_HUE + 60, 'base', 500);                        // 次の変化は、body に描いてある色（さっきの色）の層から始まる
  const base = a.layers.find((l) => l.on && l.el.style.opacity === '1');
  assert.equal(base.el.style.props['--lo'], look.lo);
  stop(a);
  // 重ねている途中の層が残っているうちは落ち着かない（遠い色へ小さな重ねを続けるとき）
  const b = make().a;
  b.show(ambientLook(BASE_HUE + 20, 'base'), 400); b.show(ambientLook(BASE_HUE + 40, 'base'), 400);
  const [, first, second] = b.layers.filter((l) => l.on);
  first.anim.onfinish();
  assert.equal(b.root.hidden, false, '2 枚目がまだ重なっている');
  second.anim.onfinish();
  assert.equal(b.root.hidden, true);
  stop(b);
});

/* ---------------- 盤面の土台（プレート）も背景と一緒に変わる ---------------- */

const css = readFileSync(new URL('../src/ui/styles.css?v=202610051326', import.meta.url), 'utf8');
/** 'rgba(4, 12, 60, .7)' や '#1A3EAE' を比べられる形（数値の配列・小文字）にそろえる */
const norm = (c) => (c.startsWith('#') ? c.toLowerCase() : c.match(/[\d.]+/g).map(Number));

test('盤面の土台の最初の色は、styles.css の .well-set の変数と同じ（今の青のまま）', () => {
  const block = css.match(/\.well-set\{([^}]*)\}/)[1];
  const base = boardLook(BASE_HUE, 'base');
  assert.deepEqual(Object.keys(base), Object.keys(BOARD_VARS));
  for (const name of Object.keys(BOARD_VARS)) {
    const m = block.match(new RegExp(`${name}:\\s*([^;]+);`));
    assert.ok(m, `${name} が .well-set に無い`);
    assert.deepEqual(norm(base[name]), norm(m[1].trim()), name);
  }
  assert.equal(css.includes('--plate:#1a3eae; --well:#0b163f'), false, '使われていない古い変数は残さない');
});

test('土台の色: どの色相・濃さでも、背景と同じ色相で、背景より暗い板と、もっと暗いくぼみ。暗さの差は今の青と同じ（白との対比で背景を下げた色相でも、土台は背景に合わせて下がる）', () => {
  const baseGap = hexToOklch(ambientLook(BASE_HUE, 'base').lo).L - hexToOklch(BOARD.plate).L;
  assert.ok(baseGap > 0.06 && baseGap < 0.1, `最初の青の土台は背景より少し暗い ${baseGap}`);
  for (const tone of Object.keys(TONES)) {
    for (let h = 0; h < 360; h += 6) {
      const look = ambientLook(h, tone), bg = hexToOklch(look.lo), v = look.board;
      const plate = hexToOklch(v['--plate']), well = hexToOklch(v['--well']);
      assert.ok(Math.abs(bg.L - plate.L - baseGap) < 0.02, `${tone} ${h}° 板の暗さの差 ${(bg.L - plate.L).toFixed(3)}`);
      assert.ok(well.L < plate.L - 0.03, `${tone} ${h}° くぼみは板より暗い ${well.L.toFixed(3)} < ${plate.L.toFixed(3)}`);
      if (plate.C > 0.04) assert.ok(Math.abs(hueDelta(plate.h, h)) < 6, `${tone} ${h}° 板の色相 ${plate.h.toFixed(1)}`);
      if (well.C > 0.04) assert.ok(Math.abs(hueDelta(well.h, h)) < 8, `${tone} ${h}° くぼみの色相 ${well.h.toFixed(1)}`);
    }
  }
});

test('土台の縁・光・影も同じ色相へ回る。縁の線はくぼみ・板より明るく、影はくぼみより暗い', () => {
  for (const h of [0, 40, 100, 150, 200, 250, 300, 340]) {
    const v = boardLook(h, 'base');
    const L = (name) => { const [r, g, b] = v[name].match(/[\d.]+/g).map(Number); return hexToOklch('#' + [r, g, b].map((x) => x.toString(16).padStart(2, '0')).join('')); };
    assert.ok(L('--well-rim').L > hexToOklch(v['--plate']).L + 0.1 && L('--well-hi').L > L('--well-rim').L, `${h}° 縁の線の明るさ`);
    assert.ok(L('--well-s1').L < hexToOklch(v['--well']).L && L('--plate-shade').L < hexToOklch(v['--well']).L, `${h}° 影の暗さ`);
    for (const name of ['--well-rim', '--well-hi', '--plate-edge']) assert.ok(Math.abs(hueDelta(L(name).h, h)) < 12 || L(name).C < 0.04, `${h}° ${name} の色相 ${L(name).h.toFixed(1)}`);
    for (const name of Object.keys(BOARD_VARS)) assert.ok(/^(#[0-9a-f]{6}|rgba\(\d+,\d+,\d+,[\d.]+\))$/.test(v[name]), `${name}: ${v[name]}`);
  }
  assert.equal(ambientLook(77, 'deep').board['--plate'], boardLook(77, 'deep')['--plate'], '背景の色と一緒に持つ');
});

/** 土台の層（最初の 1 枚が見えている）を持つ Ambient */
const makeBoard = (opts) => {
  const r = make(opts), el = r.doc.createElement();
  const sets = Array.from({ length: PLATE_SETS }, () => r.doc.createElement());
  r.a.bindBoard(sets);
  return { ...r, sets };
};

test('土台の層は背景の層と同じ瞬間・同じ長さ・同じ動き（opacity だけ）で重なり、覆い終わったら下の層を外す', () => {
  const { a, sets } = makeBoard();
  assert.equal(a.plates.filter((p) => p.on).length, 1, '最初は 0 番だけが見えている');
  a.go(BASE_HUE + 30, 'base', 500);
  a.go(BASE_HUE + 60, 'base', 800);
  const bg = a.layers.filter((l) => l.on && l.plate), pl = a.plates.filter((p) => p.on);
  assert.equal(bg.length, 2); assert.equal(pl.length, 3, '重ねた背景の 2 枚 + 最初の青');
  for (const l of bg) {
    const p = l.plate;
    assert.deepEqual(p.anim.frames, l.anim.frames); assert.deepEqual(p.anim.frames, [{ opacity: 0 }, { opacity: 1 }]);
    assert.equal(p.anim.opts.duration, l.anim.opts.duration); assert.equal(p.anim.opts.easing, l.anim.opts.easing);
    assert.equal(p.z, l.z, '重なる順番も同じ');
  }
  const look = ambientLook(BASE_HUE + 60, 'base');
  for (const [name, v] of Object.entries(look.board)) assert.equal(bg[1].plate.el.style.props[name], v, name);
  bg[1].anim.onfinish();                                     // 2 枚目が全面を覆った
  assert.equal(a.plates.filter((p) => p.on).length, 1);
  assert.equal(bg[1].plate.el.style.opacity, '1'); assert.equal(sets[0].style.display, 'none', '最初の青は外れる');
  assert.equal(bg[1].plate.el.style.display, 'block');
  for (let i = 0; i < 14; i++) a.show(ambientLook(i * 25, 'soft'), 300);       // 層が足りなくなっても、一番古い層を使い回して壊れない
  assert.ok(a.plates.every((p) => a.plates.filter((q) => q.z === p.z && q.on).length <= 1));
  stop(a);
});

test('土台の層をつなげていなくても（チュートリアル・テスト）、背景は今までどおり動く。動きを減らす設定でも背景と同じ 1 回の重ね', () => {
  const { a } = make();
  a.go(BASE_HUE + 30, 'base', 500);
  assert.equal(a.layers.filter((l) => l.on).length, 2, '今の色の下敷き + 新しい色'); assert.ok(a.layers.every((l) => !l.plate));
  stop(a);
  const q = makeBoard({ reduced: true });
  q.a.go(BASE_HUE + 160, 'base', 100);
  assert.equal(q.a.plates.filter((p) => p.on).length, 2, '最初の青 + 新しい色の 1 枚');
  assert.ok(q.a.layers.find((l) => l.on && l.plate).plate.anim.opts.duration >= 700);
  stop(q.a);
});

test('土台の層の z-index（色が変わるたびに増える）は #wellLayer の中だけで効く。外へ漏れると、土台がブロック・プレビュー・ヒントより前に出て隠してしまう', () => {
  const rule = css.match(/#wellLayer\{([^}]*)\}/);
  assert.ok(rule, '#wellLayer の規則が要る');
  assert.match(rule[1], /isolation:\s*isolate/, '重ね合わせの文脈を閉じる（以前は filter が閉じていた）');
  const renderer = readFileSync(new URL('../src/ui/renderer.js?v=202610051326', import.meta.url), 'utf8');
  assert.match(renderer, /className = 'well-set';[^}]*this\.wellLayer\.appendChild\(d\)/s, '土台の層は #wellLayer の中に作る');
  const ambient = readFileSync(new URL('../src/ui/ambient.js?v=202610051326', import.meta.url), 'utf8');
  assert.match(ambient, /el\.style\.zIndex = String\(p\.z = z\)/, '層の前後は z-index で決める（だから外へ漏らさない）');
  // 土台の層に z-index を付けても、盤面の中の他の層（ブロック・プレビュー・ヒント）には付かない
  const { a, sets } = makeBoard();
  a.go(BASE_HUE + 30, 'base', 500); a.go(BASE_HUE + 60, 'base', 800);
  assert.ok(sets.some((e) => Number(e.style.zIndex) > 0), '土台の層には z-index が付く');
  stop(a);
});

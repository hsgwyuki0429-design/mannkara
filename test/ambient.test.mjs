import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  Ambient, ambientLook, comboLook, nextCalm, skipOlive, hexToOklch, oklchToHex, contrastWithWhite, wrapHue, hueDelta,
  ORIGIN, BASE_HUE, TONES, MIN_CONTRAST, BOARD, BOARD_VARS, boardLook, PLATE_SETS,
} from '../src/ui/ambient.js?v=202610021128';

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

/* ---------------- 盤面の土台（プレート）も背景と一緒に変わる ---------------- */

const css = readFileSync(new URL('../src/ui/styles.css?v=202610021128', import.meta.url), 'utf8');
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

test('土台の色: どの色相・濃さでも、背景と同じ色相で、背景より暗い板と、もっと暗いくぼみ。暗さの差は今の青と同じ', () => {
  const baseGap = hexToOklch(ambientLook(BASE_HUE, 'base').lo).L - hexToOklch(BOARD.plate).L;
  for (const tone of Object.keys(TONES)) {
    for (let h = 0; h < 360; h += 6) {
      const bg = hexToOklch(ambientLook(h, tone).lo), v = boardLook(h, tone);
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
  const bg = a.layers.filter((l) => l.on), pl = a.plates.filter((p) => p.on);
  assert.equal(bg.length, 2); assert.equal(pl.length, 3, '背景の 2 枚 + 最初の青');
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
  assert.equal(a.layers.filter((l) => l.on).length, 1); assert.equal(a.layers.find((l) => l.on).plate, null);
  stop(a);
  const q = makeBoard({ reduced: true });
  q.a.go(BASE_HUE + 160, 'base', 100);
  assert.equal(q.a.plates.filter((p) => p.on).length, 2, '最初の青 + 新しい色の 1 枚');
  assert.ok(q.a.layers.find((l) => l.on).plate.anim.opts.duration >= 700);
  stop(q.a);
});

test('土台の層の z-index（色が変わるたびに増える）は #wellLayer の中だけで効く。外へ漏れると、土台がブロック・プレビュー・ヒントより前に出て隠してしまう', () => {
  const rule = css.match(/#wellLayer\{([^}]*)\}/);
  assert.ok(rule, '#wellLayer の規則が要る');
  assert.match(rule[1], /isolation:\s*isolate/, '重ね合わせの文脈を閉じる（以前は filter が閉じていた）');
  const renderer = readFileSync(new URL('../src/ui/renderer.js?v=202610021128', import.meta.url), 'utf8');
  assert.match(renderer, /className = 'well-set';[^}]*this\.wellLayer\.appendChild\(d\)/s, '土台の層は #wellLayer の中に作る');
  const ambient = readFileSync(new URL('../src/ui/ambient.js?v=202610021128', import.meta.url), 'utf8');
  assert.match(ambient, /el\.style\.zIndex = String\(p\.z = z\)/, '層の前後は z-index で決める（だから外へ漏らさない）');
  // 土台の層に z-index を付けても、盤面の中の他の層（ブロック・プレビュー・ヒント）には付かない
  const { a, sets } = makeBoard();
  a.go(BASE_HUE + 30, 'base', 500); a.go(BASE_HUE + 60, 'base', 800);
  assert.ok(sets.some((e) => Number(e.style.zIndex) > 0), '土台の層には z-index が付く');
  stop(a);
});

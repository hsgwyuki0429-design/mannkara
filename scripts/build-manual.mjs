// blockmancala の説明書（ホームの「遊び方」で開く、読み物のページ）を作る。図は、ゲームのエンジン（src/core）で実際に盤面を計算して描く。
// 使い方: node scripts/build-manual.mjs  → src/ui/manual-content.js（MANUAL_HTML）を書き出す。ルールを変えたらここの文章を直して、もう一度実行する
// （test/manual.test.mjs が、書き出した内容が今のルールの計算と合っているか確かめる）。見た目の CSS は src/ui/styles.css の .manual
import { writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Board, createBlock, createGarbage } from '../src/core/board.js';
import { resolveLine } from '../src/core/mancala.js';
import { Piece } from '../src/core/pieces.js';
import { SIZE, isInside, lineCells } from '../src/core/constants.js';
import { edgeOrder, chipOrder } from '../src/core/battle.js';

/* ---------- 図の部品（盤面は直角が下の三角形。マス (x, r) は 画面の横 = r - x、高さ = x + r） ---------- */
const COLORS = {
  red: ['#ff8a96', '#e8364a', '#a81e30'], orange: ['#ffc46b', '#ff9a2e', '#c26a10'], yellow: ['#fff08a', '#ffd23f', '#c99a10'],
  green: ['#8af2a8', '#2fcf6a', '#16934a'], cyan: ['#9ef0ff', '#29c8e8', '#1a8aa8'], blue: ['#9db8ff', '#3d6bff', '#2447c4'],
  purple: ['#d2a6ff', '#a65bff', '#7129c4'], garbage: ['#dfe4ef', '#8b94ad', '#555e78'],
};
const defs = () => `<defs>${Object.entries(COLORS).map(([k, [a, b, c]]) =>
  `<linearGradient id="mn-g-${k}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${a}"/><stop offset=".5" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></linearGradient>`).join('')}
  <marker id="mn-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#fff"/></marker>
  <marker id="mn-arrowG" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="#ffd23f"/></marker></defs>`;

function figure({ u = 16, hmax = 8, blocks = [], wells = true, outline = [], arrows = [], goal = null, lanes = false, tags = [], texts = [], ghosts = [], line = null, extraW = 0 }) {
  const W = (2 * 9 + 2 + extraW) * u, H = (hmax + 3.8) * u, ox = W / 2, oy = H - 2.4 * u;
  const P = (sx, h) => [ox + sx * u, oy - h * u];
  const C = (x, r) => P(r - x, x + r);
  const dia = (cx, cy, d, extra = '') => `<polygon points="${cx},${cy - d} ${cx + d},${cy} ${cx},${cy + d} ${cx - d},${cy}" ${extra}/>`;
  let s = `<svg class="fig" viewBox="0 0 ${W} ${H}" role="img" xmlns="http://www.w3.org/2000/svg">`;
  if (wells) for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) { const [cx, cy] = C(x, r); s += dia(cx, cy, u * 0.94, 'fill="#27449f" stroke="#1c3380" stroke-width="1"'); }
  if (lanes) {
    for (let n = 1; n <= SIZE; n++) for (const [sx, k] of [[n, 'col'], [-n, 'row']]) {
      const [cx, cy] = P(sx, 16 - n);
      s += `<circle cx="${cx}" cy="${cy}" r="${u * 0.62}" fill="${k === 'col' ? '#ffffff' : '#ffffff'}" fill-opacity=".16" stroke="#fff" stroke-opacity=".5"/><text x="${cx}" y="${cy + u * 0.27}" text-anchor="middle" font-size="${u * 0.8}" font-weight="800" fill="#fff">${n}</text>`;
    }
  }
  for (const g of ghosts) { const [cx, cy] = C(g.x, g.r); s += dia(cx, cy, u * 0.88, 'fill="none" stroke="#fff" stroke-opacity=".55" stroke-dasharray="3 3" stroke-width="1.3"'); }
  for (const b of blocks) {
    const [cx, cy] = C(b.x, b.r), d = u * 0.9, [hi] = COLORS[b.color] || COLORS.blue;
    s += dia(cx, cy, d, `fill="url(#mn-g-${b.color})" stroke="rgba(255,255,255,.55)" stroke-width="1"`);
    s += dia(cx, cy - d * 0.08, d * 0.55, 'fill="#fff" fill-opacity=".16"');
    s += `<path d="M${cx - d * 0.45} ${cy - d * 0.12} L${cx - d * 0.05} ${cy - d * 0.52}" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/>`;
    if (b.n != null) s += `<text x="${cx}" y="${cy + u * 0.3}" text-anchor="middle" font-size="${u * 0.95}" font-weight="900" fill="#fff" stroke="#3a4260" stroke-width=".6">${b.n}</text>`;
  }
  for (const o of outline) { const [cx, cy] = C(o.x, o.r); s += dia(cx, cy, u * 0.96, `fill="${o.fill || 'none'}" stroke="${o.color || '#ffd23f'}" stroke-width="2.4"`); }
  if (goal) {
    const [gx, gy] = P(goal.sx ?? 0, goal.h);
    s += dia(gx, gy, u * 1.15, 'fill="#14407a" fill-opacity=".6" stroke="#4fe3ee" stroke-width="2.4"');
    s += `<text x="${gx}" y="${gy + u * 0.3}" text-anchor="middle" font-size="${u * 0.72}" font-weight="900" fill="#fff">GOAL</text>`;
  }
  for (const a of arrows) {
    const [x1, y1] = a.from.cell ? C(a.from.x, a.from.r) : P(a.from.sx, a.from.h), [x2, y2] = a.to.cell ? C(a.to.x, a.to.r) : P(a.to.sx, a.to.h);
    const mx = (x1 + x2) / 2 + (a.bend ?? 0), my = (y1 + y2) / 2 - Math.abs(a.bend ?? 0) * 0.6;
    const col = a.color || '#fff';
    s += `<path d="M${x1} ${y1} Q${mx} ${my} ${x2} ${y2}" fill="none" stroke="${col}" stroke-width="2.2" ${a.dash ? 'stroke-dasharray="5 4"' : ''} marker-end="url(#${col === '#ffd23f' ? 'mn-arrowG' : 'mn-arrow'})" opacity=".95"/>`;
  }
  for (const t of tags) {
    let [cx, cy] = t.cell ? C(t.x, t.r) : P(t.sx, t.h);
    if (t.small) {                                  // 数字つきのブロックの右上に、順番の小さなバッジ
      const side = t.cell ? Math.sign((t.r - t.x)) : 0;          // 左の辺は左下、右の辺は右下、角は真下（となりのブロックの数字にかぶらない外側）
      cx += u * (side === 0 ? 0 : side * 1.0); cy += u * (side === 0 ? 1.25 : 0.7);
      s += `<circle cx="${cx}" cy="${cy}" r="${u * 0.5}" fill="#ffd23f" stroke="#7a5200" stroke-width="1"/><text x="${cx}" y="${cy + u * 0.23}" text-anchor="middle" font-size="${u * 0.62}" font-weight="900" fill="#3a2600">${t.label}</text>`;
      continue;
    }
    cx += (t.osx || 0) * u; cy -= (t.oh || 0) * u; s += `<circle cx="${cx}" cy="${cy}" r="${u * 0.62}" fill="${t.color || '#fff'}"/><text x="${cx}" y="${cy + u * 0.27}" text-anchor="middle" font-size="${u * 0.8}" font-weight="900" fill="${t.color ? '#fff' : '#1e3a8a'}">${t.label}</text>`; }
  for (const t of texts) { const [cx, cy] = P(t.sx, t.h); s += `<text x="${cx}" y="${cy}" text-anchor="${t.anchor || 'middle'}" font-size="${u * (t.size || 0.78)}" font-weight="800" fill="${t.color || '#fff'}">${t.text}</text>`; }
  return s + '</svg>';
}
const cellsOf = (kind, n) => lineCells(kind, n).map(({ x, r }) => ({ x, r, cell: true }));
const entries = (board) => [...board.entries()].map(({ block, x, r }) => ({ id: block.id, x, r, color: block.color === 'debug' ? 'blue' : block.color, n: block.garbage }));

/* ---------- 図1: 盤面の見かた ---------- */
const col4 = lineCells('col', 4).map(({ x, r }) => ({ x, r }));
const fig1 = figure({
  u: 16, hmax: 17.2, lanes: true, goal: { h: 16 },
  outline: col4,
  texts: [
    { sx: 0, h: 17.9, text: 'ゴール', size: 0.8 },
    { sx: 0, h: -0.1, text: '直角（角）', size: 0.74, color: '#ffe9a0' },
    { sx: -4.2, h: 8.9, text: '斜辺（上の辺）', size: 0.74, color: '#ffe9a0' },
    { sx: 6.9, h: 11.4, text: '縦4の番号', size: 0.66, anchor: 'start', color: '#ffe9a0' },
  ],
  arrows: [{ from: { cell: true, x: 4, r: 3 }, to: { sx: 3.55, h: 11.55 }, color: '#ffd23f', dash: true, bend: 0 }],
});

/* ---------- 図2: 発動の流れ（チュートリアルの 2 手目と同じ盤面を、実際のエンジンで進める） ---------- */
const bd = new Board();
for (const [x, r] of [[1, 1], [2, 1], [1, 2], [2, 2]]) bd.set(x, r, createBlock('blue'));
bd.set(5, 0, createBlock('red'));
const before = entries(bd);
const piece = new Piece('I21');
bd.place(piece, 5, 1);
const afterPlace = entries(bd);
const placedCells = afterPlace.filter((b) => !before.some((o) => o.id === b.id));
const fullLine = bd.fullLines()[0];
const step1 = (() => { const s = resolveLine(bd, fullLine.kind, fullLine.n); return s; })();
const afterFire1 = entries(bd);
const pos = (list, id) => list.find((b) => b.id === id);
const arrows1 = step1.moves.map((m) => {
  const a = pos(afterPlace, m.block.id), b = pos(afterFire1, m.block.id);
  return m.to === 'goal'
    ? { from: { cell: true, x: a.x, r: a.r }, to: { sx: 0, h: 9.4 }, color: '#ffd23f', bend: 20 }
    : { from: { cell: true, x: a.x, r: a.r }, to: { cell: true, x: b.x, r: b.r }, bend: m.to === 2 ? -14 : -26 };
});
const full2 = bd.fullLines()[0];
const step2 = resolveLine(bd, full2.kind, full2.n);
const afterFire2 = entries(bd);
const arrows2 = step2.moves.map((m) => {
  const a = pos(afterFire1, m.block.id);
  return { from: { cell: true, x: a.x, r: a.r }, to: { sx: 0, h: 9.4 }, color: '#ffd23f', bend: 30 };
});
const fig2a = figure({ u: 17, hmax: 8, blocks: afterPlace, outline: cellsOf('col', fullLine.n).map(({ x, r }) => ({ x, r })), texts: [{ sx: -3.4, h: 8.9, text: `縦${fullLine.n}が満杯！`, size: 0.8, color: '#ffe9a0' }] });
const dest = (n) => { const m = step1.moves.find((x) => x.to === n); return pos(afterFire1, m.block.id); };
const lblAt = (b, text, dh = 0) => ({ sx: (b.r - b.x) - 1.3, h: b.x + b.r + dh, text, size: 0.7, color: '#ffe9a0', anchor: 'end' });
const fig2b = figure({ u: 17, hmax: 11, goal: { h: 10.4, sx: 0 }, blocks: afterFire1, ghosts: step1.stack.map((b) => pos(afterPlace, b.id)), arrows: arrows1,
  texts: [lblAt(dest(2), '縦2へ', -0.3), lblAt(dest(1), '縦1へ', -0.3), { sx: 1.9, h: 10.3, text: 'ゴールへ', size: 0.7, color: '#ffe9a0', anchor: 'start' }] });
const fig2c = figure({ u: 17, hmax: 11, goal: { h: 10.4, sx: 0 }, blocks: afterFire2, ghosts: step2.stack.map((b) => pos(afterFire1, b.id)), arrows: arrows2,
  texts: [{ sx: 1.9, h: 10.3, text: 'ゴールへ', size: 0.7, color: '#ffe9a0', anchor: 'start' }] });

/* ---------- 図3: おじゃまが置かれる順番・削られる順番（対戦） ---------- */
const nOrder = (list, n) => list.slice(0, n).map(({ x, r }, i) => ({ x, r, cell: true, label: String(i + 1) }));
const gcells = [[0, 0], [1, 0], [0, 1], [2, 0], [0, 2], [3, 0], [0, 3]];
const gBlocks = (vals) => gcells.map(([x, r], i) => ({ x, r, color: 'garbage', n: vals[i] }));
const fig3a = figure({ u: 17, hmax: 8, blocks: [], tags: nOrder(edgeOrder(), 7), texts: [{ sx: 0, h: -1.0, text: '角から外へ', size: 0.75, color: '#ffe9a0' }] });
const chipList = chipOrder().filter((c) => gcells.some(([x, r]) => x === c.x && r === c.r));
const fig3b = figure({ u: 17, hmax: 8, blocks: gBlocks([5, 4, 4, 3, 3, 2, 2]), tags: chipList.map(({ x, r }, i) => ({ x, r, cell: true, small: true, label: String(i + 1) })), texts: [{ sx: 0, h: 8.2, text: '外側の端から', size: 0.75, color: '#ffe9a0' }] });
// 図3c: 5 連鎖で −5 が外側の 1 個に当たる様子
const fig3c = figure({ u: 17, hmax: 8, blocks: gBlocks([5, 4, 4, 3, 3, 7, 2]),
  outline: [{ x: 3, r: 0, color: '#ff8a8a' }],
  tags: [{ x: 3, r: 0, cell: true, osx: -1.9, oh: 1.1, label: '−5', color: '#e8364a' }],
  texts: [{ sx: 0, h: 8.2, text: '5連鎖 → 外側の1個が 7 → 2', size: 0.75, color: '#ffe9a0' }] });

/* ---------- ページ ---------- */
const toc = [
  ['purpose', 'ゲームの目的'], ['board', '盤面の見かた'], ['pieces', 'ピースを置く'], ['fire', 'ラインが満杯になると'],
  ['chain', '連鎖とコンボ'], ['score', 'スコア'], ['bonus', 'ボーナス'], ['home', 'ホームと記録'], ['battle', '対戦'], ['tips', 'コツ'],
];
const tocHtml = `<nav class="toc"><b>もくじ</b><ol>${toc.map(([id, t], i) => `<li><a href="#mn-${id}" data-go="mn-${id}"><span>${i + 1}</span>${t}</a></li>`).join('')}</ol></nav>`;
const sec = (id, i, title, body) => `<section id="mn-${id}"><h2><span class="no">${i}</span>${title}</h2>${body}<div class="top"><a href="#mn-top" data-go="mn-top">↑ もくじへ</a></div></section>`;

const body = `
<svg class="mn-defs" width="0" height="0" style="position:absolute" aria-hidden="true">${defs()}</svg>
<header class="hero" id="mn-top">
  <div class="logo"><svg viewBox="0 0 32 32" aria-hidden="true"><rect x=".5" y=".5" width="31" height="31" rx="7" fill="#2b4bbf" stroke="#96c0ff"/><path d="M6 6h20v4H22v4h-4v4h-4v4h-4v4H6z" fill="#ffd23f"/></svg><div class="mn-title">blockmancala</div></div>
  <p class="sub">せつめいしょ</p>
</header>
<p class="lead">三角の盤面に、ピースを置いて、ラインを<b class="gold">満杯</b>にしよう。満杯になるとブロックが流れて、次々に満杯になる<b class="gold">連鎖</b>が起きる。連鎖するほど高得点。置ける場所がなくなったら おしまい。</p>
${tocHtml}

${sec('purpose', 1, 'ゲームの目的', `
<ul>
  <li>下に並んだ <b>3つのピース</b>を、指でつかんで盤面の空きマスへ置きます。</li>
  <li>ラインが満杯になると<b>発動</b>して、ブロックが流れます。それが次のラインを満杯にすると<b>連鎖</b>。</li>
  <li>連鎖やゴールに入れたブロックの数で<b>スコア</b>が決まります。ベストスコアやランキングをめざしましょう。</li>
  <li>置けるピースがなくなったら<b>ゲームオーバー</b>です。</li>
</ul>
<div class="note">ピースは回せません。置いたブロックは重力で落ちず、置いた場所にそのまま残ります。</div>
<p>動かしながら覚えたいときは、上の<b class="gold">「れんしゅうする」</b>を押してください。手順つきで、数手だけ練習できます。</p>`)}

${sec('board', 2, '盤面の見かた', `
<p>盤面は、8×8のマスを斜めに切った<b>三角形（36マス）</b>です。<b>直角が下</b>、<b>斜めの辺（斜辺）が上</b>にあります。</p>
<figure>${fig1}<figcaption>金色の枠は「縦4」のライン。ラインは盤面の足（直角をはさむ2つの辺）から斜辺へ向かって伸びる1列で、その先に番号が書いてあります。<b>右側の番号が縦のライン、左側の番号が横のライン</b>です。</figcaption></figure>
<dl>
  <dt>ライン</dt><dd>斜辺に向かってまっすぐ並んだマスの列。右上へ伸びる<b>縦のライン</b>が8本、左上へ伸びる<b>横のライン</b>が8本、合わせて16本あります。</dd>
  <dt>ラインの番号</dt><dd>1〜8。<b>その番号がそのラインのマスの数</b>です（縦4なら4マス）。ゴールに近い番号ほど短いラインです。</dd>
  <dt>ゴール（GOAL）</dt><dd>盤面の上にあるゴール。ラインから流れたブロックが入ると、スコアになります。</dd>
</dl>`)}

${sec('pieces', 3, 'ピースを置く', `
<ul>
  <li>トレイ（下）に<b>3つ</b>のピース。<b>指でつかんで</b>、盤面の空きマスに置きます。置ける場所に近づけると、置いたときの結果が薄く見えます。</li>
  <li>3つとも置くと、次の3つが補充されます。</li>
  <li>ピースは<b>約46種類</b>：テトロミノ7種、1マス・直線（2・3・5マス）・3×3・2×3・L字、さらに三角の盤面用の<b>斜め点線</b>・<b>逆斜め</b>・<b>階段ヘビ</b>・<b>十字</b>など。</li>
  <li>どのピースも<b>どれか1つは置ける</b>ように配られますが、3つとも置ける置き方を見つけるのがコツです。</li>
  <li>置けるピースが1つもなくなったら、ゲームオーバー。</li>
</ul>
<div class="note">補充のたびに、「置くとラインが発動する形」や「穴にぴったりはまる形」が選ばれやすくなっています。</div>`)}

${sec('fire', 4, 'ラインが満杯になると（発動）', `
<p>ラインのマスがぜんぶ埋まると<b>満杯</b>。すぐに<b>発動</b>して、ブロックが次のように流れます。</p>
<ol class="steps">
  <li>そのラインのブロックを、ぜんぶ取り出す。</li>
  <li><b>いちばん斜辺側の1個</b>は、<b class="gold">ゴール</b>へ入る（スコア）。</li>
  <li>残りのブロックは、<b>奥のものから順に</b>、番号が1つ小さいライン・2つ小さいライン…と<b>1個ずつ</b>配られる。</li>
  <li>配られたブロックは、そのラインの斜辺側の入口から入り、<b>ブロックか壁にぶつかる手前まで奥へ進んで</b>止まる。</li>
</ol>
<div class="figs">
  <figure><span class="step-label">① 置く</span>${fig2a}<figcaption>緑の縦2マスを置くと、縦3のラインが3マス埋まって<b>満杯</b>になります。</figcaption></figure>
  <figure><span class="step-label">② 発動</span>${fig2b}<figcaption>破線の3個が取り出されます。いちばん斜辺側の緑は<b>ゴール</b>へ。奥の赤は<b>縦2</b>へ、もう1つの緑は<b>縦1</b>へ、1個ずつ配られます。</figcaption></figure>
  <figure><span class="step-label">③ 連鎖</span>${fig2c}<figcaption>縦1のラインがちょうど1マスで満杯になったので、<b>もう一度発動</b>。これが<b>2連鎖</b>です。</figcaption></figure>
</div>
<h3>入口がふさがっているとき</h3>
<p>配られた先のラインの入口（斜辺側の端）にブロックがあるときは、中のブロックを<b>奥へ1マス押して</b>入ります。配られた先が満杯のときは、そのブロックは<b>ゴールへ</b>流れます。</p>
<h3>満杯が同時に複数あるとき</h3>
<p>番号の小さいラインから順に発動します。縦と横の両方が満杯のときは、置けなくなりにくい向きが自動で選ばれます。</p>`)}

${sec('chain', 5, '連鎖とコンボ', `
<div class="cols">
  <div class="card"><h4>連鎖</h4><p>1回の手で、発動が<b>続けて</b>起きること。流れたブロックが次のラインを満杯にすると、どんどん続きます。<b>連鎖の数が多いほど、点数が大きく伸びます。</b></p></div>
  <div class="card"><h4>コンボ（COMBO）</h4><p>何かが発動する手を<b>続けて</b>置くこと。1手ごとに<b>COMBO 1・2・3…</b>と数えます。発動しない手を置くと途切れます。</p></div>
</div>
<div class="note">連鎖のコツは、<b>小さい番号のラインを「あと1個」</b>にそろえておくこと。そこへブロックが流れ込むと、次々に満杯になります。</div>`)}

${sec('score', 6, 'スコア', `
<table>
  <tr><th>もとの点</th><th>内容</th></tr>
  <tr><td>置いたマス</td><td>1マスにつき <b>1点</b></td></tr>
  <tr><td>ゴールに入ったブロック</td><td>1個につき <b>100点</b>（下の倍率を掛ける）</td></tr>
</table>
<h3>連鎖の倍率</h3>
<div class="chips">${[[1, 1], [2, 2], [3, 4], [4, 6], [5, 10], [6, 14], [7, 19], [8, 24], [9, 30], [10, 36], [11, 48], [12, 60]].map(([n, m]) => `<span><i>${n}連鎖</i>×${m}</span>`).join('')}</div>
<p>12連鎖より先も、1連鎖ごとに<b>＋12</b>ずつ増え続けます（上限なし）。</p>
<h3>コンボの倍率</h3>
<p>COMBOが1つ増えるごとに<b>×1.1</b>を掛けていきます（上限なし）。</p>
<div class="chips">${[[1, '1'], [2, '1.1'], [3, '1.21'], [5, '1.46'], [10, '2.36'], [12, '2.85']].map(([n, m]) => `<span><i>COMBO ${n}</i>×${m}</span>`).join('')}</div>
<div class="note">例：COMBO 1の手で、3連鎖目にゴールへ2個入ったら <b>2個 × 100点 × 4倍 ＝ 800点</b>。</div>`)}

${sec('bonus', 7, 'ボーナス', `
<dl>
  <dt>ぴったり（PERFECT FIT）</dt><dd>まわりのブロックに囲まれた<b>穴をちょうど埋める</b>ように置くと、置いたマス1つにつき <b>+25点</b>。</dd>
  <dt>長方形（NICE FIT）</dt><dd>置いて、すきまのない<b>長方形</b>（縦横2マス以上・6マス以上）ができると、長方形のマス1つにつき <b>+10点</b>。</dd>
  <dt>全消し（ALL CLEAR）</dt><dd>連鎖で盤面のブロックが<b>ぜんぶ消える</b>と、<b>+5,000点</b>。さらにそのあと<b>5手のあいだ</b>、手に入る点数がすべて<b>×1.5</b>になります（もう一度全消しすると手数が戻ります）。</dd>
</dl>`)}

${sec('home', 8, 'ホームと記録', `
<h3>ホーム画面</h3>
<table>
  <tr><td><b>ひとりで あそぶ</b></td><td>ひとりで遊びます。途中で閉じても、<b>つづきから</b>遊べます。</td></tr>
  <tr><td><b>対戦</b></td><td>CPUやオンラインの相手と対戦します（次の「対戦」を見てください）。</td></tr>
  <tr><td><b>ランキング</b></td><td>世界ランキングと、この端末のランキング。</td></tr>
  <tr><td><b>デザイン</b></td><td>盤面の見た目（宝石・ガラス・白・3Dなど）を選びます。</td></tr>
  <tr><td><b>遊び方</b></td><td>この説明書です。</td></tr>
  <tr><td><b>サウンド</b></td><td>音のオン・オフ。</td></tr>
</table>
<p>プレー中は、左上の<b>ホーム</b>ボタンでいつでもホームへ戻れます。右上には、ランキング・サウンド・一時停止があります。上の<b>QR</b>を押すと、このゲームのQRコードが出て、友だちに教えられます。</p>
<h3>記録とランキング</h3>
<ul>
  <li>ベストスコア・<b>最大連鎖</b>・<b>最大コンボ</b>が端末に残ります。</li>
  <li>ランキングは<b>シーズン制</b>（いまはシーズン2）。<b>ベスト</b>（自己ベスト）・<b>累計</b>（遊んだゲームの合計）・<b>レート</b>（レート戦）を見られます。「シーズン1の結果を見る」で前のシーズンも見られます。</li>
  <li>世界ランキングに出るには、最初に<b>なまえ</b>を決めます（あとから変えられます）。</li>
</ul>`)}

${sec('battle', 9, '対戦', `
<p>連鎖でおじゃまを送り合い、<b>先に置けなくなったほうが負け</b>です。</p>
<h3>対戦の相手</h3>
<ul>
  <li><b>CPU</b>：よわい・ふつう・つよい。</li>
  <li><b>レート戦</b>：オンライン。レート<b>1000</b>から。勝つと増え、負けると同じだけ減ります（2人の増減を足すと0）。<b>途中でやめると負け</b>です。</li>
  <li><b>だれかと対戦</b>：オンラインでフリー対戦。<b>あいことば</b>：4けたの数字で友だちと対戦。</li>
</ul>
<h3>対戦のきまり</h3>
<ul>
  <li>手駒は、自分と相手に<b>同じ順番</b>で出ます。使った枠には<b>すぐ次のピース</b>が入ります。</li>
  <li><b>連鎖が再生されている間は、次のピースを持てません</b>。連鎖はいつも同じ速さで流れます。</li>
  <li>対戦では、スコアの数字は出ません。</li>
</ul>
<h3>おじゃまを送る</h3>
<ul>
  <li><b>1連鎖</b>から送れます。おじゃまに書く数字は<b>連鎖の数</b>（1連鎖なら「1」、5連鎖なら「5」）。</li>
  <li><b>全消し</b>をすると、数字に<b>＋5</b>。</li>
  <li>長引くと（<b>1分30秒</b>から）、1回に送る<b>個数</b>が増えます：1分30秒で<b>2個</b>、そこから20秒ごとに1個ずつ増えて、最大<b>5個</b>。増えた瞬間は画面にも出ます。</li>
</ul>
<h3>おじゃまが届くとき</h3>
<ul>
  <li>相手の連鎖が終わったら<b>すぐ</b>、自分の盤面に置かれます。自分が連鎖している最中なら、その連鎖が終わってすぐ。</li>
  <li>置かれる前に、<b>赤い光</b>と警告音。置かれる予定のマスに<b>赤い枠</b>が出ます（そこへはもう置けません）。<b>演出中も、ほかの場所には置けます</b>。</li>
  <li>おじゃまは、盤面の<b>いちばん外側の辺</b>（直角をはさむ2つの辺）の空きマスに、<b>角から外へ</b>向かって置かれます。<b>上にブロックがあっても関係なく</b>置かれます。</li>
  <li>外側の辺が、おじゃまとブロックでぜんぶ埋まったら、<b>次の辺</b>に置かれます。</li>
  <li>おじゃまは<b>動かず、その上には置けません</b>。おじゃまが入っているラインは<b>満杯にならず、発動しません</b>。</li>
</ul>
<figure>${fig3a}<figcaption>おじゃまが置かれる順番。角が①で、左右の辺へ交互に、外へ向かって並びます。</figcaption></figure>
<h3>おじゃまを消す</h3>
<ul>
  <li>自分が連鎖すると、<b>連鎖の数ぶんの合計</b>が、<b>外側のおじゃま1個</b>に当たります。<b>5連鎖なら合計−5</b>。1段ごとに−1ずつ当たり、画面には「−1、−2、−3…」と出ます。</li>
  <li>先に削られるのは<b>外側のおじゃま</b>。いちばん外側の辺の中でも、<b>角から遠い端</b>のものから。</li>
  <li>数字が0になると、おじゃまは消えます。連鎖の数がまだ残っていたら、次のおじゃま（より内側）に当たります。</li>
  <li>おじゃまを削っても、<b>相手に送るおじゃまは減りません</b>（送ることと削ることは、両方起きます）。</li>
</ul>
<div class="figs">
  <figure>${fig3b}<figcaption>削られる順番。いちばん外側の辺の端（角から遠いほう）から、角へ向かって削られます。</figcaption></figure>
  <figure>${fig3c}<figcaption>5連鎖すると、外側の端の1個（ここでは7）に合計−5が当たって「2」になります。</figcaption></figure>
</div>`)}

${sec('tips', 10, 'コツ', `
<ul>
  <li><b>小さい番号のラインを「あと1個」にそろえて</b>から、大きいラインを満杯にすると、連鎖が長く続きます。</li>
  <li>ブロックをばらまかず、<b>空きマスをまとまった形で残す</b>と、大きなピースも置けます。</li>
  <li>3つのピースを見たら、<b>3つとも置ける置き方</b>を先に考える。1つ置くたびに、残りが置けなくなっていないか確かめましょう。</li>
  <li>穴にぴったり入るピースは、ボーナスを狙えるチャンスです。</li>
  <li>連鎖が終わるまでは次のピースを持てない対戦では、<b>小さな連鎖でも送れる</b>ことを活かして、こまめに攻めましょう。</li>
  <li>盤面のおじゃまは、<b>外側の端から</b>削られます。連鎖の数が多いほど、いっぺんに減らせます。</li>
</ul>`)}

`;

export const MANUAL_HTML = body.trim();

/** src/ui/manual-content.js の中身（そのまま書き出す文字列） */
export const manualModule = () => `// 自動生成（scripts/build-manual.mjs）。直接は書き換えない。ホームの「遊び方」で開く説明書の中身（HTML）
export const MANUAL_HTML = ${JSON.stringify(MANUAL_HTML)};
`;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const out = fileURLToPath(new URL('../src/ui/manual-content.js', import.meta.url));
  writeFileSync(out, manualModule());
  console.log('wrote', out, MANUAL_HTML.length);
}

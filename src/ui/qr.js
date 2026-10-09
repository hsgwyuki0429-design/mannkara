/**
 * QR コード（JIS X 0510 / ISO 18004）を作る小さな実装。外のライブラリは使わない（DOM 非依存。描くのは drawQr）。
 * バイトモードだけ・型番 1〜10・誤り訂正 L / M / Q / H・マスクは失点が一番少ないもの（mask で決め打ちもできる）。
 * makeQr(text, { ecl, minVersion, mask }) → { size, version, mask, modules: boolean[][]（[行][列]。true = 黒） }
 * テストで Python の qrcode と同じ行列になることを確かめている（test/qr.test.mjs）
 */
const ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
/**
 * 型番ごと・誤り訂正ごとの [1 ブロックの誤り訂正の語数, [ブロック数, 1 ブロックのデータの語数], …]
 */
const BLOCKS = {
  1: { L: [7, [1, 19]], M: [10, [1, 16]], Q: [13, [1, 13]], H: [17, [1, 9]] },
  2: { L: [10, [1, 34]], M: [16, [1, 28]], Q: [22, [1, 22]], H: [28, [1, 16]] },
  3: { L: [15, [1, 55]], M: [26, [1, 44]], Q: [18, [2, 17]], H: [22, [2, 13]] },
  4: { L: [20, [1, 80]], M: [18, [2, 32]], Q: [26, [2, 24]], H: [16, [4, 9]] },
  5: { L: [26, [1, 108]], M: [24, [2, 43]], Q: [18, [2, 15], [2, 16]], H: [22, [2, 11], [2, 12]] },
  6: { L: [18, [2, 68]], M: [16, [4, 27]], Q: [24, [4, 19]], H: [28, [4, 15]] },
  7: { L: [20, [2, 78]], M: [18, [4, 31]], Q: [18, [2, 14], [4, 15]], H: [26, [4, 13], [1, 14]] },
  8: { L: [24, [2, 97]], M: [22, [2, 38], [2, 39]], Q: [22, [4, 18], [2, 19]], H: [26, [4, 14], [2, 15]] },
  9: { L: [30, [2, 116]], M: [22, [3, 36], [2, 37]], Q: [20, [4, 16], [4, 17]], H: [24, [4, 12], [4, 13]] },
  10: { L: [18, [2, 68], [2, 69]], M: [26, [4, 43], [1, 44]], Q: [24, [6, 19], [2, 20]], H: [28, [6, 15], [2, 16]] },
};
const ALIGN = { 1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30], 6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50] };
const REMAINDER = { 1: 0, 2: 7, 3: 7, 4: 7, 5: 7, 6: 7, 7: 0, 8: 0, 9: 0, 10: 0 };

/* ---------- GF(256) と Reed-Solomon ---------- */
const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
{
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
const mul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);
function rsGenerator(n) {
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    for (let j = 0; j < g.length; j++) { next[j] ^= g[j]; next[j + 1] ^= mul(g[j], EXP[i]); }
    g = next;
  }
  return g;
}
function rsRemainder(data, n) {
  const g = rsGenerator(n), r = new Array(n).fill(0);
  for (const b of data) {
    const f = b ^ r.shift();
    r.push(0);
    for (let i = 0; i < n; i++) r[i] ^= mul(g[i + 1], f);
  }
  return r;
}

/* ---------- データ ---------- */
const utf8 = (text) => [...new TextEncoder().encode(text)];
function dataCapacity(version, ecl) {
  const [, ...groups] = BLOCKS[version][ecl];
  return groups.reduce((a, [n, k]) => a + n * k, 0);
}
function encodeData(bytes, version, ecl) {
  const cap = dataCapacity(version, ecl), bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(0b0100, 4);
  put(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) put(b, 8);
  put(0, Math.min(4, cap * 8 - bits.length));
  while (bits.length % 8) bits.push(0);
  const out = [];
  for (let i = 0; i < bits.length; i += 8) out.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));
  for (let pad = 0xec; out.length < cap; pad ^= 0xec ^ 0x11) out.push(pad);
  return out;
}
/** ブロックに分けて誤り訂正を付け、交互に並べる */
function interleave(data, version, ecl) {
  const [ecLen, ...groups] = BLOCKS[version][ecl], blocks = [];
  let at = 0;
  for (const [n, k] of groups) for (let i = 0; i < n; i++) { const d = data.slice(at, at + k); at += k; blocks.push({ d, e: rsRemainder(d, ecLen) }); }
  const out = [], maxD = Math.max(...blocks.map((b) => b.d.length));
  for (let i = 0; i < maxD; i++) for (const b of blocks) if (i < b.d.length) out.push(b.d[i]);
  for (let i = 0; i < ecLen; i++) for (const b of blocks) out.push(b.e[i]);
  return out;
}

/* ---------- 行列 ---------- */
function baseMatrix(version) {
  const size = version * 4 + 17;
  const m = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const set = (x, y, v) => { m[y][x] = v; fn[y][x] = true; };
  // 位置検出パターン（と分離帯）
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy;
      if (x < 0 || y < 0 || x >= size || y >= size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      set(x, y, d !== 2 && d !== 4);
    }
  }
  // タイミングパターン
  for (let i = 8; i < size - 8; i++) { set(6, i, i % 2 === 0); set(i, 6, i % 2 === 0); }
  // 位置合わせパターン
  const al = ALIGN[version];
  for (const cy of al) for (const cx of al) {
    if ((cx === 6 && cy === 6) || (cx === 6 && cy === al.at(-1)) || (cx === al.at(-1) && cy === 6)) continue;
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
  }
  // 形式情報・型番情報の場所を取っておく（中身はあとで）
  for (let i = 0; i < 9; i++) { if (!fn[8][i]) set(i, 8, false); if (!fn[i][8]) set(8, i, false); }
  for (let i = 0; i < 8; i++) { set(size - 1 - i, 8, false); set(8, size - 1 - i, false); }
  set(8, size - 8, true);                                  // いつも黒のモジュール
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const v = ((bits >>> i) & 1) === 1, a = size - 11 + (i % 3), b = Math.floor(i / 3);
      set(a, b, v); set(b, a, v);
    }
  }
  return { size, m, fn };
}
function placeData(mat, codewords, version) {
  const { size, m, fn } = mat;
  const bits = codewords.length * 8 + REMAINDER[version];
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, up = ((right + 1) & 2) === 0, y = up ? size - 1 - vert : vert;
      if (fn[y][x]) continue;
      m[y][x] = i < codewords.length * 8 ? ((codewords[i >>> 3] >>> (7 - (i & 7))) & 1) === 1 : false;
      if (i < bits) i++;
    }
  }
}
const MASKS = [
  (x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
];
function withMask(mat, mask, ecl) {
  const { size, fn } = mat, m = mat.m.map((row) => row.slice());
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[mask](x, y)) m[y][x] = !m[y][x];
  // 形式情報（誤り訂正のレベルとマスク。BCH(15,5)）
  const data = (ECL_BITS[ecl] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412, bit = (i) => ((bits >>> i) & 1) === 1;
  for (let i = 0; i <= 5; i++) m[i][8] = bit(i);
  m[7][8] = bit(6); m[8][8] = bit(7); m[8][7] = bit(8);
  for (let i = 9; i < 15; i++) m[8][14 - i] = bit(i);
  for (let i = 0; i < 8; i++) m[8][size - 1 - i] = bit(i);
  for (let i = 8; i < 15; i++) m[size - 15 + i][8] = bit(i);
  m[size - 8][8] = true;
  return m;
}
/** 失点（読み取りにくさ）: 同じ色の並び・2×2 のかたまり・位置検出パターンに似た並び・黒白の割合 */
function penalty(m) {
  const size = m.length;
  let p = 0;
  const lines = [];
  for (let i = 0; i < size; i++) { lines.push(m[i]); lines.push(m.map((row) => row[i])); }
  for (const line of lines) {
    let run = 1;
    for (let i = 1; i <= size; i++) {
      if (i < size && line[i] === line[i - 1]) run++;
      else { if (run >= 5) p += run - 2; run = 1; }
    }
    const s = line.map((v) => (v ? 1 : 0)).join('');
    for (const pat of ['10111010000', '00001011101']) for (let k = s.indexOf(pat); k >= 0; k = s.indexOf(pat, k + 1)) p += 40;
  }
  for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) {
    const v = m[y][x];
    if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) p += 3;
  }
  const dark = m.reduce((a, row) => a + row.filter(Boolean).length, 0);
  p += Math.floor(Math.abs(dark * 20 - size * size * 10) / (size * size)) * 10;
  return p;
}

export function makeQr(text, { ecl = 'M', minVersion = 1, mask = null } = {}) {
  const bytes = utf8(text);
  let version = Math.max(1, minVersion);
  while (version <= 10 && dataCapacity(version, ecl) * 8 < 4 + (version < 10 ? 8 : 16) + bytes.length * 8) version++;
  if (version > 10) throw new Error('QR: text is too long');
  const mat = baseMatrix(version);
  placeData(mat, interleave(encodeData(bytes, version, ecl), version, ecl), version);
  let best = null;
  for (let k = 0; k < 8; k++) {
    if (mask != null && k !== mask) continue;
    const m = withMask(mat, k, ecl), score = mask != null ? 0 : penalty(m);
    if (!best || score < best.score) best = { m, k, score };
  }
  return { size: mat.size, version, mask: best.k, modules: best.m, functional: mat.fn };
}

/**
 * QR を canvas に描く（インスタグラムのプロフィールの QR のような見た目: 角の丸いモジュール・角の丸い位置検出パターン・
 * 色のグラデーション・まん中にロゴ）。ctx の (x, y) から一辺 px の正方形に、まわりの余白（quiet）つきで描く。
 * colors = [左上の色, 右下の色]、logo(ctx, cx, cy, size) でまん中にロゴを描く（そのぶんのモジュールは描かない）
 */
export function drawQr(ctx, qr, x, y, px, { colors = ['#2b4bbf', '#a849fe'], quiet = 0, logo = null, logoCells = 0 } = {}) {
  const n = qr.size, cell = px / (n + quiet * 2), ox = x + quiet * cell, oy = y + quiet * cell;
  const grad = ctx.createLinearGradient(ox, oy, ox + n * cell, oy + n * cell);
  grad.addColorStop(0, colors[0]); grad.addColorStop(1, colors[1]);
  ctx.save();
  ctx.fillStyle = grad;
  const finder = (r, c) => (r < 7 && c < 7) || (r < 7 && c >= n - 7) || (r >= n - 7 && c < 7);
  const hole = logoCells ? (r, c) => Math.abs(r - (n - 1) / 2) <= logoCells / 2 && Math.abs(c - (n - 1) / 2) <= logoCells / 2 : () => false;
  const rr = (cx, cy, w, h, rad) => { ctx.beginPath(); ctx.roundRect(cx, cy, w, h, rad); ctx.fill(); };
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules[r][c] || finder(r, c) || hole(r, c)) continue;
    const g = cell * 0.04;
    rr(ox + c * cell + g, oy + r * cell + g, cell - g * 2, cell - g * 2, cell * 0.28);
  }
  // 位置検出パターン: 角の丸い枠 + 角の丸い中の四角
  for (const [r, c] of [[0, 0], [0, n - 7], [n - 7, 0]]) {
    const fx = ox + c * cell, fy = oy + r * cell;
    ctx.beginPath();
    ctx.roundRect(fx, fy, cell * 7, cell * 7, cell * 1.6);
    ctx.roundRect(fx + cell, fy + cell, cell * 5, cell * 5, cell * 0.9);
    ctx.fill('evenodd');
    rr(fx + cell * 2, fy + cell * 2, cell * 3, cell * 3, cell * 0.8);
  }
  ctx.restore();
  if (logo && logoCells) logo(ctx, ox + (n / 2) * cell, oy + (n / 2) * cell, cell * (logoCells - 1));
}

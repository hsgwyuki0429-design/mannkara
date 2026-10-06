/**
 * 3D の盤面（cube3d.js）の座標と動きの計算。DOM も WebGL も使わない純粋な計算（test/cube3d.test.mjs で確かめる）。
 *
 * 3D の空間（B 空間）: 単位は CSS px、原点は盤面の中心（2D の playfield の中心 = 斜辺の中心線）、x 右・y 上・z 手前。
 * 2D の盤面は 225° 回して縦にだけ 1.04 倍しているので、B 空間は「縦に伸ばす前」の、ゆがみの無い空間にする
 * （ガラスの屈折は角度で決まるので、ゆがんだ空間では計算できない）。画面に写すときに縦 1.04 倍を掛ける。
 *
 * カメラは「下から見上げる」: 目は盤面の中心のずっと下（画面の下の端あたり）・手前にあり、視線は盤面に垂直のまま
 * （建築写真のシフトレンズと同じ）。こうすると盤面に平行な面はゆがまず、手前に飛び出した立方体だけが遠近で
 * 下の面を見せる（上の方の立方体ほど、下の面が大きく見える）。
 * 立方体の高さのまん中（z = zRef）の面が、2D の盤面とまったく同じ位置・大きさに写るようにしてあるので、
 * DOM で重ねている表示（ラインの光・星・ゴール・番号・学習モードの枠）や、ドラッグの当たり判定はそのまま合う。
 */
export const STRETCH_Y = 1.04;          // renderer.js と同じ（盤面を画面の縦にだけ伸ばす率）
const K = Math.SQRT1_2;

/** 立方体の一辺（マスに対する比）。マスの間にすき間を残し、1 個ずつの立方体に見えるように */
export const CUBE = 0.9;
/** 角の丸み（一辺に対する比）。本物のガラスの立方体も角を少し落としてあり、そこが細く光る */
export const BEVEL = 0.1;
/** 盤面の中心を見上げる角度。上の方（ゴール）はもっと大きく、下の方（直角の先）は小さく見上げる */
export const VIEW_ANGLE = 20 * Math.PI / 180;


const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** 盤面のローカル px（2D の playfield の座標、W = 盤面の一辺）→ B 空間の (x, y) */
export function localToB(lx, ly, W) {
  const dx = lx - W / 2, dy = ly - W / 2;
  return { x: K * (dy - dx), y: K * (dx + dy) };
}
/** localToB の逆 */
export function bToLocal(bx, by, W) {
  return { x: W / 2 + K * (by - bx), y: W / 2 + K * (bx + by) };
}

/** 目は盤面の中心から、このマス数だけ下（スマホでは手駒のあたり。どの画面でも、マスの大きさに対して同じ見え方になる） */
export const EYE_BELOW = 14;
/**
 * 目の位置（ex, ey, ez は縦に伸ばした後の画面の向きの座標。ez は盤面の表からの距離）。cell = 1 マスの大きさ
 */
export function eyeFor(cell, angle = VIEW_ANGLE) {
  const zRef = CUBE * cell / 2, below = EYE_BELOW * cell;
  return { ex: 0, ey: -below, ez: zRef + below / Math.tan(angle), zRef };
}

/**
 * B 空間 → クリップ座標の 4×4 行列（行優先の 16 個の数）。
 * z = zRef の面が、画面の (cx + x, cy - 1.04 y) にそのまま写る（2D の盤面と同じ）。
 * img = 盤面だけに掛ける画面上の変形（弾む・寄る・揺れる。画面座標の [a, b, c, d, tx, ty]: x' = a x + b y + tx, y' = c x + d y + ty）
 */
export function projection(view, eye, near, far, img = null) {
  const { vw, vh, cx, cy } = view, { ex, ey, ez, zRef } = eye;
  const D = ez - zRef, ax = 2 / vw, ay = 2 / vh;
  const bx = 2 * cx / vw - 1, by = 1 - 2 * cy / vh;
  const A = -(far + near) / (far - near), B = -2 * far * near / (far - near);
  const s = STRETCH_Y;
  let m = [
    ax * D, 0, -ax * ex - bx, ax * ex * zRef + bx * ez,
    0, ay * D * s, -ay * ey - by, ay * ey * zRef + by * ez,
    0, 0, A, B - A * ez,
    0, 0, -1, ez,
  ];
  if (img) m = mul4(imageMatrix(view, img), m);
  return m;
}

/** 画面座標の 2D の変形を、クリップ座標の 4×4 行列にする（projection の img） */
function imageMatrix({ vw, vh }, [a, b, c, d, tx, ty]) {
  const r = vh / vw;
  return [
    a, -b * r, 0, a + b * r + 2 * tx / vw - 1,
    -c / r, d, 0, 1 - c / r - d - 2 * ty / vh,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ];
}
export function mul4(a, b) {
  const o = new Array(16).fill(0);
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    let v = 0;
    for (let k = 0; k < 4; k++) v += a[i * 4 + k] * b[k * 4 + j];
    o[i * 4 + j] = v;
  }
  return o;
}
/** 4×4（行優先）を点に掛ける */
export function apply4(m, x, y, z, w = 1) {
  return [0, 1, 2, 3].map((i) => m[i * 4] * x + m[i * 4 + 1] * y + m[i * 4 + 2] * z + m[i * 4 + 3] * w);
}

/** B 空間の点 → 画面座標（px） */
export function projectToClient(view, eye, x, y, z) {
  const { ex, ey, ez, zRef } = eye, D = ez - zRef, t = D / (ez - z);
  const wy = y * STRETCH_Y;
  return { x: view.cx + ex + (x - ex) * t, y: view.cy - (ey + (wy - ey) * t) };
}
/** 画面座標（px）に写る、高さ z の面の上の B 空間の点 */
export function unprojectClient(view, eye, px, py, z) {
  const { ex, ey, ez, zRef } = eye, D = ez - zRef, t = (ez - z) / D;
  const wx = ex + (px - view.cx - ex) * t, wy = ey + (view.cy - py - ey) * t;
  return { x: wx, y: wy / STRETCH_Y, z };
}

/**
 * CSS の cubic-bezier(x1, y1, x2, y2) と同じ進み方（t: 0〜1 の時間の割合 → 進んだ割合）。
 * ブロックの動きを 2D の CSS アニメーションとそろえるため
 */
export function cubicBezier(x1, y1, x2, y2) {
  const bx = (t) => 3 * x1 * t * (1 - t) ** 2 + 3 * x2 * t * t * (1 - t) + t ** 3;
  const by = (t) => 3 * y1 * t * (1 - t) ** 2 + 3 * y2 * t * t * (1 - t) + t ** 3;
  const dx = (t) => 3 * x1 * (1 - t) ** 2 + 6 * (x2 - x1) * t * (1 - t) + 3 * (1 - x2) * t * t;
  return (x) => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) {                     // ニュートン法（たいてい数回で収まる）
      const e = bx(t) - x, d = dx(t);
      if (Math.abs(e) < 1e-6) break;
      if (Math.abs(d) < 1e-6) break;
      t = clamp(t - e / d, 0, 1);
    }
    if (Math.abs(bx(t) - x) > 1e-4) {                 // 収まらないときは二分法
      let lo = 0, hi = 1;
      for (let i = 0; i < 40; i++) { t = (lo + hi) / 2; if (bx(t) < x) lo = t; else hi = t; }
    }
    return by(t);
  };
}
export const EASE = {
  linear: (t) => t,
  in: cubicBezier(0.42, 0, 1, 1),
  out: cubicBezier(0, 0, 0.58, 1),
  inOut: cubicBezier(0.42, 0, 0.58, 1),
  ease: cubicBezier(0.25, 0.1, 0.25, 1),
};

/**
 * キーフレームの値（CSS の @keyframes と同じ考え方）。frames = [[offset, 値 or 値の配列], …]（offset は 0〜1 の昇順）、
 * p = 進んだ割合、ease = 区間ごとの進み方
 */
export function keyframes(frames, p, ease = EASE.linear) {
  if (p <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [o1, v1] = frames[i];
    if (p > o1) continue;
    const [o0, v0] = frames[i - 1];
    const u = ease(o1 > o0 ? (p - o0) / (o1 - o0) : 1);
    return Array.isArray(v0) ? v0.map((a, j) => a + (v1[j] - a) * u) : v0 + (v1 - v0) * u;
  }
  return frames[frames.length - 1][1];
}

/**
 * 盤面の外形（size 段の階段形の三角形）の頂点。マス単位、角を丸める分 inset だけ内側へ寄せた多角形
 * （シェーダーで「内側へ寄せた多角形からの距離 - inset」を外形にすると、出っ張った角だけが半径 inset で丸くなる）
 */
export function platePolygon(size = 8, inset = 0.2) {
  // (0,0) → (size,0) → (size,1) → (size-1,1) → (size-1,2) → … → (1,size) → (0,size)
  const poly = [[0, 0], [size, 0]];
  for (let r = 1; r <= size; r++) poly.push([size - r + 1, r], [size - r, r]);
  const n = poly.length;
  return poly.map(([x, y], i) => {
    const [px, py] = poly[(i + n - 1) % n], [qx, qy] = poly[(i + 1) % n];
    // 辺の内向きの法線（時計回り・y 下向きの座標なので、進む向きを右へ 90° 回すと内側）
    const n1 = [-(y - py), x - px].map((v) => Math.sign(v)), n2 = [-(qy - y), qx - x].map((v) => Math.sign(v));
    return [x + (n1[0] + n2[0]) * inset, y + (n1[1] + n2[1]) * inset];
  });
}

/** 点 (x, y) から多角形までの符号付き距離（内側が負） */
export function polyDistance(poly, x, y) {
  const n = poly.length;
  let d = (x - poly[0][0]) ** 2 + (y - poly[0][1]) ** 2, sign = 1;
  for (let i = 0; i < n; i++) {
    const [vx, vy] = poly[i], [jx, jy] = poly[(i + n - 1) % n];
    const ex = jx - vx, ey = jy - vy, wx = x - vx, wy = y - vy;
    const t = clamp((wx * ex + wy * ey) / (ex * ex + ey * ey), 0, 1);
    const bx = wx - ex * t, by = wy - ey * t;
    d = Math.min(d, bx * bx + by * by);
    const c0 = y >= vy, c1 = y < jy, c2 = ex * wy > ey * wx;
    if ((c0 && c1 && c2) || (!c0 && !c1 && !c2)) sign = -sign;
  }
  return sign * Math.sqrt(d);
}

/**
 * 盤面の板の外形の地図（距離・向き）を、CPU で 1 回だけ計算する。rect = [x0, y0, x1, y1]（マス単位）、res = 一辺の画素数。
 * 返り値は 4 個ずつ（距離、向きの x・y、1）の Float32Array（上の行から順）。
 * 前は GPU のシェーダーで描いていたが、一部の Android の GPU で多角形の内外判定が狂い、板が画面いっぱいに広がったので、計算は CPU でする
 */
export function plateFieldData(poly, round, rect, res) {
  const [x0, y0, x1, y1] = rect, out = new Float32Array(res * res * 4), e = 0.01;
  const sd = (x, y) => polyDistance(poly, x, y) - round;
  for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
    const x = x0 + (x1 - x0) * (i + 0.5) / res, y = y0 + (y1 - y0) * (j + 0.5) / res, o = (j * res + i) * 4;
    out[o] = sd(x, y);
    out[o + 1] = (sd(x + e, y) - sd(x - e, y)) / (2 * e);
    out[o + 2] = (sd(x, y + e) - sd(x, y - e)) / (2 * e);
    out[o + 3] = 1;
  }
  return out;
}

/** 32 ビット浮動小数点 → 16 ビット（半精度）。WebGL2 の半精度テクスチャ用（距離の大きさは ±数十まで） */
export function toHalf(v) {
  if (v === 0) return 0;
  const f = new Float32Array(1), u = new Uint32Array(f.buffer);
  f[0] = v;
  const x = u[0], sign = (x >>> 16) & 0x8000, exp = ((x >>> 23) & 0xff) - 127 + 15, man = x & 0x7fffff;
  if (exp >= 31) return sign | 0x7bff;
  if (exp <= 0) return exp < -10 ? sign : sign | ((man | 0x800000) >> (14 - exp));
  return sign | (exp << 10) | (man >> 13);
}

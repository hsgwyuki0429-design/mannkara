/**
 * 3D の盤面: ブロック 1 個ずつをガラスの立方体として WebGL（three.js）で描く。
 *
 * ガラスの見え方は、画素ごとに光の通り道を計算して決める（写真のようなガラスにするため）:
 *  - 表面の反射: 入る角度で強さが変わる（フレネルの式）。浅い角度ほど映り込みが強い
 *  - 屈折: 光は面で曲がって中に入り（屈折率 1.52）、反対側の面から曲がって出る（スネルの法則）
 *  - 中での反射: 出口の面で一部は反射して中に戻り、角度が浅いと全部戻る（全反射）。数回まで追いかける。
 *    ガラスの立方体のふちが暗く・鏡のように見えるのはこのため
 *  - 色: 色ガラスは通る距離が長いほど濃くなる（ベール・ランベルトの法則）。厚いふちほど深い色
 *  - 分光: 出るときの曲がり方を赤・緑・青で少しずらす（ふちに虹色がにじむ）
 *  - 角の丸み: 角を少し落とした立方体（実物と同じ）。丸い所が光源を細く映して光る
 * 光の当たり方は、スタジオの照明（左上の大きなソフトボックス・右の細いストリップライト・手前の面光源・小さな太陽）を
 * 方向の関数で描いた環境で決める。盤面には、ガラスを通った光が色付きで落ちる（コースティクス）。
 *
 * カメラ・座標は cube3d-math.js。立方体の高さのまん中が 2D の盤面とぴったり重なるので、DOM の重ね表示・当たり判定は 2D のまま。
 * 描く順: 光の落ち方（コースティクスの地図）→ 背景と盤面 → 立方体（盤面・手駒・仮置き）→ 持っているピース → 光のにじみ（ブルーム）→ 画面
 * 何も動いていない間は描かない（最後に描いた絵がそのまま残る）。重い端末では、描く細かさ・反射の回数・にじみを自動で減らす。
 */
import * as THREE from './vendor/three.js?v=202610061235';
import { SIZE } from '../core/constants.js?v=202610061235';
import { CUBE, BEVEL, STRETCH_Y, VIEW_ANGLE, localToB, eyeFor, projection, unprojectClient, keyframes, cubicBezier, EASE, platePolygon, plateFieldData, toHalf } from './cube3d-math.js?v=202610061235';

/* ---------- 見た目の調整 ---------- */
const IOR = 1.52;                 // クラウンガラス
const DISPERSION = 0.026;         // 赤と青の屈折率の差の半分
const HOVER = 0.95;               // 持っているピースが盤面から浮く高さ（立方体の何個ぶん）
const SWEEP_MS = 520;             // ラインが消えたときの光の帯が、盤面を横切る時間
const srgb = (hex, k = 1) => [1, 3, 5].map((i) => {
  const v = parseInt(hex.slice(i, i + 2), 16) / 255;
  return (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4) * k;
});
/** 色名 → ガラスを一辺ぶん通ったあとに残る光の割合（線形 RGB）。通る距離が長いほど、この割合を何回も掛けて濃くなる。
 *  青い盤面の上で沈まないよう、どの色も明るさ（輝度）がオレンジ（約 0.4）以上になるようにしてある */
const GLASS = {
  red: [1.0, 0.2, 0.24],
  orange: [1.0, 0.3, 0.02],
  yellow: [1.0, 0.78, 0.03],
  green: [0.06, 0.86, 0.14],
  cyan: [0.03, 0.74, 1.0],
  blue: [0.12, 0.34, 1.0],
  purple: [0.62, 0.26, 1.0],
  debug: [0.6, 0.66, 0.8],
  x: [0.6, 0.66, 0.8],
};
const glassOf = (name) => GLASS[name] || GLASS.purple;
/** 背景・盤面・照明（線形 RGB） */
export const BACKDROP = { top: '#3a6adf', mid: '#4479f2', bottom: '#3a6adf', glow: '#4479f2' };
const LOOK = {
  backTop: srgb(BACKDROP.top), backMid: srgb(BACKDROP.mid), backBottom: srgb(BACKDROP.bottom), backGlow: srgb(BACKDROP.glow, 0.25),
  plate: srgb('#c4c8ef'), plateEdge: srgb('#d4d8ff', 0.9), plateGlow: srgb('#7c84e8', 0.1),
  envLo: srgb('#1f2257'), envMid: srgb('#3c4196'), envHi: srgb('#8890dc'),
  key: [20, 19.4, 18.4], rim: [12, 12.6, 13.8], rim2: [3.2, 3.4, 3.9], fill: [1.3, 1.35, 1.6], floor: [2.3, 2.2, 2.6], sun: [26, 25, 23],
  trayGlow: srgb(BACKDROP.glow, 0.16), backLight: [0.52, 0.5, 0.56],
  keyIrr: [1.55, 1.5, 1.42], amb: srgb('#5c62b8', 0.62),
  exposure: 1.0, bloom: 0.26, bloomThreshold: 0.92,
};
const norm = (v) => { const l = Math.hypot(...v); return v.map((x) => x / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** 光源の向き（B 空間: x 右・y 上・z 手前）。光の向きは 2D と同じ「左上」 */
const KEY_DIR = norm([-0.48, 0.62, 0.62]);
/** 影を落とす光の向き（マスの座標: x, r, 手前）。高さ 1 マスで、影は x に 0.34・r に 0.2 マスだけずれる */
const SHADOW_DIR = norm([0.34, 0.2, 1]);
const RIM_DIR = norm([0.6, 0.3, 0.74]);
const RIM2_DIR = norm([-0.9, -0.08, 0.42]);
const FLOOR_DIR = norm([0.0, -0.86, 0.5]);
const FILL_DIR = norm([0.0, 0.42, 0.91]);
const SUN_DIR = norm([-0.47, 0.26, 0.85]);
/** 面光源の向きから、その面の横・縦の向きを作る */
function panel(c, up = [0, 1, 0]) {
  let u = cross(up, c);
  if (Math.hypot(...u) < 1e-3) u = [1, 0, 0];
  u = norm(u);
  return { c, u, v: norm(cross(c, u)) };
}

/* ---------- GLSL ---------- */
const ENV_GLSL = /* glsl */ `
uniform vec3 uEnvLo, uEnvMid, uEnvHi;
uniform vec3 uKeyC, uKeyU, uKeyV, uKeyCol;
uniform vec3 uRimC, uRimU, uRimV, uRimCol;
uniform vec3 uRim2C, uRim2U, uRim2V, uRim2Col;
uniform vec3 uFillC, uFillU, uFillV, uFillCol;
uniform vec3 uFloorC, uFloorU, uFloorV, uFloorCol;
uniform vec3 uSunC, uSunCol;
uniform vec3 uSweepC, uSweepU, uSweepV, uSweepCol;   // ラインが消えたときに、ガラスの面を横切っていく光の帯（映り込み）
// 面光源（方向 c の先にある、横 u・縦 v の向きの角の丸い長方形）。d の向きに見える明るさ 0〜1
float softRect(vec3 d, vec3 c, vec3 u, vec3 v, vec2 hs, float soft) {
  float k = dot(d, c);
  if (k < 0.08) return 0.0;
  vec3 p = d / k - c;
  vec2 q = abs(vec2(dot(p, u), dot(p, v))) - hs;
  float sd = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0);
  return smoothstep(soft, -soft, sd);
}
// まわりの光（方向 d から来る光の強さ。HDR）
vec3 envColor(vec3 d) {
  vec3 c = mix(uEnvLo, uEnvMid, smoothstep(-0.85, 0.02, d.y));
  c = mix(c, uEnvHi, smoothstep(0.02, 0.95, d.y));
  c *= mix(0.6, 1.0, smoothstep(-0.7, 0.3, d.z));
  c += uKeyCol * softRect(d, uKeyC, uKeyU, uKeyV, vec2(0.62, 0.42), 0.16);
  c += uRimCol * softRect(d, uRimC, uRimU, uRimV, vec2(0.045, 0.95), 0.05);
  c += uRim2Col * softRect(d, uRim2C, uRim2U, uRim2V, vec2(0.035, 0.8), 0.04);
  c += uFillCol * softRect(d, uFillC, uFillU, uFillV, vec2(1.25, 0.42), 0.55);
  c += uFloorCol * softRect(d, uFloorC, uFloorU, uFloorV, vec2(1.6, 0.5), 0.7);
  float sd = max(dot(d, uSunC), 0.0);
  c += uSunCol * (pow(sd, 160.0) + 0.05 * pow(sd, 24.0));
  if (uSweepCol.r > 0.0) c += uSweepCol * softRect(d, uSweepC, uSweepU, uSweepV, vec2(0.028, 2.0), 0.03);
  return c;
}
`;

const COMMON_GLSL = /* glsl */ `
float fresnelDielectric(float cosi, float n1, float n2) {
  float eta = n1 / n2;
  float s2 = eta * eta * (1.0 - cosi * cosi);
  if (s2 >= 1.0) return 1.0;
  float ct = sqrt(1.0 - s2);
  float rs = (n1 * cosi - n2 * ct) / (n1 * cosi + n2 * ct);
  float rp = (n1 * ct - n2 * cosi) / (n1 * ct + n2 * cosi);
  return 0.5 * (rs * rs + rp * rp);
}
float sdRoundBox(vec3 p, vec3 h, float r) {
  vec3 q = abs(p) - (h - r);
  return length(max(q, 0.0)) + min(max(q.x, max(q.y, q.z)), 0.0) - r;
}
vec3 roundBoxNormal(vec3 p, vec3 h, float r) {
  vec3 q = abs(p) - (h - r);
  vec3 m = max(q, 0.0);
  float l = length(m);
  if (l > 1e-4) return sign(p) * m / l;
  vec3 a = step(q.yzx, q) * step(q.zxy, q);
  return normalize(sign(p) * a + vec3(0.0, 0.0, 1e-6));
}
`;

/** 立方体（ガラス）の頂点シェーダー。立方体ごとの中心・向き・大きさは instanceMatrix から取り出す */
const GLASS_VERT = /* glsl */ `
uniform mat4 uProj;
attribute vec3 iTint;
attribute vec4 iParams;
attribute vec4 iJoin;      // 同じ色の隣とつなぐ側（ローカルの +x, -x, +y, -y）へ伸ばす長さ（一辺 1 に対して）。0 = つながない
uniform float uBevel;
varying vec3 vPos;
varying vec3 vNrm;
flat varying vec4 vJoin;
flat varying vec3 vCenter;
flat varying vec3 vAx;
flat varying vec3 vAy;
flat varying vec3 vAz;
flat varying vec3 vHalf;
flat varying vec3 vTint;
flat varying vec4 vParams;
void main() {
  mat4 m = instanceMatrix;
  vec3 sx = m[0].xyz, sy = m[1].xyz, sz = m[2].xyz;
  vec3 sc = max(vec3(length(sx), length(sy), length(sz)), vec3(1e-4));
  vAx = sx / sc.x; vAy = sy / sc.y; vAz = sz / sc.z;
  vHalf = sc * 0.5;
  vCenter = m[3].xyz;
  // つなぐ側は角を丸めず、隣との境目（伸ばした先の平らな面）までまっすぐ伸ばす
  vec3 p = position, nn = normal, inner = position - normal * uBevel;
  vec3 dir[4] = vec3[4](vec3(1.0, 0.0, 0.0), vec3(-1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, -1.0, 0.0));
  for (int k = 0; k < 4; k++) {
    float e = iJoin[k];
    if (e <= 0.0) continue;
    vec3 a = dir[k];
    if (dot(inner, a) < 0.5 - uBevel - 1e-4 || dot(nn, a) < 1e-4) continue;
    vec3 d = nn - a * dot(nn, a);
    float l = length(d);
    nn = l > 1e-4 ? d / l : a;
    vec3 q = inner + (l > 1e-4 ? nn * uBevel : vec3(0.0));
    p = q - a * dot(q, a) + a * (0.5 + e);
    inner = inner - a * dot(inner, a) + a * (0.5 + e);   // 2 方向でつながる角も、両方の面まで伸ばす
  }
  vJoin = iJoin;
  vec3 n = nn / sc;
  vNrm = normalize(vAx * n.x + vAy * n.y + vAz * n.z);
  vec4 wp = m * vec4(p, 1.0);
  vPos = wp.xyz;
  vTint = iTint;
  vParams = iParams;
  gl_Position = uProj * wp;
}
`;

const GLASS_FRAG = /* glsl */ `
uniform vec3 uEye;
uniform mat4 uBgProj;
uniform sampler2D uBg;
uniform float uIor;
uniform float uDisp;
uniform float uBevel;
uniform float uCube;
uniform int uBounces;
uniform vec3 uBackLight;   // 手駒・持っているピースの後ろから当てる光（暗い背景の上でも、色ガラスの色が見えるように）
uniform vec3 uLaneLight;   // 盤面の外（通路）を流れる立方体に当てる光（params.w の割合で）
uniform sampler2D uNeighbors;   // 盤面の上の立方体の色の地図（横の面から抜けた光は、隣のガラスを通って色づく）
uniform vec4 uNbRect;
uniform float uNbOn;
uniform vec2 uBoard;       // 1 マスの大きさ・段数
varying vec3 vPos;
varying vec3 vNrm;
flat varying vec3 vCenter;
flat varying vec3 vAx;
flat varying vec3 vAy;
flat varying vec3 vAz;
flat varying vec3 vHalf;
flat varying vec3 vTint;
flat varying vec4 vParams;
flat varying vec4 vJoin;
${ENV_GLSL}
${COMMON_GLSL}

// 立方体から出た光の先に見えるもの: 盤面の方（奥）へ向かうなら、描いておいた背景と盤面の絵のその場所。手前へ向かうなら、まわりの光
vec3 behind(vec3 p, vec3 d, bool side) {
  if (d.z > -0.015) return envColor(d);
  float t = max(-p.z / d.z, 0.0);
  vec3 q = p + d * t;
  vec4 c = uBgProj * vec4(q, 1.0);
  vec2 uv = c.xy / c.w * 0.5 + 0.5;
  vec3 b = texture2D(uBg, clamp(uv, vec2(0.001), vec2(0.999))).rgb + uBackLight + uLaneLight * vParams.w;
  if (side && uNbOn > 0.0) {
    // 横の面から出て、隣のマスの上の立方体を通ってから盤面に届く光（自分の真下は除く）
    vec3 ql = transpose(mat3(vAx, vAy, vAz)) * (q - vCenter);
    if (max(abs(ql.x) - vHalf.x, abs(ql.y) - vHalf.y) > 0.0) {
      vec2 cell = vec2(0.70710678 * (q.y - q.x), 0.70710678 * (q.x + q.y)) / uBoard.x + uBoard.y * 0.5;
      b *= texture2D(uNeighbors, (cell - uNbRect.xy) / (uNbRect.zw - uNbRect.xy)).rgb;
    }
  }
  vec2 o = abs(uv - 0.5);
  float w = smoothstep(0.015, 0.3, -d.z) * (1.0 - smoothstep(0.47, 0.5, max(o.x, o.y)));
  if (w > 0.999) return b;                      // ほとんどの光はまっすぐ盤面へ抜ける（まわりの光は計算しない）
  return mix(envColor(d), b, w);
}
float boxExit(vec3 o, vec3 d, vec3 h) {
  vec3 dd = sign(d) * max(abs(d), vec3(1e-5));
  vec3 t = (sign(dd) * h - o) / dd;
  return min(t.x, min(t.y, t.z));
}
// 出口の面での屈折（ガラス → 空気）。全反射なら 0
vec3 refractOut(vec3 d, vec3 n, float eta) {
  float c = dot(d, n);
  float k = 1.0 - eta * eta * (1.0 - c * c);
  if (k < 0.0) return vec3(0.0);
  return eta * d - (eta * c - sqrt(k)) * n;
}

void main() {
  mat3 R = mat3(vAx, vAy, vAz);
  mat3 Rt = transpose(R);
  float rb = uBevel * 2.0 * min(vHalf.x, min(vHalf.y, vHalf.z));
  // 同じ色の隣とつながった側: 本当の外形（lo〜hi）はその側へ伸び、角の丸みは無い（丸みを測る箱は、その側へさらに遠くまで伸ばしておく）
  vec4 ext = vJoin * vec4(2.0 * vHalf.x, 2.0 * vHalf.x, 2.0 * vHalf.y, 2.0 * vHalf.y);
  vec4 on = step(1e-5, vJoin);
  vec3 hi = vHalf + vec3(ext.x, ext.z, 0.0), lo = -vHalf - vec3(ext.y, ext.w, 0.0);
  float far = 4.0 * vHalf.x;
  vec3 hiV = hi + far * vec3(on.x, on.z, 0.0), loV = lo - far * vec3(on.y, on.w, 0.0);
  vec3 cv = (hiV + loV) * 0.5, h = (hiV - loV) * 0.5;
  vec3 V = normalize(vPos - uEye);
  vec3 pl = Rt * (vPos - vCenter);
  // つながった面そのもの（隣との境目）は描かない（ガラスがひと続きに見える）
  float eps = 0.004 * vHalf.x;
  if ((on.x > 0.0 && pl.x > hi.x - eps) || (on.y > 0.0 && pl.x < lo.x + eps) || (on.z > 0.0 && pl.y > hi.y - eps) || (on.w > 0.0 && pl.y < lo.y + eps)) discard;
  vec3 vl = Rt * V;
  vec3 nl = roundBoxNormal(pl - cv, h, rb);
  if (dot(nl, vl) > -0.001) nl = normalize(Rt * vNrm);
  if (dot(nl, vl) > -0.001) nl = -vl;
  vec3 N = R * nl;
  float cosi = clamp(-dot(V, N), 0.0, 1.0);
  float F = fresnelDielectric(cosi, 1.0, uIor);
  vec3 col = F * envColor(reflect(V, N));

  // 吸収（一辺 uCube を通ると vTint が残る）
  vec3 sigma = -log(clamp(vTint, vec3(0.002), vec3(1.0))) / uCube;
  vec3 dl = refract(vl, nl, 1.0 / uIor);
  vec3 o = pl;
  vec3 thr = vec3(1.0 - F);
  vec3 acc = vec3(0.0);
  for (int i = 0; i < 4; i++) {
    if (i >= uBounces) break;
    // つながった側は、隣の同じ色のガラスが続いているものとして、箱をその側へ長く伸ばしてある（hiV / loV）ので、光は境目で曲がらず・色づかず
    // そのまま奥へ進む（境目の線が出ない）
    float t = boxExit(o - cv, dl, h);
    vec3 pe = o + dl * t;
    float s = sdRoundBox(pe - cv, h, rb); t -= s; pe = o + dl * t;
    s = sdRoundBox(pe - cv, h, rb); t -= s; pe = o + dl * t;
    t = max(t, 0.0);
    thr *= exp(-sigma * t);
    vec3 ne = roundBoxNormal(pe - cv, h, rb);
    float c = dot(dl, ne);
    if (c < 0.02) { ne = normalize(ne + dl * (0.02 - c) * 2.0); c = dot(dl, ne); }
    vec3 pw = vCenter + R * pe;
    vec3 tg = refractOut(dl, ne, uIor);
    if (dot(tg, tg) > 0.0) {
      float Fr = fresnelDielectric(c, uIor, 1.0);
      bool side = abs(ne.z) < 0.6;
      vec3 L;
      if (i == 0 && uDisp > 0.0) {
        vec3 tr = refractOut(dl, ne, uIor - uDisp), tb = refractOut(dl, ne, uIor + uDisp);
        L = vec3(dot(tr, tr) > 0.0 ? behind(pw, R * tr, side).r : 0.0, behind(pw, R * tg, side).g, dot(tb, tb) > 0.0 ? behind(pw, R * tb, side).b : 0.0);
      } else {
        L = behind(pw, R * tg, side);
      }
      acc += thr * (1.0 - Fr) * L;
      thr *= Fr;
    }
    dl = reflect(dl, ne);
    o = pe;
  }
  // 追いかけきれなかった光は、最後の向きの先に見えるもので近似する
  acc += thr * behind(vCenter + R * o, R * dl, false) * 0.6;
  col += acc;

  // 消える列の予告（params.y）: ふちが白く光って脈打つ
  if (vParams.y > 0.0) {
    vec3 a = abs(pl) / (vHalf + vec3(max(ext.x, ext.y), max(ext.z, ext.w), 0.0));
    vec3 srt = vec3(min(a.x, min(a.y, a.z)), max(min(a.x, a.y), min(max(a.x, a.y), a.z)), max(a.x, max(a.y, a.z)));
    float edge = smoothstep(0.72, 0.97, srt.y);
    col += (vec3(1.0, 0.98, 0.95) * 2.4 * edge + vTint * 0.35) * vParams.y;
  }
  // 仮置き（params.z）: 白っぽく淡いガラス
  col = mix(col, col * 0.75 + vec3(0.32, 0.34, 0.42), vParams.z);
  gl_FragColor = vec4(col, vParams.x);
}
`;

const FS_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** 背景（奥の壁）と盤面（ガラスの板・マスのくぼみ・ふち・板の厚み）。画面の 1 画素ずつ、目からの光線で決める */
const BG_FRAG = /* glsl */ `
uniform vec4 uView;        // vw, vh, cx, cy（CSS px）
uniform vec2 uRes;         // 描く画素数
uniform vec4 uEyeW;        // 目（縦に伸ばした後の画面の向き）: ex, ey, ez, zRef
uniform mat3 uImgInv;      // 盤面に掛けている画面上の変形の逆（弾む・寄る・揺れる）
uniform float uCell;
uniform float uSize;
uniform float uStretch;
uniform sampler2D uSdf;
uniform vec4 uSdfRect;
uniform float uThick;
uniform float uWall;
uniform sampler2D uCaustic;
uniform sampler2D uOcc;     // 盤面の上の立方体の色の地図（立方体の真下は白以外）
uniform vec4 uCausRect;
uniform sampler2D uTints;
uniform vec3 uKeyDir, uKeyIrr, uAmb;
uniform vec3 uPlate, uPlateEdge, uPlateGlow;
uniform vec3 uBackTop, uBackMid, uBackBottom, uBackGlow, uTrayGlow;
uniform vec3 uTrayAt[3];   // 手駒の後ろの光（中心 x, y・半径。CSS px）
uniform vec3 uEye;
varying vec2 vUv;
${ENV_GLSL}

const float K = 0.70710678;
// 盤面の板の外形までの距離（マス単位。内側が負）と、その向き。前もって描いておいた地図（uSdf）から読む（多角形を毎画素計算すると重い）
vec3 plateField(vec2 cell) {
  vec2 uv = (cell - uSdfRect.xy) / (uSdfRect.zw - uSdfRect.xy);
  vec3 f = texture2D(uSdf, uv).rgb;
  // 地図の外は、地図のふちの値から距離を伸ばす（影や厚みを探しに外へ出ても破綻しない）
  vec2 o = max(max(uSdfRect.xy - cell, cell - uSdfRect.zw), 0.0);
  f.x += length(o);
  return f;
}
float sdPlate(vec2 cell) { return plateField(cell).x; }
// 画面の向きの座標（縦に伸ばした後）→ マスの座標（x, r。マス単位）
vec2 toCell(vec2 w) {
  vec2 b = vec2(w.x, w.y / uStretch);
  return vec2(K * (b.y - b.x), K * (b.x + b.y)) / uCell + uSize * 0.5;
}
// マスの座標の向き → B 空間の向き
vec2 cellDirToB(vec2 v) { return vec2(K * (v.y - v.x), K * (v.x + v.y)); }
float sdRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec2 gradRoundRect(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  vec2 m = max(q, 0.0);
  float l = length(m);
  vec2 g = l > 1e-5 ? m / l : (q.x > q.y ? vec2(1.0, 0.0) : vec2(0.0, 1.0));
  return sign(p) * g;
}
vec2 gradPlate(vec2 c) { vec2 g = plateField(c).yz; return g / max(length(g), 1e-4); }
bool inBoard(vec2 ci) { return ci.x >= 0.0 && ci.y >= 0.0 && ci.x + ci.y <= uSize - 1.0; }

vec3 backdrop(vec2 client, vec2 P) {
  float y = client.y / uView.y;
  vec3 c = mix(uBackTop, uBackMid, smoothstep(0.0, 0.42, y));
  c = mix(c, uBackBottom, smoothstep(0.5, 1.0, y));
  vec2 g = (client - vec2(uView.z, uView.w)) / vec2(uView.x * 0.62, uView.y * 0.36);
  c += uBackGlow * exp(-dot(g, g) * 1.6);
  // 手駒の後ろの、やわらかい光（ガラスの手駒が透けて光って見えるように。枠ごとに 1 つ）
  for (int i = 0; i < 3; i++) {
    vec3 t = uTrayAt[i];
    vec2 q = (client - t.xy) / max(t.z, 1.0);
    c += uTrayGlow * exp(-dot(q, q) * 2.2);
  }
  // 盤面の板が奥の壁に落とす、やわらかい影（光は左上の手前から。壁は板の uWall 奥）
  float D = uEyeW.z - uEyeW.w;
  vec2 w2 = uEyeW.xy + (P - uEyeW.xy) * ((uEyeW.z + uWall) / D);
  vec3 L = uKeyDir;
  vec2 sh = vec2(w2.x, w2.y / uStretch) + L.xy / L.z * (uWall - uThick);
  float sdS = sdPlate(toCell(vec2(sh.x, sh.y * uStretch)));
  c *= 1.0 - 0.3 * smoothstep(1.3, -0.6, sdS);
  return c;
}

void main() {
  vec2 client = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y) * (uView.x / uRes.x);
  vec3 bc = uImgInv * vec3(client, 1.0);
  vec2 P = vec2(bc.x - uView.z, uView.w - bc.y);            // 盤面の基準面（立方体の高さのまん中）の点
  vec3 col = backdrop(client, P);
  float D = uEyeW.z - uEyeW.w;
  // 板の表（z = 0）
  vec2 w0 = uEyeW.xy + (P - uEyeW.xy) * (uEyeW.z / D);
  vec2 cell0 = toCell(w0);
  float sd0 = sdPlate(cell0);
  // 板の裏（z = -uThick）: 表の外で裏の内なら、板の側面（厚み）が見えている
  vec2 w1 = uEyeW.xy + (P - uEyeW.xy) * ((uEyeW.z + uThick) / D);
  vec2 cell1 = toCell(w1);
  float sd1 = sdPlate(cell1);
  float px = uView.x / uRes.x / uCell;                        // 1 画素のマス単位の大きさ
  vec3 pos0 = vec3(w0.x, w0.y / uStretch, 0.0);
  vec3 V = normalize(pos0 - uEye);
  if (sd1 < px * 1.5) {
    vec2 g = gradPlate(cell1);
    vec3 n = normalize(vec3(cellDirToB(g), -0.08));
    float lit = max(dot(n, uKeyDir), 0.0);
    float F = 0.04 + 0.96 * pow(1.0 - clamp(-dot(V, n), 0.0, 1.0), 5.0);
    // ガラスの板の切り口: 中を通ってきた光で明るく、少し色づく
    vec3 wall = uPlateEdge * (0.55 + 0.45 * lit) + F * envColor(reflect(V, n)) * 0.8;
    float depth = clamp(-sd0 / max(1e-3, (sd1 < 0.0 ? sd0 - sd1 : 1.0)), 0.0, 1.0);
    wall *= 0.8 + 0.2 * depth;
    col = mix(col, wall, smoothstep(px * 1.5, -px * 1.5, sd1));
  }
  if (sd0 < px * 1.5) {
    vec2 ci = floor(cell0);
    vec2 f = cell0 - ci - 0.5;
    // マスのくぼみ（彫り込み）: ふちの斜面は光の当たる側が暗く、向こう側が明るい
    float dw = sdRoundRect(f, vec2(0.435), 0.13);
    float wb = 0.07;
    vec2 gw = gradRoundRect(f, vec2(0.435), 0.13);
    vec4 occ4 = texture2D(uOcc, (cell0 - uCausRect.xy) / (uCausRect.zw - uCausRect.xy));
    // 立方体の真下は、くぼみの縁を描かない（ガラスを通して縁の線が見えると、つながったブロックの継ぎ目に見える。
    // 空いているマスだけにくぼみが見えるので、空きとブロックの見分けにもなる）
    float occupied = 1.0 - smoothstep(0.82, 0.97, min(occ4.r, min(occ4.g, occ4.b)));
    float slope = 0.0;      // マスのくぼみ（溝）は無し: 盤面は真っ平
    vec2 tiltCell = -gw * slope * 1.25;
    // 板のふち（丸く面取り）: 外向きに傾いて、まわりの光を映す
    float rim = smoothstep(-0.075, 0.0, sd0);
    vec2 tiltRim = gradPlate(cell0) * rim * rim * 3.0;
    vec3 n = normalize(vec3(cellDirToB(tiltCell + tiltRim), 1.0));
    float floorK = 0.0;
    vec3 albedo = uPlate * (1.0 - 0.16 * floorK);
    vec2 cuv = (cell0 - uCausRect.xy) / (uCausRect.zw - uCausRect.xy);
    vec4 cs = texture2D(uCaustic, cuv);
    float ndl = max(dot(n, uKeyDir), 0.0);
    // スポットライトの当たり方のむら: 光源（左上）に近いほど明るく、遠い角ほど少し暗い
    vec2 sp = (cell0 - vec2(uSize * 0.62, uSize * 0.18)) / uSize;
    float spot = mix(0.72, 1.18, exp(-dot(sp, sp) * 2.2));
    vec3 lit = albedo * (uAmb * cs.a * (0.88 + 0.12 * floorK) + uKeyIrr * ndl * cs.rgb * spot);
    // マスの区切りの、細くて薄い線（盤面の中だけ。ブロックの真下は描かない: ガラス越しに継ぎ目に見えるため）
    if (inBoard(ci)) {
      vec2 e = 0.5 - abs(f);
      float gl = 1.0 - smoothstep(0.0, max(px * 1.2, 0.012), min(e.x, e.y));
      lit = mix(lit, lit * vec3(0.78, 0.8, 0.9), gl * 0.55 * (1.0 - occupied));
    }
    // すりガラスの板の中を回ってくる光（ほんのり）
    lit += uPlateGlow * (0.6 + 0.4 * (1.0 - floorK));
    // 発動したラインのマスに満ちる色（くぼみの底が光る）
    if (inBoard(ci)) {
      vec4 tn = texelFetch(uTints, ivec2(ci), 0);
      if (tn.a > 0.001) {
        float s = clamp(tn.a, 0.0, 1.2);
        float m = smoothstep(0.035, -0.035, sdRoundRect(f, vec2(0.37 * s), 0.12 * s));
        lit += tn.rgb * m * 2.6 * min(1.0, s * 1.6);
      }
    }
    float cosv = clamp(-dot(V, n), 0.0, 1.0);
    float F = 0.04 + 0.96 * pow(1.0 - cosv, 5.0);
    lit += F * envColor(reflect(V, n)) * 0.9;
    col = mix(col, lit, smoothstep(px * 1.5, -px * 1.5, sd0));
  }
  gl_FragColor = vec4(col, 1.0);
}
`;

/** コースティクスの地図: 盤面の 1 点から光源の向きに光線を伸ばし、立方体を通る長さ・ふちで曲がる光から、届く光の色と強さを決める（掛け算で重ねる） */
const CAUS_VERT = /* glsl */ `
uniform vec3 uL;           // 光源の向き（マスの座標の向き。z は手前）
uniform vec4 uRect;        // 地図が覆う範囲（マス単位）
attribute vec4 iCube;      // 中心 x, r（マス単位）・半分の大きさ・底の高さ
attribute vec4 iCube2;     // 高さ・角の丸み
attribute vec3 iTint;
attribute vec4 iExt;       // 同じ色の隣とつなぐ側へ伸ばす長さ（マス単位。-x, +x, -r, +r）。ひとつの塊として影・光を決める
varying vec2 vCell;
flat varying vec4 vCube;
flat varying vec4 vCube2;
flat varying vec3 vTint;
flat varying vec4 vExt;
void main() {
  vec2 s = -uL.xy / uL.z;
  float z0 = iCube.w, z1 = iCube.w + iCube2.x;
  vec2 lo = iCube.xy - iCube.z - iExt.xz + min(s * z0, s * z1) - 0.32;
  vec2 hi = iCube.xy + iCube.z + iExt.yw + max(s * z0, s * z1) + 0.32;
  vCell = mix(lo, hi, position.xy + 0.5);
  vCube = iCube; vCube2 = iCube2; vTint = iTint; vExt = iExt;
  gl_Position = vec4((vCell - uRect.xy) / (uRect.zw - uRect.xy) * 2.0 - 1.0, 0.0, 1.0);
}
`;
const CAUS_FRAG = /* glsl */ `
uniform vec3 uL;
varying vec2 vCell;
flat varying vec4 vCube;
flat varying vec4 vCube2;
flat varying vec3 vTint;
flat varying vec4 vExt;
float edgeDist(vec3 p, vec3 lo, vec3 hi) {
  vec3 d = min(p - lo, hi - p);
  // つながった側は塊の内側なので、ふち（角の丸み）は無い
  if (vExt.x > 0.0 && p.x - lo.x < hi.x - p.x) d.x = 1e3;
  if (vExt.y > 0.0 && hi.x - p.x <= p.x - lo.x) d.x = 1e3;
  if (vExt.z > 0.0 && p.y - lo.y < hi.y - p.y) d.y = 1e3;
  if (vExt.w > 0.0 && hi.y - p.y <= p.y - lo.y) d.y = 1e3;
  // 面の上の点: いちばん小さいのはその面、2 番目が近いふちまでの距離
  float a = min(d.x, min(d.y, d.z)), c = max(d.x, max(d.y, d.z));
  return d.x + d.y + d.z - a - c;
}
void main() {
  vec3 q = vec3(vCell, 0.0);
  vec3 lo = vec3(vCube.xy - vCube.z - vExt.xz, vCube.w), hi = vec3(vCube.xy + vCube.z + vExt.yw, vCube.w + vCube2.x);
  vec3 L = uL;
  vec3 t1 = (lo - q) / L, t2 = (hi - q) / L;
  vec3 tn = min(t1, t2), tf = max(t1, t2);
  float a = max(max(tn.x, tn.y), max(tn.z, 0.0)), b = min(tf.x, min(tf.y, tf.z));
  vec3 T = vec3(1.0);
  float rb = vCube2.y;
  if (b > a) {
    float len = b - a;
    vec3 sigma = -log(clamp(vTint, vec3(0.002), vec3(1.0))) / (2.0 * vCube.z);
    T = exp(-sigma * len) * 0.9;
    float e = min(edgeDist(q + L * a, lo, hi), edgeDist(q + L * b, lo, hi));
    // 角の丸い所に当たった光は外へ曲がる（暗いふち）→ そのすぐ内側に集まる（明るい線）
    T *= mix(0.22, 1.0, smoothstep(0.0, rb * 1.4, e));
    float ring = smoothstep(rb * 0.8, rb * 1.7, e) * smoothstep(rb * 4.2, rb * 1.9, e);
    float joined = step(1e-5, vExt.x + vExt.y + vExt.z + vExt.w);
    T += vTint * vTint * ring * mix(1.0, 0.0, joined) + vTint * 0.12;
  }
  // 立方体が盤面に接している所のまわりは、まわりの光が届きにくい（接地の影）
  vec2 bc = vCube.xy + 0.5 * (vExt.yw - vExt.xz), bh = vec2(vCube.z) + 0.5 * (vExt.xz + vExt.yw);
  vec2 dq = abs(vCell - bc) - bh;
  float dBase = length(max(dq, 0.0)) + min(max(dq.x, dq.y), 0.0);
  float near = exp(-vCube.w * 3.0);
  float ao = 1.0 - near * 0.5 * smoothstep(0.24, 0.0, dBase);
  gl_FragColor = vec4(T, ao);
}
`;

/** 盤面の板の外形の地図: 距離（マス単位。内側が負）と向き。段数が変わったときだけ描く */
const SDF_FRAG = /* glsl */ `
uniform vec2 uPoly[18];
uniform int uPolyN;
uniform float uRound;
uniform vec4 uRect;
varying vec2 vUv;
float sdPoly(vec2 p) {
  float d = dot(p - uPoly[0], p - uPoly[0]);
  float s = 1.0;
  for (int i = 0; i < 18; i++) {
    if (i >= uPolyN) break;
    int j = i == 0 ? uPolyN - 1 : i - 1;
    vec2 vi = uPoly[i], vj = uPoly[j];
    vec2 e = vj - vi, w = p - vi;
    vec2 b = w - e * clamp(dot(w, e) / dot(e, e), 0.0, 1.0);
    d = min(d, dot(b, b));
    bvec3 c = bvec3(p.y >= vi.y, p.y < vj.y, e.x * w.y > e.y * w.x);
    if (all(c) || all(not(c))) s = -s;
  }
  return s * sqrt(d);
}
float sd(vec2 p) { return uPolyN < 3 ? 1e3 : sdPoly(p) - uRound; }
void main() {
  vec2 p = mix(uRect.xy, uRect.zw, vUv);
  float e = 0.01;
  vec2 g = vec2(sd(p + vec2(e, 0.0)) - sd(p - vec2(e, 0.0)), sd(p + vec2(0.0, e)) - sd(p - vec2(0.0, e))) / (2.0 * e);
  gl_FragColor = vec4(sd(p), g, 1.0);
}
`;

/** 盤面の上の立方体の色の地図: 立方体の真下の四角を、その色ガラスを一辺ぶん通った光の色で塗る（掛け算で重ねる） */
const NB_VERT = /* glsl */ `
uniform vec4 uRect;
attribute vec4 iCube;
attribute vec4 iCube2;
attribute vec3 iTint;
attribute vec4 iExt;
varying vec2 vCell;
flat varying vec4 vCube;
flat varying vec3 vTint;
flat varying vec4 vExt;
void main() {
  vCube = iCube; vTint = iTint; vExt = iExt;
  float h = iCube.z + 0.06;
  vec2 lo = iCube.xy - h - iExt.xz, hi = iCube.xy + h + iExt.yw;
  vCell = mix(lo, hi, position.xy + 0.5);
  // 浮いている立方体（持っているピース・落ちてくる途中）は、盤面の上の隣ではないので描かない
  float off = iCube.w > 0.05 ? 1.0 : 0.0;
  gl_Position = vec4((vCell - uRect.xy) / (uRect.zw - uRect.xy) * 2.0 - 1.0, 0.0, 1.0 - off * 2.0);
}
`;
const NB_FRAG = /* glsl */ `
varying vec2 vCell;
flat varying vec4 vCube;
flat varying vec3 vTint;
flat varying vec4 vExt;
void main() {
  vec2 c = vCube.xy + 0.5 * (vExt.yw - vExt.xz), hh = vec2(vCube.z) + 0.5 * (vExt.xz + vExt.yw);
  vec2 d = abs(vCell - c) - hh;
  float inside = smoothstep(0.04, -0.04, max(d.x, d.y));
  gl_FragColor = vec4(mix(vec3(1.0), pow(clamp(vTint, 0.0, 1.0), vec3(0.85)) * 0.94, inside), 1.0);
}
`;

const COPY_FRAG = /* glsl */ `
uniform sampler2D uTex;
varying vec2 vUv;
void main() { gl_FragColor = texture2D(uTex, vUv); }
`;
/** ブルーム: 明るい所だけを取り出して縮める（最初の 1 回）→ 縮めながらぼかす → 広げながら足す */
const BRIGHT_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexel;
uniform float uThreshold;
varying vec2 vUv;
vec3 pick(vec2 uv) {
  vec3 c = texture2D(uTex, uv).rgb;
  float l = max(c.r, max(c.g, c.b));
  float k = max(l - uThreshold, 0.0);
  k = k * k / (k + 0.6);
  return c * (k / max(l, 1e-4)) / (1.0 + l * 0.12);
}
void main() {
  vec2 o = uTexel;
  vec3 c = pick(vUv + vec2(-o.x, -o.y)) + pick(vUv + vec2(o.x, -o.y)) + pick(vUv + vec2(-o.x, o.y)) + pick(vUv + vec2(o.x, o.y));
  gl_FragColor = vec4(c * 0.25, 1.0);
}
`;
const DOWN_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(uTex, vUv).rgb * 0.5
    + (texture2D(uTex, vUv + vec2(-o.x, -o.y)).rgb + texture2D(uTex, vUv + vec2(o.x, -o.y)).rgb
     + texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb + texture2D(uTex, vUv + vec2(o.x, o.y)).rgb) * 0.125;
  gl_FragColor = vec4(c, 1.0);
}
`;
const UP_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uBase;
uniform vec2 uTexel;
varying vec2 vUv;
void main() {
  vec2 o = uTexel;
  vec3 c = texture2D(uTex, vUv).rgb * 0.25
    + (texture2D(uTex, vUv + vec2(o.x, 0.0)).rgb + texture2D(uTex, vUv - vec2(o.x, 0.0)).rgb
     + texture2D(uTex, vUv + vec2(0.0, o.y)).rgb + texture2D(uTex, vUv - vec2(0.0, o.y)).rgb) * 0.125
    + (texture2D(uTex, vUv + o).rgb + texture2D(uTex, vUv - o).rgb
     + texture2D(uTex, vUv + vec2(o.x, -o.y)).rgb + texture2D(uTex, vUv + vec2(-o.x, o.y)).rgb) * 0.0625;
  gl_FragColor = vec4(texture2D(uBase, vUv).rgb + c, 1.0);
}
`;
const COMPOSITE_FRAG = /* glsl */ `
uniform sampler2D uTex;
uniform sampler2D uBloom;
uniform float uBloomK;
uniform vec2 uRes;
uniform float uAlpha;      // 1 = 描いた所だけ不透明（背景の無い絵）
varying vec2 vUv;
${THREE.ShaderChunk.tonemapping_pars_fragment}
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec4 src = texture2D(uTex, vUv);
  vec3 c = src.rgb + texture2D(uBloom, vUv).rgb * uBloomK;
  c = NeutralToneMapping(c);
  c = mix(c * 12.92, pow(max(c, vec3(0.0)), vec3(1.0 / 2.4)) * 1.055 - 0.055, step(0.0031308, c));
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;                  // 8 bit に落とすときの縞を消す
  gl_FragColor = vec4(c, mix(1.0, clamp(src.a, 0.0, 1.0), uAlpha));
}
`;

/* ---------- 形 ---------- */
/** 角を丸めた立方体（一辺 1、中心が原点）。丸い所は 45° ごとに seg 分割して、面と面の境目もなめらかにつなぐ */
export function roundedCube(bevel = BEVEL, seg = 4) {
  const r = bevel, ticks = [];
  for (let k = seg; k >= 0; k--) ticks.push(-0.5 + r * (1 - Math.tan((Math.PI / 4) * (k / seg))));
  const all = [...ticks, ...ticks.slice().reverse().map((v) => -v)], n = all.length;
  const pos = [], nrm = [], idx = [];
  for (const [a, s] of [[0, 1], [0, -1], [1, 1], [1, -1], [2, 1], [2, -1]]) {
    const u = (a + 1) % 3, v = (a + 2) % 3, base = pos.length / 3;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const p = [0, 0, 0];
      p[a] = 0.5 * s; p[u] = all[i]; p[v] = all[j];
      const inner = p.map((c) => Math.max(-0.5 + r, Math.min(0.5 - r, c)));
      const d = p.map((c, k) => c - inner[k]), len = Math.hypot(...d) || 1;
      for (let k = 0; k < 3; k++) { pos.push(inner[k] + d[k] / len * r); nrm.push(d[k] / len); }
    }
    for (let j = 0; j < n - 1; j++) for (let i = 0; i < n - 1; i++) {
      const a0 = base + j * n + i, a1 = a0 + 1, b0 = a0 + n, b1 = b0 + 1;
      if (s > 0) idx.push(a0, a1, b1, a0, b1, b0); else idx.push(a0, b1, a1, a0, b0, b1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(nrm), 3));
  g.setIndex(idx);
  return g;
}

/** 立方体の束（1 回の描画でまとめて描く） */
class Batch {
  constructor(geometry, material, capacity) {
    this.capacity = capacity;
    this.geometry = geometry.clone();
    this.tint = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
    this.params = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.geometry.setAttribute('iTint', this.tint);
    this.geometry.setAttribute('iParams', this.params);
    this.join = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 4), 4);
    this.geometry.setAttribute('iJoin', this.join);
    this.joinable = true;
    this.mesh = new THREE.InstancedMesh(this.geometry, material, capacity);
    this.mesh.frustumCulled = false;
    this.mesh.count = 0;
    this.n = 0;
  }
  begin() { this.n = 0; }
  /** 底の中心 (x, y, z)・大きさ (sx, sy, sz)・向き（z 軸まわりの角度 + 傾き q）・色・[不透明度, 光る強さ, 白さ, 0] */
  push(c, tint, params) {
    if (this.n >= this.capacity) return;
    const i = this.n++, m = this.mesh.instanceMatrix.array, o = i * 16;
    m.set(c, o);
    this.tint.array.set(tint, i * 3);
    this.params.array.set(params, i * 4);
  }
  end() {
    if (this.joinable) cubeJoins(this.mesh.instanceMatrix.array, this.tint.array, this.n, this.join.array);
    else this.join.array.fill(0, 0, this.n * 4);
    this.join.needsUpdate = true;
    this.mesh.count = this.n;
    this.mesh.instanceMatrix.needsUpdate = true;
    this.tint.needsUpdate = true;
    this.params.needsUpdate = true;
    this.mesh.visible = this.n > 0;
  }
}

/**
 * 同じ色の立方体が辺どうしで隣り合っていたら、すき間を埋めてつなぐ（GLASS_VERT / GLASS_FRAG の iJoin）。
 * いま描く位置（動きの途中も含む）で毎回決めるので、そろって滑っている間もつながったまま。
 * m = 行列（列優先 16 個ずつ）、tint = 色（3 個ずつ。同じ色は同じ値）、out = 4 個ずつ（ローカルの +x, -x, +y, -y へ伸ばす長さ。一辺 1 に対して）
 */
export function cubeJoins(m, tint, n, out) {
  out.fill(0, 0, n * 4);
  for (let i = 0; i < n; i++) {
    const o = i * 16, ax = [m[o], m[o + 1], m[o + 2]], ay = [m[o + 4], m[o + 5], m[o + 6]], az = [m[o + 8], m[o + 9], m[o + 10]];
    const sx = Math.hypot(...ax), sy = Math.hypot(...ay), sz = Math.hypot(...az);
    if (sx < 1e-6 || sy < 1e-6) continue;
    for (let j = 0; j < n; j++) {
      if (j === i || tint[i * 3] !== tint[j * 3] || tint[i * 3 + 1] !== tint[j * 3 + 1] || tint[i * 3 + 2] !== tint[j * 3 + 2]) continue;
      const q = j * 16;
      // 大きさ・高さがほぼ同じ立方体どうしだけ（落ちてくる途中・弾んでいる途中は、つながない）
      if (Math.abs(Math.hypot(m[q], m[q + 1], m[q + 2]) - sx) > sx * 0.04 || Math.abs(Math.hypot(m[q + 8], m[q + 9], m[q + 10]) - sz) > sz * 0.04) continue;
      const d = [m[q + 12] - m[o + 12], m[q + 13] - m[o + 13], m[q + 14] - m[o + 14]];
      const u = (d[0] * ax[0] + d[1] * ax[1] + d[2] * ax[2]) / sx, v = (d[0] * ay[0] + d[1] * ay[1] + d[2] * ay[2]) / sy;
      const w = (d[0] * az[0] + d[1] * az[1] + d[2] * az[2]) / sz;
      if (Math.abs(w) > sz * 0.04) continue;
      for (const [along, side, across, size] of [[u, 0, v, sx], [v, 2, u, sy]]) {
        const a = Math.abs(along);
        // 辺どうしで隣り合う（横へのずれはほとんど無く、間はマスの間のすき間ほど）
        if (Math.abs(across) > size * 0.05 || a < size * 0.96 || a > size * 1.2) continue;
        const k = i * 4 + side + (along > 0 ? 0 : 1);
        out[k] = Math.max(out[k], (a / 2 - size / 2) / size + 0.004);
      }
    }
  }
  return out;
}

/**
 * 影・光の地図用の「つなぐ」: 同じ色で辺どうし隣り合う立方体（マス単位。list の要素は [x, r, half, z0, height, tint]）の間のすき間を、
 * ひとつの塊として扱えるよう埋める。返り値は 4 個ずつ（-x, +x, -r, +r へ伸ばす長さ）
 */
export function causJoins(list) {
  const out = new Float32Array(Math.max(list.length, 1) * 4);
  for (let i = 0; i < list.length; i++) {
    const [x, r, half, z0, h, tint] = list[i];
    for (let j = 0; j < list.length; j++) {
      if (i === j) continue;
      const [x2, r2, half2, z02, h2, tint2] = list[j];
      if (tint[0] !== tint2[0] || tint[1] !== tint2[1] || tint[2] !== tint2[2]) continue;
      if (Math.abs(half - half2) > half * 0.04 || Math.abs(z0 - z02) > 0.04 || Math.abs(h - h2) > h * 0.04) continue;
      const dx = x2 - x, dr = r2 - r;
      for (const [along, across, side] of [[dx, dr, 0], [dr, dx, 2]]) {
        const a = Math.abs(along);
        if (Math.abs(across) > 0.05 || a < half * 2 * 1.02 || a > 1.25) continue;
        const k = i * 4 + side + (along > 0 ? 1 : 0);
        out[k] = Math.max(out[k], (a - 2 * half) / 2 + 0.004);
      }
    }
  }
  return out;
}

/** 立方体の行列（列優先 16 個）: 底の中心 (x, y, z)、大きさ (sx, sy, sz)、z 軸まわりの角度 a、追加の回転（3×3 の行列。省略可） */
function cubeMatrix(x, y, z, sx, sy, sz, a, tilt = null) {
  const c = Math.cos(a), s = Math.sin(a);
  let ax = [c, s, 0], ay = [-s, c, 0], az = [0, 0, 1];
  let cz = [0, 0, sz / 2];
  if (tilt) {
    const mul = (v) => [0, 1, 2].map((i) => tilt[i] * v[0] + tilt[i + 3] * v[1] + tilt[i + 6] * v[2]);
    ax = mul(ax); ay = mul(ay); az = mul(az); cz = mul(cz);
  }
  return [
    ax[0] * sx, ax[1] * sx, ax[2] * sx, 0,
    ay[0] * sy, ay[1] * sy, ay[2] * sy, 0,
    az[0] * sz, az[1] * sz, az[2] * sz, 0,
    x + cz[0], y + cz[1], z + cz[2], 1,
  ];
}

const QUARTER = Math.PI / 4;
const easeOutBack = cubicBezier(0.3, 1.6, 0.5, 1);
const easeTrayIn = cubicBezier(0.3, 1.5, 0.5, 1);
const LAND = [[0, [1.12, 0.8]], [0.24, [0.95, 1.06]], [0.58, [1.02, 0.985]], [1, [1, 1]]];
const LAND_FIT = [[0, [1.14, 0.74]], [0.22, [0.93, 1.1]], [0.56, [1.045, 0.97]], [0.78, [0.995, 1.005]], [1, [1, 1]]];
const AC_GEM = [[0, 0], [0.16, 1.14], [0.26, 1], [0.64, 1], [0.72, 1.2], [1, 0]];
const TINT = [[0, 0], [0.26, 1.06], [0.4, 1], [0.6, 1], [1, 0]];

/** WebGL2 と、明るさを 1 より大きく持てる描き先（半精度の浮動小数点）が使えるか（three.js を読み込む前に確かめる） */
export function supported() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return false;
    const ok = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return ok;
  } catch { return false; }
}

/** 描き先のひとそろい（背景・本体・コピー・ブルーム）。画面用と、シェア画像・プレビュー用に別々に持つ */
class Targets {
  constructor(w, h, samples, bloom) {
    const opt = { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false, generateMipmaps: false };
    this.w = w; this.h = h;
    this.bg = new THREE.WebGLRenderTarget(w, h, opt);
    this.main = new THREE.WebGLRenderTarget(w, h, { ...opt, depthBuffer: true, samples });
    this.copy = null;
    this.blooms = [];
    if (bloom) {
      let bw = w, bh = h;
      for (let i = 0; i < 5; i++) {
        bw = Math.max(1, Math.round(bw / 2)); bh = Math.max(1, Math.round(bh / 2));
        this.blooms.push(new THREE.WebGLRenderTarget(bw, bh, opt));
      }
    }
    this.opt = opt;
  }
  copyTarget() { return this.copy ??= new THREE.WebGLRenderTarget(this.w, this.h, this.opt); }
  dispose() { for (const t of [this.bg, this.main, this.copy, ...this.blooms, ...(this.temps ?? [])]) t?.dispose(); }
}

/** 品質の段階（重い端末では自動で下げる）: 描く細かさの上限・MSAA・ブルーム・中での反射の回数・分光 */
const QUALITY = [
  { dpr: 2, samples: 4, bloom: true, bounces: 3, disp: true },
  { dpr: 1.75, samples: 4, bloom: true, bounces: 3, disp: false },
  { dpr: 1.5, samples: 2, bloom: true, bounces: 2, disp: false },
  { dpr: 1.25, samples: 0, bloom: false, bounces: 2, disp: false },
  { dpr: 1, samples: 0, bloom: false, bounces: 1, disp: false },
];

export class Cube3D {
  /** dom = 2D の Renderer（ブロックの位置 el.__pos と色 el.__color を読む） */
  constructor(dom, { software = false } = {}) {
    this.dom = dom;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'gl-board';
    this.canvas.setAttribute('aria-hidden', 'true');
    this.canvas.hidden = true;
    document.body.insertBefore(this.canvas, document.getElementById('app'));
    const gl = this.gl = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: false, alpha: false, depth: true, stencil: false, powerPreference: 'high-performance', preserveDrawingBuffer: false });
    gl.autoClear = false;
    gl.outputColorSpace = THREE.LinearSRGBColorSpace;
    gl.toneMapping = THREE.NoToneMapping;
    this.quality = software ? 3 : 0;
    this.viewAngle = VIEW_ANGLE;
    this.frameMs = 16.7; this.slowFrames = 0;
    this.lost = false; this.failed = false;
    // 端末が WebGL を取り上げた（アプリの切り替え・メモリ不足など）・シェーダーが動かない → 2D の見た目に戻す（main.js の onLost）
    this.canvas.addEventListener('webglcontextlost', (e) => { e.preventDefault(); this.lost = true; this.onLost?.(); });
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.lost = false;
      this.targets?.dispose(); this.targets = null;
      for (const t of [...this.causTargets.values(), ...this.sdfTargets.values(), ...this.nbTargets.values()]) t.dispose();
      this.causTargets.clear(); this.sdfTargets.clear(); this.nbTargets.clear();
      if (!this.failed) this.onRestored?.();
    });
    gl.debug.onShaderError = (g, program, vs, fs) => {
      console.error('cube3d: shader error', g.getShaderInfoLog(vs), g.getShaderInfoLog(fs), g.getProgramInfoLog(program));
      this.failed = true;
      this.onLost?.();
    };
    this.motion = window.matchMedia?.('(prefers-reduced-motion: reduce)');

    const cube = roundedCube();
    this.shared = this.makeUniforms();
    const glass = (defines = {}, blending = THREE.NoBlending, transparent = false) => new THREE.ShaderMaterial({
      uniforms: { ...this.shared, uProj: { value: new THREE.Matrix4() }, uBgProj: { value: new THREE.Matrix4() }, uBg: { value: null }, uBackLight: { value: new THREE.Vector3() },
        uNeighbors: { value: null }, uNbRect: { value: new THREE.Vector4() }, uNbOn: { value: 0 } },
      vertexShader: GLASS_VERT, fragmentShader: GLASS_FRAG, defines, blending, transparent, depthWrite: !transparent, depthTest: true,
    });
    this.mats = {
      board: glass(), ui: glass(), ghost: glass({}, THREE.NormalBlending, true), drag: glass(),
    };
    this.mats.ui.uniforms.uBackLight.value.set(...LOOK.backLight);

    this.mats.drag.uniforms.uBackLight.value.set(...LOOK.backLight.map((v) => v * 0.45));
    this.batches = {
      board: new Batch(cube, this.mats.board, 160),
      ui: new Batch(cube, this.mats.ui, 40),
      ghost: new Batch(cube, this.mats.ghost, 16),
      drag: new Batch(cube, this.mats.drag, 16),
    };
    this.scene = new THREE.Scene();
    this.scene.add(this.batches.board.mesh, this.batches.ui.mesh, this.batches.ghost.mesh);
    this.dragScene = new THREE.Scene();
    this.dragScene.add(this.batches.drag.mesh);
    this.batches.ghost.mesh.renderOrder = 2;
    this.camera = new THREE.Camera();
    this.camera.matrixAutoUpdate = false;
    this.camera.matrixWorldAutoUpdate = false;

    // コースティクスの地図
    const quad = new THREE.PlaneGeometry(1, 1);
    this.causGeo = quad;
    this.causCap = 96;
    const cg = quad.clone();
    this.causCube = new THREE.InstancedBufferAttribute(new Float32Array(this.causCap * 4), 4);
    this.causCube2 = new THREE.InstancedBufferAttribute(new Float32Array(this.causCap * 4), 4);
    this.causTint = new THREE.InstancedBufferAttribute(new Float32Array(this.causCap * 3), 3);
    this.causExt = new THREE.InstancedBufferAttribute(new Float32Array(this.causCap * 4), 4);
    cg.setAttribute('iExt', this.causExt);
    cg.setAttribute('iCube', this.causCube); cg.setAttribute('iCube2', this.causCube2); cg.setAttribute('iTint', this.causTint);
    this.causMat = new THREE.ShaderMaterial({
      uniforms: { uL: { value: new THREE.Vector3() }, uRect: { value: new THREE.Vector4() } },
      vertexShader: CAUS_VERT, fragmentShader: CAUS_FRAG, depthTest: false, depthWrite: false,
      // 掛け算で重ねる（結果 = 描く値 × 今の値）。重なった影は濃く、集まった光は明るくなる
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
    });
    this.causMesh = new THREE.InstancedMesh(cg, this.causMat, this.causCap);
    this.causMesh.frustumCulled = false;
    this.causMesh.count = 0;
    this.causScene = new THREE.Scene();
    this.causScene.add(this.causMesh);
    // 隣の立方体の色の地図（コースティクスと同じ立方体の並びを、別の塗り方で描く）
    this.nbMat = new THREE.ShaderMaterial({
      uniforms: { uRect: { value: new THREE.Vector4() } }, vertexShader: NB_VERT, fragmentShader: NB_FRAG, depthTest: false, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.ZeroFactor, blendDst: THREE.SrcColorFactor,
      blendEquationAlpha: THREE.AddEquation, blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.SrcAlphaFactor,
    });
    this.nbMesh = new THREE.InstancedMesh(cg, this.nbMat, this.causCap);
    this.nbMesh.frustumCulled = false;
    this.nbMesh.count = 0;
    this.nbScene = new THREE.Scene();
    this.nbScene.add(this.nbMesh);
    this.nbTargets = new Map();
    this.causTargets = new Map();                      // 解像度ごと

    // 盤面に満ちる色（8×8 のマスごとに 色・大きさ）
    this.tintData = new Float32Array(SIZE * SIZE * 4);
    this.tintTex = new THREE.DataTexture(this.tintData, SIZE, SIZE, THREE.RGBAFormat, THREE.FloatType);
    this.tintTex.needsUpdate = true;

    // 画面いっぱいの 1 枚の三角形で描くもの
    const fs = new THREE.BufferGeometry();
    fs.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3));
    this.fsMesh = new THREE.Mesh(fs);
    this.fsMesh.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.fsMesh);
    const fsMat = (frag, uniforms) => new THREE.ShaderMaterial({ uniforms, vertexShader: FS_VERT, fragmentShader: frag, depthTest: false, depthWrite: false, blending: THREE.NoBlending });
    this.bgMat = fsMat(BG_FRAG, {
      ...this.shared,
      uView: { value: new THREE.Vector4() }, uRes: { value: new THREE.Vector2() }, uEyeW: { value: new THREE.Vector4() },
      uImgInv: { value: new THREE.Matrix3() }, uCell: { value: 40 }, uSize: { value: SIZE }, uStretch: { value: STRETCH_Y },
      uSdf: { value: null }, uSdfRect: { value: new THREE.Vector4() },
      uThick: { value: 10 }, uWall: { value: 60 }, uCaustic: { value: null }, uOcc: { value: null }, uCausRect: { value: new THREE.Vector4() }, uTints: { value: this.tintTex },
      uPlate: { value: new THREE.Vector3(...LOOK.plate) }, uPlateEdge: { value: new THREE.Vector3(...LOOK.plateEdge) }, uPlateGlow: { value: new THREE.Vector3(...LOOK.plateGlow) },
      uBackTop: { value: new THREE.Vector3(...LOOK.backTop) }, uBackMid: { value: new THREE.Vector3(...LOOK.backMid) },
      uBackBottom: { value: new THREE.Vector3(...LOOK.backBottom) }, uBackGlow: { value: new THREE.Vector3(...LOOK.backGlow) },
      uTrayGlow: { value: new THREE.Vector3(...LOOK.trayGlow) }, uTrayAt: { value: [0, 1, 2].map(() => new THREE.Vector3(-1e4, -1e4, 1)) },
    });
    this.copyMat = fsMat(COPY_FRAG, { uTex: { value: null } });
    this.sdfMat = fsMat(SDF_FRAG, { uPoly: { value: Array.from({ length: 18 }, () => new THREE.Vector2()) }, uPolyN: { value: 0 }, uRound: { value: 0.22 }, uRect: { value: new THREE.Vector4() } });
    this.sdfTargets = new Map();                     // 段数ごとの板の外形の地図
    this.brightMat = fsMat(BRIGHT_FRAG, { uTex: { value: null }, uTexel: { value: new THREE.Vector2() }, uThreshold: { value: LOOK.bloomThreshold } });
    this.downMat = fsMat(DOWN_FRAG, { uTex: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.upMat = fsMat(UP_FRAG, { uTex: { value: null }, uBase: { value: null }, uTexel: { value: new THREE.Vector2() } });
    this.compMat = fsMat(COMPOSITE_FRAG, { uTex: { value: null }, uBloom: { value: null }, uBloomK: { value: LOOK.bloom }, uRes: { value: new THREE.Vector2() }, uAlpha: { value: 0 }, toneMappingExposure: { value: LOOK.exposure } });
    this.blackTex = new THREE.DataTexture(new Float32Array(4), 1, 1, THREE.RGBAFormat, THREE.FloatType);
    this.blackTex.needsUpdate = true;

    // 状態
    this.anim = new Map();          // ブロックの id → { land, charge, fly }
    this.preview = null;            // 仮置き
    this.tints = [];                // 盤面に満ちる色
    this.gems = [];                 // 全消しの宝石
    this.tray = [];                 // 手駒
    this.trayHint = -1;
    this.dragging = -1;
    this.dragState = null;
    this.lastDrop = null;
    this.clock = 0; this.lastNow = 0; this.paused = false;
    this.speed = 1;                 // 演出の時計の速さ（確かめるときのスロー再生用）
    this.raf = 0; this.activeUntil = 0; this.lastDraw = 0; this.gentle = false; this.dirty = false;
    this.frame = this.frame.bind(this);
  }

  makeUniforms() {
    const v3 = (a) => ({ value: new THREE.Vector3(...a) });
    const key = panel(KEY_DIR), rim = panel(RIM_DIR), rim2 = panel(RIM2_DIR), fill = panel(FILL_DIR), floor = panel(FLOOR_DIR, [0, 0, 1]);
    return {
      uEnvLo: v3(LOOK.envLo), uEnvMid: v3(LOOK.envMid), uEnvHi: v3(LOOK.envHi),
      uKeyC: v3(key.c), uKeyU: v3(key.u), uKeyV: v3(key.v), uKeyCol: v3(LOOK.key),
      uRimC: v3(rim.c), uRimU: v3(rim.u), uRimV: v3(rim.v), uRimCol: v3(LOOK.rim),
      uRim2C: v3(rim2.c), uRim2U: v3(rim2.u), uRim2V: v3(rim2.v), uRim2Col: v3(LOOK.rim2),
      uFloorC: v3(floor.c), uFloorU: v3(floor.u), uFloorV: v3(floor.v), uFloorCol: v3(LOOK.floor),
      uFillC: v3(fill.c), uFillU: v3(fill.u), uFillV: v3(fill.v), uFillCol: v3(LOOK.fill),
      uSunC: v3(SUN_DIR), uSunCol: v3(LOOK.sun),
      uSweepC: v3([0, 0, 1]), uSweepU: v3([1, 0, 0]), uSweepV: v3([0, 1, 0]), uSweepCol: v3([0, 0, 0]),
      uKeyDir: v3(KEY_DIR), uKeyIrr: v3(LOOK.keyIrr), uAmb: v3(LOOK.amb),
      uEye: v3([0, 0, 1000]), uIor: { value: IOR }, uDisp: { value: DISPERSION }, uBevel: { value: BEVEL },
      uCube: { value: 30 }, uBounces: { value: 3 }, uLaneLight: v3(LOOK.backLight.map((x) => x * 0.85)),
      uBoard: { value: new THREE.Vector2(30, SIZE) },
    };
  }

  /**
   * シェーダーを前もって組み立てておく（最初に描く瞬間に画面が止まらないように。対応している端末では別のスレッドで）。1 回だけ
   */
  prepare() {
    return this.prepared ??= (async () => {
      const warm = new THREE.Scene();
      const add = (geo, mat, inst) => { const m = inst ? new THREE.InstancedMesh(geo, mat, 1) : new THREE.Mesh(geo, mat); m.frustumCulled = false; warm.add(m); };
      for (const k of Object.keys(this.mats)) add(this.batches[k].geometry, this.mats[k], true);
      add(this.causMesh.geometry, this.causMat, true);
      add(this.causMesh.geometry, this.nbMat, true);
      for (const m of [this.bgMat, this.copyMat, this.sdfMat, this.brightMat, this.downMat, this.upMat, this.compMat]) add(this.fsMesh.geometry, m, false);
      try { await this.gl.compileAsync(warm, this.camera); } catch (e) { console.warn(e); }
    })();
  }

  /* ---------- 画面に出す・外す ---------- */
  attach() {
    this.attached = true;
    this.canvas.hidden = false;
    this.layout();
    this.invalidate();
  }
  detach() {
    this.attached = false;
    this.canvas.hidden = true;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.targets?.dispose(); this.targets = null;       // 使わない間は描き先のメモリを返す
  }

  /** 画面の大きさ・盤面の位置が変わった（renderer.layout から） */
  layout() {
    if (!this.attached || this.lost || this.failed) return;
    const q = QUALITY[this.quality];
    const vw = Math.max(1, document.documentElement.clientWidth || innerWidth), vh = Math.max(1, document.documentElement.clientHeight || innerHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, q.dpr);
    const w = Math.max(1, Math.round(vw * dpr)), h = Math.max(1, Math.round(vh * dpr));
    // 画面の密度が高いときは、ギザギザが目立たないので MSAA は 2 倍まで（描き先のメモリを 3 分の 2 ほどに）
    const samples = dpr >= 1.75 ? Math.min(2, q.samples) : q.samples;
    this.gl.setPixelRatio(1);
    this.gl.setSize(w, h, false);
    this.canvas.style.width = vw + 'px'; this.canvas.style.height = vh + 'px';
    if (!this.targets || this.targets.w !== w || this.targets.h !== h || this.targets.samples !== samples || !!this.targets.blooms.length !== q.bloom) {
      this.targets?.dispose();
      this.targets = new Targets(w, h, samples, q.bloom);
      this.targets.samples = samples;
    }
    this.view = this.measure(vw, vh);
    this.invalidate();
  }

  /** 盤面の中心の画面座標（変形していない位置。弾む・揺れるは毎フレーム別に読む） */
  measure(vw, vh) {
    const d = this.dom;
    let x = 0, y = 0;
    for (let el = d.wrap; el; el = el.offsetParent) { x += el.offsetLeft; y += el.offsetTop; }
    return { vw, vh, cx: x + d.wrapW / 2, cy: y + d.topY, cell: d.cell, W: d.W, wrapX: x, wrapY: y, wrapW: d.wrapW, wrapH: parseFloat(d.wrap.style.height) || 0 };
  }

  /* ---------- 描く時機 ---------- */
  /** 次のフレームで描く（ms = この先しばらく描き続ける長さ） */
  invalidate(ms = 0) {
    if (!this.attached) return;
    this.dirty = true;
    if (ms > 0) this.activeUntil = Math.max(this.activeUntil, performance.now() + ms);
    if (!this.raf) this.raf = requestAnimationFrame(this.frame);
  }
  setPaused(on) {
    this.paused = on;
    if (!on) this.invalidate();
  }
  /** 演出用の時計（一時停止中は進まない） */
  tick(now) {
    if (this.lastNow && !this.paused) this.clock += Math.min(100, now - this.lastNow) * this.speed;
    this.lastNow = now;
    return this.clock;
  }

  frame(now) {
    this.raf = 0;
    if (!this.attached || this.lost || this.failed) return;
    // ゆっくり弾む手駒（学習モードのおすすめ）だけが動いている間は、30 コマ/秒で十分（電池を減らさない）
    if (this.gentle && !this.dirty && now < this.lastDraw + 30 && now >= this.activeUntil) {
      this.raf = requestAnimationFrame(this.frame);
      return;
    }
    this.dirty = false;
    const dt = this.prevFrame ? now - this.prevFrame : 0;
    this.prevFrame = now;
    const t = this.tick(now);
    const busy = this.render(t);
    this.lastDraw = now;
    this.frames = (this.frames || 0) + 1;
    if (this.paused) { this.prevFrame = 0; return; }        // 一時停止中は止まった絵を 1 回描くだけ（再開で invalidate）
    if (busy || now < this.activeUntil) {
      this.adapt(dt);
      this.raf = requestAnimationFrame(this.frame);
    } else if (this.gentle) {
      this.prevFrame = 0; this.slowFrames = 0;
      this.raf = requestAnimationFrame(this.frame);
    } else { this.prevFrame = 0; this.slowFrames = 0; }
  }

  /** 描き続けている間のフレームの時間を測り、続けて遅いときは品質を 1 段下げる（上げ直しはしない） */
  adapt(dt) {
    if (!dt || dt > 250) return;
    this.frameMs += (dt - this.frameMs) * 0.06;
    if (this.frameMs > 24 && this.quality < QUALITY.length - 1) {
      if (++this.slowFrames > 45) { this.quality++; this.slowFrames = 0; this.frameMs = 16.7; this.layout(); }
    } else this.slowFrames = Math.max(0, this.slowFrames - 1);
  }

  /* ---------- 2D の Renderer から届くできごと ---------- */
  state(id) { let s = this.anim.get(id); if (!s) this.anim.set(id, s = {}); return s; }
  /** 置いたブロックが着地する（持っていたピースの位置から落ちてくる） */
  land(list, fit) {
    // 離した直後（同じ操作の続き）なら、持っていたピースの位置から落とす
    const drop = this.lastDrop && performance.now() - this.lastDrop.at < 150 && this.lastDrop.cubes.length === list.length ? this.lastDrop : null;
    list.forEach(({ id, delay }, i) => { this.state(id).land = { t0: this.clock, delay, fit, from: drop?.cubes[i] ?? null }; });
    this.lastDrop = null;
    this.invalidate(700);
  }
  charge(ids, ms) {
    for (const id of ids) this.state(id).charge = ms > 0 ? { t0: this.clock, ms } : null;
    this.invalidate(ms + 50);
  }
  fly(id) { this.state(id).fly = { t0: this.clock }; this.invalidate(300); }
  /** 仮置き: { cells: [{x, r}], color, strong, fit, hi: [{x, r}], fresh } か null */
  setPreview(p) {
    if (p && this.preview && p.key === this.preview.key) { this.preview.strong = p.strong; this.invalidate(); return; }
    this.preview = p ? { ...p, t0: this.clock } : null;
    this.invalidate(p ? 400 : 0);
  }
  tint(x, r, color, delay, life) {
    this.tints = this.tints.filter((t) => t.x !== x || t.r !== r);
    this.tints.push({ x, r, color, t0: this.clock + delay, life });
    this.invalidate(delay + life + 50);
  }
  gem(x, r, color, delay, life) { this.gems.push({ x, r, color, t0: this.clock + delay, life }); this.invalidate(delay + life + 50); }
  /** ラインが消えた・全消し: ガラスの面に映る光の帯が、左から右へ横切る（k = 強さ） */
  sweep(k = 1) {
    if (this.motion?.matches) return;
    this.sweeping = { t0: this.clock, k };
    this.invalidate(SWEEP_MS + 50);
  }
  clearGems() { this.gems = []; this.invalidate(); }
  reset() {
    this.anim.clear(); this.preview = null; this.tints = []; this.gems = []; this.lastDrop = null; this.sweeping = null;
    this.tintData.fill(0); this.tintTex.needsUpdate = true;
    this.invalidate();
  }
  /** 手駒: [{ cells, color, s（1 マスの大きさ）, center: {x, y}（形の中心の画面座標）, width, height } | null]×3 */
  setTray(slots, enter) {
    this.tray = slots.map((s, i) => s && { ...s, t0: enter ? this.clock + i * 60 : -1e9 });
    this.invalidate(enter ? 600 : 0);
  }
  setTrayState({ dragging = this.dragging, hint = this.trayHint } = {}) {
    this.dragging = dragging; this.trayHint = hint;
    this.invalidate();
  }
  /** 持っているピース: { piece, x, y }（形の中心の画面座標）か null */
  drag(d) {
    if (!d) {
      if (this.dragState?.cubes) this.lastDrop = { at: performance.now(), cubes: this.dragState.cubes };
      this.dragState = null;
      this.invalidate();
      return;
    }
    const s = this.dragState, now = performance.now();
    if (!s || s.piece !== d.piece) this.dragState = { piece: d.piece, x: d.x, y: d.y, t0: this.clock, vx: 0, vy: 0, tx: 0, ty: 0, lastT: now };
    else {
      const dt = Math.max(4, now - s.lastT);
      s.vx += ((d.x - s.x) / dt - s.vx) * 0.4; s.vy += ((d.y - s.y) / dt - s.vy) * 0.4;
      s.x = d.x; s.y = d.y; s.lastT = now;
    }
    this.invalidate(400);
  }

  /* ---------- 1 フレーム ---------- */
  /** 盤面の画面上の変形（2D の弾む・寄る・揺れると同じ値を DOM から読む）。動いていなければ null */
  imageTransform() {
    const d = this.dom, on = (a) => a && (a.playState === 'running' || a.playState === 'paused');
    if (!on(d._bounce) && !on(d._punch) && !on(d._shake)) return null;
    const num = (v, i = 0) => { if (!v || v === 'none') return i ? 0 : 1; const p = v.split(/\s+/).map(parseFloat); return p[Math.min(i, p.length - 1)]; };
    const pcs = getComputedStyle(d.pf), wcs = getComputedStyle(d.wrap);
    const kb = num(pcs.scale), kp = num(wcs.scale);
    const tr = (wcs.translate || 'none'), tx = tr === 'none' ? 0 : num(tr, 0), ty = tr === 'none' ? 0 : num(tr, 1);
    const v = this.view, wcx = v.wrapX + v.wrapW / 2, wcy = v.wrapY + v.wrapH / 2;
    // 盤面の中心まわりに kb 倍 → rotWrap の中心まわりに kp 倍 → 平行移動
    const a = kb * kp;
    const ox = kp * ((1 - kb) * v.cx) + (1 - kp) * wcx + tx, oy = kp * ((1 - kb) * v.cy) + (1 - kp) * wcy + ty;
    return [a, 0, 0, a, ox, oy];
  }

  /** 通常デザインと同じ色・所要時間を受け取り、屈折に使う背景も一緒に変える。 */
  setBackground(look, ms = 0) {
    const now = performance.now();
    this.updateBackground(now); // 途中で次の色が来ても、いま見えている色から続ける
    const colors = {
      uBackTop: srgb(look.lo), uBackMid: srgb(look.hi), uBackBottom: srgb(look.lo),
      uBackGlow: srgb(look.hi, 0.25), uTrayGlow: srgb(look.hi, 0.16),
    };
    const entries = Object.entries(colors).map(([key, rgb]) => {
      const value = this.bgMat.uniforms[key].value;
      return { value, from: value.clone(), to: new THREE.Vector3(...rgb) };
    });
    this.backgroundFade = { start: now, ms, entries };
    this.updateBackground(now);
    this.invalidate(ms);
  }

  updateBackground(now = performance.now()) {
    const fade = this.backgroundFade;
    if (!fade) return false;
    const t = fade.ms > 0 ? Math.min(1, Math.max(0, (now - fade.start) / fade.ms)) : 1;
    const eased = t * t * (3 - 2 * t);
    for (const { value, from, to } of fade.entries) value.lerpVectors(from, to, eased);
    if (t === 1) this.backgroundFade = null;
    return t < 1;
  }

  render(now) {
    const v = this.view, T = this.targets;
    if (!v || !T) return false;
    const eye = eyeFor(v.cell, this.viewAngle);
    const img = this.imageTransform();
    const run = (a) => a && a.playState === 'running';
    let busy = run(this.dom._bounce) || run(this.dom._punch) || run(this.dom._shake);
    busy = this.collect(now, v, eye) || busy;
    busy = this.updateTints(now) || busy;
    busy = this.updateSweep(now) || busy;
    busy = this.updateBackground() || busy;
    this.draw({ view: v, eye, img, size: SIZE, quality: QUALITY[this.quality], tray: true }, T, null);
    return busy;
  }

  /**
   * 集めた立方体を描く。f = { view, eye, img（盤面の画面上の変形）, size（盤面の段数）, quality, tray（手駒の後ろの光を出すか） }、
   * T = 描き先のひとそろい、out = 最後に書く先（null = 画面）
   */
  draw(f, T, out) {
    const { view: v, eye, img, size, quality: q } = f;
    const gl = this.gl, c = v.cell, cube = CUBE * c;
    const near = Math.max(1, eye.ez - cube * 6), far = eye.ez + 4000;
    const m4 = (m) => new THREE.Matrix4().set(...m);
    const PB = m4(projection(v, eye, near, far, img)), PU = m4(projection(v, eye, near, far));
    this.shared.uEye.value.set(eye.ex, eye.ey / STRETCH_Y, eye.ez);
    this.shared.uCube.value = cube;
    this.shared.uBounces.value = q.bounces;
    this.shared.uDisp.value = q.disp ? DISPERSION : 0;
    // コースティクス
    const caus = this.renderCaustics(f.causRes ?? 256, size);
    // 背景と盤面
    const bg = this.bgMat.uniforms;
    bg.uView.value.set(v.vw, v.vh, v.cx, v.cy);
    bg.uRes.value.set(T.w, T.h);
    bg.uEyeW.value.set(eye.ex, eye.ey, eye.ez, eye.zRef);
    bg.uCell.value = c; bg.uSize.value = size;
    this.setPlate(size);
    bg.uThick.value = cube * 0.42; bg.uWall.value = cube * 1.6;
    for (let i = 0; i < 3; i++) {
      const t = f.tray ? this.tray[i] : null;
      if (t && i !== this.dragging) bg.uTrayAt.value[i].set(t.center.x, t.center.y, t.s * Math.max(t.width, t.height) * 0.72 + t.s * 0.4);
      else bg.uTrayAt.value[i].set(-1e4, -1e4, 1);
    }
    bg.uCaustic.value = caus.texture; bg.uOcc.value = this.nbTexture; bg.uCausRect.value.copy(this.causRect);
    const inv = img ? invertAffine(img) : [1, 0, 0, 1, 0, 0];
    bg.uImgInv.value.set(inv[0], inv[1], inv[4], inv[2], inv[3], inv[5], 0, 0, 1);
    this.pass(this.bgMat, T.bg);
    // 立方体
    for (const [k, P] of [['board', PB], ['ghost', PB], ['ui', PU], ['drag', PU]]) {
      const u = this.mats[k].uniforms;
      u.uProj.value.copy(P);
      u.uBgProj.value.copy(PB);
      u.uBg.value = T.bg.texture;
    }
    this.mats.ui.uniforms.uBgProj.value.copy(PU);
    this.shared.uBoard.value.set(c, size);
    for (const k of ['board', 'ghost']) {
      const u = this.mats[k].uniforms;
      u.uNeighbors.value = this.nbTexture; u.uNbRect.value.copy(this.causRect); u.uNbOn.value = 1;
    }
    for (const k of ['ui', 'drag']) { const u = this.mats[k].uniforms; u.uNeighbors.value = this.nbTexture; u.uNbOn.value = 0; }
    gl.setRenderTarget(T.main);
    gl.setClearColor(0x000000, f.alpha ? 0 : 1);
    gl.clear(true, true, false);
    if (!f.alpha) {                                    // 透明な絵（かけら）のときは、背景を描かない
      this.copyMat.uniforms.uTex.value = T.bg.texture;
      this.fsMesh.material = this.copyMat;
      gl.render(this.fsScene, this.camera);
    }
    gl.render(this.scene, this.camera);
    if (this.batches.drag.n) {
      // 持っているピースは、盤面の立方体まで描いた絵を透かして見せる
      const copy = T.copyTarget();
      this.pass(this.copyMat, copy, { uTex: T.main.texture });
      this.mats.drag.uniforms.uBg.value = copy.texture;
      gl.setRenderTarget(T.main);
      gl.render(this.dragScene, this.camera);
    }
    // ブルーム → 画面
    let bloom = this.blackTex;
    if (T.blooms.length) bloom = this.renderBloom(T);
    const cu = this.compMat.uniforms;
    cu.uTex.value = T.main.texture; cu.uBloom.value = bloom; cu.uRes.value.set(T.w, T.h); cu.uAlpha.value = f.alpha ? 1 : 0;
    this.pass(this.compMat, out);
  }

  /** 色ごとの、ガラスの立方体 1 個の小さな絵（かけら・紙吹雪に使う。shards.js の useSprites）。px = 絵の大きさ */
  sprites(px = 64) {
    const map = new Map();
    for (const name of ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple']) map.set(name, this.renderPiece([[0, 0]], name, px, px));
    this.invalidate();
    return map;
  }
  /** ピース（cells = [[x, y], …]）を手駒と同じ見え方で、背景の無い絵にする */
  renderPiece(cells, color, width, height) {
    const xs = cells.map(([x]) => x), ys = cells.map(([, y]) => y);
    const pw = Math.max(...xs) + 1, ph = Math.max(...ys) + 1;
    const cell = Math.min(width, height) / ((pw + ph) * Math.SQRT1_2 * 1.08);
    const view = { vw: width, vh: height, cx: width / 2, cy: height / 2, cell, W: cell, wrapX: 0, wrapY: 0, wrapW: width, wrapH: height };
    const eye = eyeFor(cell, this.viewAngle), cube = CUBE * cell;
    for (const b of Object.values(this.batches)) b.begin();
    this.caus = [];
    for (const [x, y] of cells) {
      const lx = (x + 0.5 - pw / 2) * cell, ly = (y + 0.5 - ph / 2) * cell;
      const b = unprojectClient(view, eye, width / 2 + Math.SQRT1_2 * (ly - lx), height / 2 - Math.SQRT1_2 * (lx + ly), cube / 2);
      this.batches.ui.push(cubeMatrix(b.x, b.y, 0, cube, cube, cube, QUARTER), glassOf(color), [1, 0, 0, 0]);
    }
    for (const b of Object.values(this.batches)) b.end();
    const T = new Targets(width, height, 4, false);
    const out = new THREE.WebGLRenderTarget(width, height, { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false });
    const back = this.mats.ui.uniforms.uBackLight.value, keep = back.clone();
    back.multiplyScalar(0.45);                        // 背景が透明な分、後ろの光は弱めに（色を濃く見せる）
    this.draw({ view, eye, img: null, size: 0, quality: QUALITY[0], tray: false, alpha: true, causRes: 64 }, T, out);
    back.copy(keep);
    const px = new Uint8Array(width * height * 4);
    this.gl.readRenderTargetPixels(out, 0, 0, width, height, px);
    T.dispose(); out.dispose();
    this.gl.setRenderTarget(null);
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const g = cv.getContext('2d'), im = g.createImageData(width, height), row = width * 4;
    for (let y = 0; y < height; y++) {
      const src = (height - 1 - y) * row, dst = y * row;
      for (let i = 0; i < row; i += 4) {
        const a = px[src + i + 3];
        // ふちは背景（透明）と混ざって暗くなっているので、不透明度で割って元の色に戻す
        const k = a ? 255 / a : 0;
        im.data[dst + i] = Math.min(255, px[src + i] * k); im.data[dst + i + 1] = Math.min(255, px[src + i + 1] * k);
        im.data[dst + i + 2] = Math.min(255, px[src + i + 2] * k); im.data[dst + i + 3] = a;
      }
    }
    g.putImageData(im, 0, 0);
    return cv;
  }

  /**
   * 盤面だけを 1 枚の絵にする（結果のシェア画像・一時停止の「盤面の種類」の見本）。
   * o = { width, height（画素）, cx, cy（盤面の中心の位置）, cell, size（段数）, blocks: [[x, r, 色], …] }。canvas を返す
   */
  snapshot(o) {
    const { width, height, cell, size = SIZE } = o;
    const view = { vw: width, vh: height, cx: o.cx, cy: o.cy, cell, W: size * cell, wrapX: 0, wrapY: 0, wrapW: width, wrapH: height };
    const eye = eyeFor(cell, this.viewAngle), cube = CUBE * cell;
    for (const b of Object.values(this.batches)) b.begin();
    this.caus = [];
    for (const [x, r, color] of o.blocks) {
      const b = localToB((x + 0.5) * cell, (r + 0.5) * cell, view.W), tint = glassOf(color);
      this.batches.board.push(cubeMatrix(b.x, b.y, 0, cube, cube, cube, QUARTER), tint, [1, 0, 0, 0]);
      this.addCaustic(x + 0.5, r + 0.5, CUBE / 2, 0, CUBE, tint);
    }
    for (const b of Object.values(this.batches)) b.end();
    this.tintData.fill(0); this.tintTex.needsUpdate = true;
    const T = new Targets(width, height, width * height > 600000 ? 2 : 4, true);
    const opt = { type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false };
    const out = new THREE.WebGLRenderTarget(width, height, opt);
    this.draw({ view, eye, img: null, size, quality: QUALITY[0], tray: false, causRes: 512 }, T, out);
    const px = new Uint8Array(width * height * 4);
    this.gl.readRenderTargetPixels(out, 0, 0, width, height, px);
    T.dispose(); out.dispose();
    this.gl.setRenderTarget(null);
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const g = cv.getContext('2d'), im = g.createImageData(width, height), row = width * 4;
    for (let y = 0; y < height; y++) im.data.set(px.subarray((height - 1 - y) * row, (height - y) * row), y * row);
    g.putImageData(im, 0, 0);
    this.invalidate();                        // 画面の立方体は次のフレームで集め直す
    return cv;
  }

  pass(mat, target, uniforms = null) {
    if (uniforms) for (const k in uniforms) mat.uniforms[k].value = uniforms[k];
    this.fsMesh.material = mat;
    this.gl.setRenderTarget(target);
    this.gl.render(this.fsScene, this.camera);
  }

  renderBloom(T) {
    const b = T.blooms;
    const texel = (t) => new THREE.Vector2(1 / t.width, 1 / t.height);
    this.pass(this.brightMat, b[0], { uTex: T.main.texture, uTexel: texel(T.main) });
    for (let i = 1; i < b.length; i++) this.pass(this.downMat, b[i], { uTex: b[i - 1].texture, uTexel: texel(b[i - 1]) });
    // 広げながら足す（小さい方から）。足した結果は 1 つ大きい段に書くので、その段は一時的な置き場を使う
    let src = b[b.length - 1];
    for (let i = b.length - 2; i >= 0; i--) {
      const dst = this.bloomTemp(T, i);
      this.pass(this.upMat, dst, { uTex: src.texture, uBase: b[i].texture, uTexel: texel(src) });
      src = dst;
    }
    return src.texture;
  }
  bloomTemp(T, i) {
    T.temps ??= [];
    const b = T.blooms[i];
    return T.temps[i] ??= new THREE.WebGLRenderTarget(b.width, b.height, T.opt);
  }

  /** 盤面の板の外形の地図を用意して、背景のシェーダーに渡す（段数ごとに 1 回だけ描く） */
  setPlate(size) {
    const u = this.bgMat.uniforms, rect = [-3.5, -3.5, size + 4.5, size + 4.5];
    let t = this.sdfTargets.get(size);
    if (!t) {
      // CPU で計算して、半精度のテクスチャにする（GPU のシェーダーで多角形の内外判定をすると、一部の Android で狂うため）
      const res = 384, data = size >= 1 ? plateFieldData(platePolygon(size, 0.22), 0.22, rect, res) : new Float32Array(res * res * 4).fill(1e3);
      const half = new Uint16Array(data.length);
      for (let i = 0; i < data.length; i++) half[i] = toHalf(data[i]);
      t = { texture: new THREE.DataTexture(half, res, res, THREE.RGBAFormat, THREE.HalfFloatType), dispose() { this.texture.dispose(); } };
      t.texture.minFilter = t.texture.magFilter = THREE.LinearFilter;
      t.texture.generateMipmaps = false;
      t.texture.flipY = false;
      t.texture.needsUpdate = true;
      this.sdfTargets.set(size, t);
    }
    u.uSdf.value = t.texture;
    u.uSdfRect.value.set(...rect);
  }

  /** 光の帯の位置と強さ（手前の面に映る向きの範囲を、斜めの細い帯が横切る） */
  updateSweep(now) {
    const u = this.shared, w = this.sweeping;
    const p = w ? (now - w.t0) / SWEEP_MS : 1;
    if (!w || p >= 1) { this.sweeping = null; u.uSweepCol.value.set(0, 0, 0); return false; }
    const x = -0.26 + 0.52 * EASE.inOut(Math.max(0, p));
    const c = norm([x, 0.37, 1]), a = 0.55;
    u.uSweepC.value.set(...c);
    u.uSweepU.value.set(Math.cos(a), -Math.sin(a), 0);
    u.uSweepV.value.set(Math.sin(a), Math.cos(a), 0);
    const k = w.k * 9 * Math.sin(Math.PI * Math.min(1, Math.max(0, p)));
    u.uSweepCol.value.set(k, k * 0.98, k * 1.04);
    return true;
  }

  /** 盤面に満ちる色（tintCell）を、マスごとの色と大きさにして渡す */
  updateTints(now) {
    let busy = false;
    const data = this.tintData;
    data.fill(0);
    this.tints = this.tints.filter((t) => now < t.t0 + t.life);
    for (const t of this.tints) {
      if (now < t.t0) { busy = true; continue; }
      const k = keyframes(TINT, (now - t.t0) / t.life, EASE.inOut);
      const col = glassOf(t.color), o = (t.r * SIZE + t.x) * 4;
      data[o] = col[0]; data[o + 1] = col[1]; data[o + 2] = col[2]; data[o + 3] = k;
      busy = true;
    }
    this.tintTex.needsUpdate = true;
    return busy;
  }

  /** 毎フレーム、立方体を集める。まだ動いているものがあれば true */
  collect(now, v, eye) {
    const B = this.batches, c = v.cell, cube = CUBE * c, W = v.W, d = this.dom, calm = !!this.motion?.matches;
    this.gentle = false;
    for (const b of Object.values(B)) b.begin();
    this.caus = [];
    let busy = false;
    const pv = this.preview, hi = new Map();
    let pulse = 0;
    if (pv) {
      const p = (now - pv.t0) / 620;
      pulse = calm ? 1 : 0.78 + 0.22 * (0.5 - 0.5 * Math.cos(Math.PI * p));       // 2D の hiPulse（.78 ⇄ 1）
      for (const h of pv.hi) hi.set(h.x + ',' + h.r, h);
      busy = true;
    }
    // 盤面のブロック
    for (const [id, el] of d.els) {
      const p = el.__pos;
      if (!p) continue;
      const b = localToB(p.x + c / 2, p.y + c / 2, W);
      const st = this.anim.get(id);
      let sxy = 1, sz = 1, x = b.x, y = b.y, z = 0, rot = QUARTER;
      if (st?.land && calm) st.land = null;          // 動きを減らす設定: 落ちる・弾むは無し
      if (st?.land) {
        const L = st.land, e = now - L.t0 - L.delay;
        const fall = L.from ? 110 : 80;
        if (e < 0) {
          if (L.from) { x = L.from.x; y = L.from.y; z = L.from.z; }
          else z = cube * 0.45;
          busy = true;
        } else if (e < fall) {
          const u = e / fall;
          if (L.from) {
            const k = EASE.out(u);
            x = L.from.x + (b.x - L.from.x) * k; y = L.from.y + (b.y - L.from.y) * k;
            z = L.from.z * (1 - u * u);
          } else z = cube * 0.45 * (1 - u * u);
          busy = true;
        } else {
          const dur = L.fit ? 290 : 240, u = (e - fall) / dur;
          if (u < 1) { [sxy, sz] = keyframes(L.fit ? LAND_FIT : LAND, u, EASE.out); busy = true; }
          else st.land = null;
        }
      }
      if (st?.charge) {
        const k = 1 - 0.1 * EASE.in(Math.min(1, (now - st.charge.t0) / st.charge.ms));
        sxy *= k; sz *= k;
        busy = true;
      }
      if (st?.fly) {
        const u = calm ? 1 : Math.min(1, (now - st.fly.t0) / 200);
        const k = 1 - EASE.in(u);
        sxy *= k; sz *= k; rot += u * 1.1;
        if (u < 1) busy = true;
      }
      let color = el.__color, glow = 0;
      const key = Math.round(p.x / c) + ',' + Math.round(p.y / c), h = pv && hi.get(key);
      if (h) {
        color = pv.color;
        const enter = pv.fresh ? Math.min(1, Math.max(0, (now - pv.t0 - h.d) / 240)) : 1;
        glow = pulse * Math.min(1, enter * 1.4);
        const k = 0.92 + 0.08 * easeOutBack(enter);      // 色が変わる瞬間に、小さくぽんと弾む
        sxy *= k; sz *= k;
        if (enter < 1) busy = true;
      }
      if (sxy * sz < 1e-4) continue;
      const tint = glassOf(color);
      // 盤面の外（通路・ゴール）に出たら、後ろから光を当てる（暗い背景の上でもガラスの色が見えるように。盤面のふちから 1 マスでなめらかに）
      const lane = Math.max(0, Math.min(1, (p.x + p.y) / c - (SIZE - 1)));
      B.board.push(cubeMatrix(x, y, z, cube * sxy, cube * sxy, cube * sz, rot), tint, [1, glow, 0, lane]);
      const lc = x === b.x && y === b.y ? { x: p.x / c + 0.5, y: p.y / c + 0.5 } : this.bToCell(x, y, W, c);
      this.addCaustic(lc.x, lc.y, cube * sxy / c / 2, z / c, cube * sz / c, tint);
    }
    for (const id of [...this.anim.keys()]) if (!d.els.has(id)) this.anim.delete(id);
    // 仮置き（淡い・白っぽいガラス）
    if (pv) {
      const e = now - pv.t0;
      let k = 1;
      if (pv.fit) k = keyframes([[0, 1.2], [0.55, 0.9], [1, 1]], Math.min(1, e / 260), easeOutBack);
      else k = 1 + 0.12 * (1 - EASE.out(Math.min(1, e / 140)));
      const alpha = pv.strong ? 0.74 : pv.fit === 'perfect' || pv.fit === 'rect' ? 0.8 : 0.42;
      const fade = Math.min(1, e / 140);
      for (const cl of pv.cells) {
        const b = localToB((cl.x + 0.5) * c, (cl.r + 0.5) * c, W);
        B.ghost.push(cubeMatrix(b.x, b.y, 0, cube * k, cube * k, cube * k, QUARTER), glassOf(pv.color), [alpha * (0.4 + 0.6 * fade), pv.strong ? 0.75 : 0.45, 0.5, 0]);
      }
    }
    // 全消しの宝石
    this.gems = this.gems.filter((g) => now < g.t0 + g.life);
    for (const g of this.gems) {
      busy = true;
      if (now < g.t0) continue;
      const k = keyframes(AC_GEM, (now - g.t0) / g.life, EASE.out);
      if (k <= 0.001) continue;
      const b = localToB((g.x + 0.5) * c, (g.r + 0.5) * c, W);
      B.board.push(cubeMatrix(b.x, b.y, 0, cube * k, cube * k, cube * k, QUARTER), glassOf(g.color), [1, 0.35, 0, 0]);
      this.addCaustic(g.x + 0.5, g.r + 0.5, cube * k / c / 2, 0, cube * k / c, glassOf(g.color));
    }
    // 手駒
    this.tray.forEach((s, i) => {
      if (!s || i === this.dragging) return;
      const e = now - s.t0;
      let k = 1, dy = 0;
      if (e < 0) { busy = true; k = 0; }
      else if (e < 260) { const u = easeTrayIn(e / 260); k = 0.4 + 0.6 * u; dy = 40 * (1 - u); busy = true; }
      if (i === this.trayHint && !calm) {
        const u = 0.5 - 0.5 * Math.cos(Math.PI * ((now / 900) % 2));
        k *= 0.94 + 0.14 * u;
        this.gentle = true;                            // ゆっくり弾むだけなので、描く回数は減らしてよい
      }
      if (k <= 0) return;
      const tc = CUBE * s.s * k;
      for (const cl of s.cells) {
        const lx = (cl.x + 0.5 - s.width / 2) * s.s * k, ly = (cl.y + 0.5 - s.height / 2) * s.s * k;
        // 2D と同じ 225° 回した形（画面の座標）
        const px = s.center.x + Math.SQRT1_2 * (ly - lx), py = s.center.y + dy - Math.SQRT1_2 * (lx + ly);
        const b = unprojectClient(v, eye, px, py, tc / 2);
        B.ui.push(cubeMatrix(b.x, b.y, 0, tc, tc, tc, QUARTER), glassOf(s.color), [1, 0, 0, 0]);
      }
    });
    // 持っているピース
    const ds = this.dragState;
    if (ds) {
      const pc = ds.piece, e = now - ds.t0;
      const k = e < 200 && !calm ? 0.6 + 0.4 * easeOutBack(e / 200) : 1;
      if (e < 200) busy = true;
      const zc = HOVER * cube + cube / 2;
      const ctr = unprojectClient(v, eye, ds.x, ds.y, zc);
      // 動かす向きへ少し傾く（速さに比例。なめらかに）
      const sp = Math.hypot(ds.vx, ds.vy);
      // 進む向きの側が奥へ沈む（画面の y は下向き、B 空間の y は上向き）
      ds.tx += (ds.vy * 0.12 - ds.tx) * 0.25; ds.ty += (-ds.vx * 0.12 - ds.ty) * 0.25;
      ds.vx *= 0.85; ds.vy *= 0.85;
      if (sp > 0.01 || Math.abs(ds.tx) + Math.abs(ds.ty) > 0.002) busy = true;
      const tilt = calm ? null : rotation(clampAngle(ds.tx), clampAngle(ds.ty));
      const cubes = [];
      for (const cl of pc.cells) {
        const off = localToB((cl.x + 0.5 - pc.width / 2) * c * k + W / 2, (cl.y + 0.5 - pc.height / 2) * c * k + W / 2, W);
        const o3 = [off.x, off.y, -cube * k / 2];
        const r3 = tilt ? [0, 1, 2].map((i) => tilt[i] * o3[0] + tilt[i + 3] * o3[1] + tilt[i + 6] * o3[2]) : o3;
        const base = { x: ctr.x + r3[0], y: ctr.y + r3[1], z: zc + r3[2] };
        cubes.push(base);
        B.drag.push(cubeMatrix(base.x, base.y, base.z, cube * k, cube * k, cube * k, QUARTER, tilt), glassOf(pc.color), [1, 0, 0, 0]);
        const lc = this.bToCell(base.x, base.y, W, c);
        this.addCaustic(lc.x, lc.y, cube * k / c / 2, base.z / c, cube * k / c, glassOf(pc.color));
      }
      ds.cubes = cubes;
    }
    for (const b of Object.values(B)) b.end();
    return busy;
  }

  bToCell(bx, by, W, c) {
    return { x: (W / 2 + Math.SQRT1_2 * (by - bx)) / c, y: (W / 2 + Math.SQRT1_2 * (bx + by)) / c };
  }
  /** コースティクスを描く立方体（マス単位: 中心 x, r・半分の大きさ・底の高さ・高さ） */
  addCaustic(x, r, half, z0, height, tint) {
    if (half <= 0.01 || this.caus.length >= this.causCap) return;
    this.caus.push([x, r, half, z0, height, tint]);
  }
  renderCaustics(res, size = SIZE) {
    let t = this.causTargets.get(res);
    if (!t) {
      t = new THREE.WebGLRenderTarget(res, res, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
      this.causTargets.set(res, t);
    }
    this.causRect = new THREE.Vector4(-1.6, -1.6, size + 2.6, size + 2.6);
    // 影を落とす光は、照らす光（KEY_DIR）より真上寄りにする。KEY_DIR のままだと、立方体の影がちょうど隣のマス 1 つぶんに伸びて
    // 空いているくぼみにぴったり収まり、ブロックがあるように見える。影は立方体の足もとから 3 割ほどだけ、斜めにずらして出す
    const L = SHADOW_DIR;  // マスの座標の向き（z は手前）
    this.causMat.uniforms.uL.value.set(L[0], L[1], L[2]);
    // マスの座標は r が下向き（B 空間の y とは向きの関係が鏡写し）なので、z の向きはそのまま
    this.causMat.uniforms.uRect.value.copy(this.causRect);
    const n = this.caus.length;
    const ext = causJoins(this.caus);
    this.causExt.array.set(ext, 0);
    this.causExt.needsUpdate = true;
    for (let i = 0; i < n; i++) {
      const [x, r, half, z0, h, tint] = this.caus[i];
      this.causCube.array.set([x, r, half, z0], i * 4);
      this.causCube2.array.set([h, BEVEL * 2 * half * 1.0, 0, 0], i * 4);
      this.causTint.array.set(tint, i * 3);
    }
    this.causCube.needsUpdate = this.causCube2.needsUpdate = this.causTint.needsUpdate = true;
    this.causMesh.count = n;
    const gl = this.gl;
    gl.setRenderTarget(t);
    gl.setClearColor(0xffffff, 1);
    gl.clear(true, false, false);
    if (n) gl.render(this.causScene, this.camera);
    // 隣の立方体の色の地図（解像度は低くてよい）
    const nr = Math.max(64, res >> 1);
    let nb = this.nbTargets.get(nr);
    if (!nb) {
      nb = new THREE.WebGLRenderTarget(nr, nr, { type: THREE.HalfFloatType, format: THREE.RGBAFormat, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false, stencilBuffer: false });
      this.nbTargets.set(nr, nb);
    }
    this.nbMat.uniforms.uRect.value.copy(this.causRect);
    this.nbMesh.count = n;
    gl.setRenderTarget(nb);
    gl.clear(true, false, false);
    if (n) gl.render(this.nbScene, this.camera);
    this.nbTexture = nb.texture;
    return t;
  }
}

/** 画面上の 2D の変形 [a, b, c, d, tx, ty] の逆 */
function invertAffine([a, b, c, d, tx, ty]) {
  const det = a * d - b * c || 1;
  const ia = d / det, ib = -b / det, ic = -c / det, id = a / det;
  return [ia, ib, ic, id, -(ia * tx + ib * ty), -(ic * tx + id * ty)];
}
const clampAngle = (a) => Math.max(-0.28, Math.min(0.28, a));
/** x 軸まわりに ax、y 軸まわりに ay だけ回す 3×3（列優先） */
function rotation(ax, ay) {
  const cx = Math.cos(ax), sx = Math.sin(ax), cy = Math.cos(ay), sy = Math.sin(ay);
  // R = Ry(ay) * Rx(ax)
  return [
    cy, 0, -sy,
    sy * sx, cx, cy * sx,
    sy * cx, -sx, cy * cx,
  ];
}

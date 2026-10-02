import { SIZE, isInside } from '../core/constants.js?v=202610021101';
import { gemSprite } from './shards.js?v=202610021101';
import { GAME_NAME, LOGO_PATH, LOGO_BG, LOGO_FG, displayUrl } from './brand.js?v=202610021101';

/**
 * 結果カード（シェア用の1枚の画像）: ロゴ・スコア・最大連鎖・最大コンボ・最後の盤面・遊べる URL。
 * 盤面はゲームと同じ向き（直角が下）で、ブロックはかけらと同じ宝石の絵（shards.js の gemSprite）で描く。
 * 4:5 の縦長（SNS のタイムラインでそのまま大きく見える形）
 */
export const CARD_W = 1080, CARD_H = 1350;
const FONT = '"Round One","Nunito","M PLUS Rounded 1c","Hiragino Maru Gothic ProN","Arial Rounded MT Bold",sans-serif';
const DIM = '#b9ccff', GOLD = '#ffd54a';

/** カードに使う字を読み込んでおく（読み込み前に描くと、別の字形で描かれてしまう） */
async function loadFonts() {
  if (!document.fonts?.load) return;
  const jobs = [['900 100px "Nunito"', '0123456789,SCORE'], ['900 100px "Round One"', '1'], ['800 40px "M PLUS Rounded 1c"', '最大連鎖コンボブラウザですぐ遊べる']];
  try { await Promise.all(jobs.map(([f, t]) => document.fonts.load(f, t))); } catch {}
}

/**
 * data = { score, chain, combo, best: 新記録か, learn: 学習モードか, board: [[x, r, 色], …] }。
 * 描いた canvas を返す
 */
export async function drawResultCard(data) {
  await loadFonts();
  const cv = document.createElement('canvas');
  cv.width = CARD_W; cv.height = CARD_H;
  const g = cv.getContext('2d');
  // 背景: ゲームと同じ青（まん中が少し明るい）
  g.fillStyle = '#2451c4';
  g.fillRect(0, 0, CARD_W, CARD_H);
  const bg = g.createRadialGradient(CARD_W / 2, CARD_H * 0.36, 0, CARD_W / 2, CARD_H * 0.36, CARD_H * 0.62);
  bg.addColorStop(0, '#2e60d6'); bg.addColorStop(1, 'rgba(36,81,196,0)');
  g.fillStyle = bg;
  g.fillRect(0, 0, CARD_W, CARD_H);
  g.textAlign = 'center';
  g.textBaseline = 'alphabetic';

  drawLogo(g, CARD_W / 2, 118);
  const label = (text, x, y, size = 32, color = DIM) => {
    g.font = `800 ${size}px ${FONT}`;
    g.fillStyle = color;
    g.fillText(text, x, y);
  };
  // スコア（文字はゲームと同じくベタ塗り + 真下への薄い影）
  label('SCORE', CARD_W / 2, 236, 34);
  shadow(g, () => {
    let size = 176;
    const text = data.score.toLocaleString('en-US');
    do { g.font = `900 ${size}px ${FONT}`; size -= 6; } while (g.measureText(text).width > CARD_W - 120);
    g.fillStyle = '#fff';
    g.fillText(text, CARD_W / 2, 400);
  });
  if (data.best || data.learn) pill(g, CARD_W / 2, 452, data.best ? 'NEW BEST!' : 'LEARN MODE', data.best ? GOLD : DIM);
  // 最大連鎖・最大コンボ
  for (const [i, [name, v]] of [['最大連鎖', data.chain], ['最大コンボ', data.combo]].entries()) {
    const x = CARD_W / 2 + (i ? 190 : -190);
    label(name, x, 530, 32);
    shadow(g, () => { g.font = `900 92px ${FONT}`; g.fillStyle = '#fff'; g.fillText(String(v), x, 626); });
  }
  drawBoard(g, data.board, CARD_W / 2, 742, 60);
  // 遊べる場所
  label('ブラウザで すぐ遊べる', CARD_W / 2, 1222, 32);
  shadow(g, () => {
    let size = 46;
    const url = displayUrl();
    do { g.font = `800 ${size}px ${FONT}`; size -= 2; } while (g.measureText(url).width > CARD_W - 100);
    g.fillStyle = '#fff';
    g.fillText(url, CARD_W / 2, 1284);
  });
  return cv;
}

export const cardBlob = (cv) => new Promise((resolve) => cv.toBlob(resolve, 'image/png'));

function shadow(g, draw) {
  g.save();
  g.shadowColor = 'rgba(0,0,0,.18)'; g.shadowOffsetY = 6; g.shadowBlur = 6;
  draw();
  g.restore();
}

/** ロゴ: アイコン（階段の形）+ ゲーム名。まとめて (cx, cy) を中心に */
function drawLogo(g, cx, cy) {
  const icon = 84, gap = 22;
  g.font = `900 70px ${FONT}`;
  const tw = g.measureText(GAME_NAME).width, x0 = cx - (icon + gap + tw) / 2;
  g.save();
  g.translate(x0, cy - icon / 2);
  g.scale(icon / 32, icon / 32);
  g.fillStyle = LOGO_BG;
  g.beginPath(); g.roundRect ? g.roundRect(0, 0, 32, 32, 7) : g.rect(0, 0, 32, 32); g.fill();
  g.strokeStyle = 'rgba(150,192,255,.9)'; g.lineWidth = 1; g.stroke();
  g.fillStyle = LOGO_FG;
  g.fill(new Path2D(LOGO_PATH));
  g.restore();
  shadow(g, () => {
    g.textAlign = 'left';
    g.fillStyle = '#fff';
    g.fillText(GAME_NAME, x0 + icon + gap, cy + 25);
    g.textAlign = 'center';
  });
}

function pill(g, cx, cy, text, color) {
  g.font = `900 34px ${FONT}`;
  const w = g.measureText(text).width + 48, h = 54;
  g.strokeStyle = color; g.lineWidth = 3;
  g.beginPath(); g.roundRect ? g.roundRect(cx - w / 2, cy - h / 2, w, h, h / 2) : g.rect(cx - w / 2, cy - h / 2, w, h); g.stroke();
  g.fillStyle = color;
  g.textBaseline = 'middle';
  g.fillText(text, cx, cy + 2);
  g.textBaseline = 'alphabetic';
}

/**
 * 盤面をゲームと同じ向きで描く（renderer.localToWrap と同じ 225° 回転 + 縦に 1.04 倍）。
 * (cx, top) = 斜辺の中心線の位置、c = 1マスの大きさ
 */
function drawBoard(g, board, cx, top, c) {
  const k = Math.SQRT1_2, STRETCH = 1.04;
  const at = (x, r) => {
    const dx = (x + 0.5 - SIZE / 2) * c, dy = (r + 0.5 - SIZE / 2) * c;
    return { x: cx + k * (dy - dx), y: top - k * (dx + dy) * STRETCH };
  };
  const hw = c * k, hh = c * k * STRETCH;                       // マス（ひし形）の半分の幅・高さ
  const diamond = (p, s) => {
    g.beginPath();
    g.moveTo(p.x, p.y - hh * s); g.lineTo(p.x + hw * s, p.y); g.lineTo(p.x, p.y + hh * s); g.lineTo(p.x - hw * s, p.y);
    g.closePath();
  };
  const cells = [];
  for (let r = 0; r < SIZE; r++) for (let x = 0; x < SIZE; x++) if (isInside(x, r)) cells.push(at(x, r));
  // 土台: ふちの線を先に描いてから面で覆う（外周の線だけが残る）
  g.strokeStyle = '#6f93ea'; g.lineWidth = 5; g.lineJoin = 'round';
  for (const p of cells) { diamond(p, 1.04); g.stroke(); }
  g.fillStyle = '#1a3eae';
  for (const p of cells) { diamond(p, 1.04); g.fill(); }
  g.fillStyle = '#16296f';
  for (const p of cells) { diamond(p, 0.84); g.fill(); }
  // ブロック（奥から手前の順に: 上の方のマスから）
  const blocks = board.map(([x, r, color]) => ({ ...at(x, r), color })).sort((a, b) => a.y - b.y);
  for (const b of blocks) g.drawImage(gemSprite(b.color), b.x - hw, b.y - hh, hw * 2, hh * 2);
}

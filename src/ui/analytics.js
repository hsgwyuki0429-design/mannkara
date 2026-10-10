// Google アナリティクス（GA4）。測定 ID を GA_ID に入れると有効になる（空のままなら何も読み込まず、何も送らない）。
// 送るのは「どの画面・モードをどれくらい遊んだか」だけ。なまえ・ルーム番号などの個人を特定できる値は送らない。

/** GA4 の測定 ID（例: 'G-XXXXXXXXXX'）。空なら無効 */
export const GA_ID = 'G-X44MZCFB8Z';

const ID_RE = /^G-[A-Z0-9]{6,12}$/;

/** doc / win を差し替えられる（テスト用）。無効な ID・ブラウザ以外では track は何もしない */
export function createAnalytics({ id = GA_ID, doc = globalThis.document, win = globalThis.window } = {}) {
  const enabled = ID_RE.test(id) && !!doc && !!win;
  // 開発中（localhost）や Do Not Track のブラウザでは送らない
  const host = win?.location?.hostname || '';
  const quiet = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(host) || win?.navigator?.doNotTrack === '1';
  const on = enabled && !quiet;
  if (on) {
    win.dataLayer = win.dataLayer || [];
    win.gtag = function gtag() { win.dataLayer.push(arguments); };   // gtag.js は arguments オブジェクトをそのまま受け取る
    win.gtag('js', new Date());
    win.gtag('config', id, { send_page_view: true });
    const s = doc.createElement('script');
    s.async = true;
    s.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(id)}`;
    doc.head.appendChild(s);
  }
  /** イベントを送る。失敗しても遊びには影響させない */
  function track(name, params = {}) {
    if (!on) return;
    try { win.gtag('event', name, params); } catch { /* 計測が壊れてもゲームは止めない */ }
  }
  return { enabled: on, track };
}

export const analytics = createAnalytics();
export const track = analytics.track;

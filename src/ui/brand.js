/**
 * ゲーム名と遊べる場所（画面の下のロゴ・結果カード・シェアの文面で使う）。
 * URL はどこで開いていても常にこの1つ（短く覚えやすい、シェア用の URL）
 */
export const GAME_NAME = 'blockmancala';
export const CANONICAL_URL = 'https://blockmancala.pages.dev/';
/** アイコン（index.html の favicon・icons/）と同じ階段の形（32×32 の座標） */
export const LOGO_PATH = 'M6 6h20v4H22v4h-4v4h-4v4h-4v4H6z';
export const LOGO_BG = '#2b4bbf', LOGO_FG = '#ffd23f';

export const gameUrl = () => CANONICAL_URL;
/** 画面に出す短い形（https:// と最後の / を付けない） */
export const displayUrl = (url = gameUrl()) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/**
 * 端末に残す記録の名前は blockmancala- で始める。前の名前（stair-mancala-）で残っている記録は、
 * 新しい名前がまだ無ければ移してから消す（ベストスコアや途中のゲームを失わないように）。何回呼んでも同じ
 */
export const STORE_PREFIX = 'blockmancala-';
const OLD_PREFIX = 'stair-mancala-';
export function migrateStorage(store) {
  if (!store) return;
  const old = [];
  for (let i = 0; i < store.length; i++) {
    const k = store.key(i);
    if (k?.startsWith(OLD_PREFIX)) old.push(k);
  }
  for (const k of old) {
    const nk = STORE_PREFIX + k.slice(OLD_PREFIX.length);
    if (store.getItem(nk) == null) store.setItem(nk, store.getItem(k));
    store.removeItem(k);
  }
}

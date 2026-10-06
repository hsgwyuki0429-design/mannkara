/** Appearance is independent of the saved game and of normal/learn mode. */
export const BOARD_THEME_KEY = 'blockmancala-board-theme';
export const BOARD_THEMES = [
  { id: 'gem', name: '宝石', description: 'きらめく宝石と、くぼみのある盤面' },
  { id: 'glass', name: 'ガラス', description: 'やわらかな光をまとった、透き通る盤面' },
  { id: 'white', name: 'ホワイト', description: '白い背景に、つやのあるあざやかなブロック。動画やスクショで映える' },
  { id: '3d', name: '3D', description: '光の屈折を計算した、本物のようなガラスの立方体' },
];
/** 3D の背景の色（読み込みの間・ブラウザの上のバー）。cube3d.js の BACKDROP.top と同じ */
export const CUBE_BACKGROUND = '#3a6adf';
/** ホワイトの背景の色（ブラウザの上のバー・結果の画像） */
export const WHITE_BACKGROUND = '#f4f6fb';
export const normalizeBoardTheme = (value) => BOARD_THEMES.some((t) => t.id === value) ? value : 'gem';
export function readBoardTheme() {
  try { return normalizeBoardTheme(localStorage.getItem(BOARD_THEME_KEY)); } catch { return 'gem'; }
}
export function saveBoardTheme(value) {
  const theme = normalizeBoardTheme(value);
  try { localStorage.setItem(BOARD_THEME_KEY, theme); } catch { /* Still usable when storage is unavailable. */ }
  return theme;
}

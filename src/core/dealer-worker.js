import { DealerCore } from './dealer.js?v=202609261436';

/**
 * 手駒の決め方と、学習モードのおすすめの総当たりを動かす Web Worker（ui/tray-dealer.js から使う）。
 * メッセージ: { type: 'reset' } 新しいゲーム / { type: 'deal', id, cells } 手駒を決める /
 *             { type: 'hint', id, cells, names } おすすめの手 → どれも { id, result }
 */
const core = new DealerCore(Math.random);
self.onmessage = ({ data }) => {
  if (data.type === 'reset') { core.reset(); return; }
  try {
    const result = data.type === 'deal' ? core.deal(data.cells) : core.hint(data.cells, data.names);
    self.postMessage({ id: data.id, result });
  } catch (e) {
    self.postMessage({ id: data.id, error: String(e?.stack || e) });
  }
};

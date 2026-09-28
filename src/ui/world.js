/**
 * 世界ランキング（サーバーは functions/api/ranking.js）。通常モードの記録だけを送る。
 * 端末ごとに id（32 桁の 16 進）と名前を持つ。送れなかった記録は端末に残し、次に送る（自己ベストだけで足りる）
 */
import { CANONICAL_URL, STORE_PREFIX } from './brand.js?v=202609281441';

const ID_KEY = STORE_PREFIX + 'world-id';
const NAME_KEY = STORE_PREFIX + 'world-name';
const PENDING_KEY = STORE_PREFIX + 'world-pending';
export const NAME_MAX = 12;

/** 本番（*.pages.dev）と手元の開発ではそのサイトの API、それ以外（github.io など）からは本番の API へ */
function apiUrl() {
  const h = location.hostname;
  const same = h.endsWith('.pages.dev') || h === 'localhost' || h === '127.0.0.1';
  return (same ? location.origin + '/' : CANONICAL_URL) + 'api/ranking';
}
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

export class World {
  constructor() {
    this.id = get(ID_KEY);
    if (!/^[0-9a-f]{32}$/.test(this.id || '')) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      this.id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      set(ID_KEY, this.id);
      // 世界ランキングができる前の通常モードの記録も、はじめに送る
      let rec = {};
      try { rec = JSON.parse(get(STORE_PREFIX + 'records') || '{}') || {}; } catch {}
      this.addPending({ score: Number(get(STORE_PREFIX + 'best')) || 0, chain: rec.chain || 0, combo: rec.combo || 0 });
    }
    this.name = get(NAME_KEY) || `ななし${parseInt(this.id.slice(0, 4), 16) % 10000}`.slice(0, NAME_MAX);
    this.sending = null;
  }
  get pending() {
    try { return JSON.parse(get(PENDING_KEY) || 'null'); } catch { return null; }
  }
  /** 送る記録に足す（それぞれ大きい方を残す） */
  addPending(run) {
    const p = this.pending || { score: 0, chain: 0, combo: 0 };
    const n = (v) => (Number.isInteger(v) && v > 0 ? v : 0);
    const next = { score: Math.max(p.score, n(run.score)), chain: Math.max(p.chain, n(run.chain)), combo: Math.max(p.combo, n(run.combo)) };
    if (next.score || next.chain || next.combo) set(PENDING_KEY, JSON.stringify(next));
  }
  /** 名前を変える（サーバーにもすぐ送る）。空なら変えない */
  setName(name) {
    const s = [...String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('');
    if (!s) return false;
    this.name = s;
    set(NAME_KEY, s);
    return true;
  }
  /** 残っている記録を送る（名前を変えただけのときは force で 0 を送る）。送れたら true */
  async flush(force = false) {
    if (this.sending) await this.sending.catch(() => {});
    const p = this.pending;
    if (!p && !force) return true;
    const body = { id: this.id, name: this.name, score: 0, chain: 0, combo: 0, ...(p || {}) };
    this.sending = fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 送っている間に増えた分は残す
        const now = this.pending;
        if (now && now.score <= body.score && now.chain <= body.chain && now.combo <= body.combo) {
          try { localStorage.removeItem(PENDING_KEY); } catch {}
        }
        return true;
      });
    try { return await this.sending; } catch { return false; } finally { this.sending = null; }
  }
  /** { top: [{ rank, name, value, score, chain, combo, me }], me: { rank, value } | null } */
  async fetchTop(kind) {
    await this.flush();
    const res = await fetch(`${apiUrl()}?kind=${encodeURIComponent(kind)}&id=${this.id}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

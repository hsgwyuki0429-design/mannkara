/**
 * 世界ランキング（スコア。サーバーは functions/api/ranking.js）。通常モードの記録だけを送る。
 * 端末ごとに id（32 桁の 16 進）と名前を持つ。送れなかったスコアは端末に残し、次に送る（自己ベストだけで足りる）
 * 名前はかならず本人に決めてもらう（自動では付けない）。決めるまでは named が false で、送信もしない
 */
import { CANONICAL_URL, STORE_PREFIX } from './brand.js?v=202610051306';

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
      // 世界ランキングができる前の通常モードのベストスコアも、名前を決めたときにはじめて送る
      this.addPending(Number(get(STORE_PREFIX + 'best')) || 0);
    }
    this.name = get(NAME_KEY);   // 決めるまでは null（自動では付けない）
    this.sending = null;
  }
  /** 名前を決めたか（決めるまでは世界ランキングに参加しない＝送信しない） */
  get named() { return this.name != null; }
  /** まだ送れていないスコア（無ければ 0） */
  get pending() {
    const v = Number(get(PENDING_KEY));
    return Number.isInteger(v) && v > 0 ? v : 0;
  }
  /** 送るスコアに足す（大きい方を残す） */
  addPending(score) {
    if (Number.isInteger(score) && score > this.pending) set(PENDING_KEY, String(score));
  }
  /** 名前を変える（サーバーにもすぐ送る）。空なら変えない */
  setName(name) {
    const s = [...String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim()].slice(0, NAME_MAX).join('');
    if (!s) return false;
    this.name = s;
    set(NAME_KEY, s);
    return true;
  }
  /** 残っている記録を送る（名前を変えただけのときは force で 0 を送る）。送れたら true。名前を決めるまでは送らない */
  async flush(force = false) {
    if (!this.named) return false;
    if (this.sending) await this.sending.catch(() => {});
    const p = this.pending;
    if (!p && !force) return true;
    const body = { id: this.id, name: this.name, score: p };
    this.sending = fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // 送っている間に増えた分は残す
        if (this.pending <= body.score) {
          try { localStorage.removeItem(PENDING_KEY); } catch {}
        }
        return true;
      });
    try { return await this.sending; } catch { return false; } finally { this.sending = null; }
  }
  /** offset 人目からの1ページ { top: [{ rank, name, score, me }], total, me: { rank, score } | null }（最初のページの前に記録を送る） */
  async fetchTop(offset = 0) {
    if (!offset) await this.flush();
    const res = await fetch(`${apiUrl()}?id=${this.id}&offset=${offset}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

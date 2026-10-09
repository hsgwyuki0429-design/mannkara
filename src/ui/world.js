/**
 * 世界ランキング（サーバーは functions/api/ranking.js）。ひとりで遊んだゲームの記録だけを送る。シーズン制（SEASON）。
 * 端末ごとに id（32 桁の 16 進）と名前を持つ。送るのは、今のシーズンの自己ベストと、累計（まだ送っていないゲームのスコアの合計とゲーム数）。
 * 送れなかった分は端末に残し、次に送る。累計は送るたびに通し番号（seq）を付け、送り直しても 2 回足されないようにする
 * （送ったのに返事が届かなかった分は、同じ seq のまま送り直す）。
 * 名前はかならず本人に決めてもらう（自動では付けない）。決めるまでは named が false で、送信もしない
 */
import { CANONICAL_URL, STORE_PREFIX } from './brand.js?v=202610091551';

/** 今のシーズン（サーバーの CURRENT_SEASON と同じ） */
export const SEASON = 2;
const ID_KEY = STORE_PREFIX + 'world-id';
const NAME_KEY = STORE_PREFIX + 'world-name';
const PENDING_KEY = STORE_PREFIX + `world-pending-s${SEASON}`;     // { best, add, games }（まだ送っていない分）
const INFLIGHT_KEY = STORE_PREFIX + `world-inflight-s${SEASON}`;   // { seq, best, add, games }（送ったが、届いたと分かっていない分）
const SEQ_KEY = STORE_PREFIX + `world-seq-s${SEASON}`;
export const NAME_MAX = 12;

/** 本番（*.pages.dev）と手元の開発ではそのサイトの API、それ以外（github.io など）からは本番の API へ（対戦の API も同じ: net.js） */
export function apiBase() {
  const h = location.hostname;
  const same = h.endsWith('.pages.dev') || h === 'localhost' || h === '127.0.0.1';
  return (same ? location.origin + '/' : CANONICAL_URL) + 'api/';
}
const apiUrl = () => apiBase() + 'ranking';
const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const set = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const del = (k) => { try { localStorage.removeItem(k); } catch {} };
const readJson = (k) => { try { const v = JSON.parse(get(k) || 'null'); return v && typeof v === 'object' ? v : null; } catch { return null; } };
const nat = (v) => (Number.isSafeInteger(v) && v > 0 ? v : 0);

export class World {
  constructor() {
    this.id = get(ID_KEY);
    if (!/^[0-9a-f]{32}$/.test(this.id || '')) {
      const b = new Uint8Array(16);
      crypto.getRandomValues(b);
      this.id = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      set(ID_KEY, this.id);
    }
    this.name = get(NAME_KEY);   // 決めるまでは null（自動では付けない）
    this.sending = null;
  }
  /** 名前を決めたか（決めるまでは世界ランキングに参加しない＝送信しない） */
  get named() { return this.name != null; }
  /** まだ送れていない分 { best, add, games } */
  get pending() {
    const p = readJson(PENDING_KEY) || {};
    return { best: nat(p.best), add: nat(p.add), games: nat(p.games) };
  }
  /** 1 ゲーム終わった: 自己ベスト（大きい方を残す）と累計に足す */
  addRun(score) {
    if (!Number.isSafeInteger(score) || score <= 0) return;
    const p = this.pending;
    set(PENDING_KEY, JSON.stringify({ best: Math.max(p.best, score), add: p.add + score, games: p.games + 1 }));
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
    let batch = readJson(INFLIGHT_KEY);
    if (!batch) {
      const p = this.pending;
      if (!p.best && !p.add && !force) return true;
      const seq = nat(Number(get(SEQ_KEY))) + 1;
      batch = { seq, best: p.best, add: p.add, games: p.games };
      set(SEQ_KEY, String(seq));
      set(INFLIGHT_KEY, JSON.stringify(batch));
      del(PENDING_KEY);
    }
    const body = { season: SEASON, id: this.id, name: this.name, score: batch.best, add: batch.add, games: batch.games, seq: batch.seq };
    this.sending = fetch(apiUrl(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), keepalive: true })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        del(INFLIGHT_KEY);
        return true;
      });
    let ok = false;
    try { ok = await this.sending; } catch { ok = false; } finally { this.sending = null; }
    if (ok && (this.pending.best || this.pending.add)) return this.flush();        // 送っている間に増えた分
    return ok;
  }
  /**
   * offset 人目からの1ページ。season（1 / 2…）・kind（best = ベスト / total = 累計 / rate = レート）。
   * { top: [{ rank, name, score, me, games }], total, me: { rank, score, games } | null }（今のシーズンの最初のページの前に記録を送る）
   */
  async fetchTop(offset = 0, { season = SEASON, kind = 'best' } = {}) {
    if (!offset && season === SEASON) await this.flush();
    const res = await fetch(`${apiUrl()}?id=${this.id}&offset=${offset}&season=${season}&kind=${kind}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
  /** 自分の今のシーズンのレート { rate, games, wins } */
  async fetchRate() {
    const res = await fetch(`${apiUrl()}?kind=myrate&id=${this.id}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }
}

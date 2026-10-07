/**
 * 世界ランキングの API（Cloudflare Pages Functions。/api/ranking で動く）。スコアだけ。
 * データは D1（Pages の設定で DB という名前でつなぐ）。表は初めて使うときにここで作る。
 *
 * 1人（端末ごとの id）につき1行: 自己ベストのスコアと名前。
 *   GET  /api/ranking?id=<自分の id>&offset=<何人目から>&limit=<何人>
 *        → { top: [{ rank, name, score, me, hidden }], total: 参加している人数, me: { rank, score } | null }
 *        最下位まで見られるように、offset をずらして続きを読む（1回に PAGE_MAX 人まで）
 *        作成者が「隠す」にした不適切な名前は、ほかの人には HIDDEN_NAME で返す（本人には本人の名前のまま。functions/api/admin.js）
 *   POST /api/ranking  { id, name, score }  → 自己ベストを更新（小さい値では下げない）・名前を変える
 * id は他の人に返さない（id を知っていれば名前を書き換えられるので）。
 * ゲームは端末の中で動くので、送られた値が本物かまでは確かめられない（ありえない値だけはねる）
 */
export const PAGE_SIZE = 50;
export const PAGE_MAX = 100;
export const SCORE_MAX = Number.MAX_SAFE_INTEGER;
export const NAME_MAX = 12;
/** 作成者が隠した名前の代わりに、ほかの人へ返す表示 */
export const HIDDEN_NAME = '＊＊＊';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

/** 名前: 前後の空白と制御文字を取り、NAME_MAX 文字まで。空なら null */
export function cleanName(name) {
  if (typeof name !== 'string') return null;
  const s = [...name.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069\ufeff]/g, '').replace(/\s+/g, ' ').trim()];
  return s.length ? s.slice(0, NAME_MAX).join('') : null;
}
/** id: 端末で作った 32 桁の 16 進 */
export const validId = (id) => typeof id === 'string' && /^[0-9a-f]{32}$/.test(id);
/** 送られた記録を確かめる。おかしければ null */
export function cleanRun(body) {
  if (!body || typeof body !== 'object' || !validId(body.id)) return null;
  const name = cleanName(body.name);
  const { score } = body;
  if (!name || !Number.isSafeInteger(score) || score < 0 || score > SCORE_MAX) return null;
  return { id: body.id, name, score };
}

/**
 * hidden_name: 作成者が「隠す」にしたときの名前。今の名前と同じあいだだけ隠す
 * （本人が名前を変えたら、新しい名前はふつうに出る。まだ不適切なら作成者がもう一度隠す）
 */
const ready = new WeakSet();
export async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, score_at INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0, hidden_name TEXT)`).run();
  if (ready.has(db)) return;
  // 隠す機能ができる前の表には列が無いので足す（1回だけ調べる）
  const { results } = await db.prepare('PRAGMA table_info(players)').all();
  if (!results.some((c) => c.name === 'hidden_name')) await db.prepare('ALTER TABLE players ADD COLUMN hidden_name TEXT').run();
  ready.add(db);
}

/** 自己ベストを更新（上がったときだけ。同じ点なら先に出した時刻のまま） */
export async function submit(db, run, now = Date.now()) {
  await ensureTable(db);
  await db.prepare(`INSERT INTO players (id, name, score, score_at, updated) VALUES (?1, ?2, ?3, ?4, ?4)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      score_at = CASE WHEN excluded.score > players.score THEN excluded.score_at ELSE players.score_at END,
      score = MAX(players.score, excluded.score),
      updated = excluded.updated`)
    .bind(run.id, run.name, run.score, now).run();
}

/** offset 人目からの limit 人と、参加している人数と、自分の順位（同じ点なら先に出した人が上） */
export async function ranking(db, id, offset = 0, limit = PAGE_SIZE) {
  await ensureTable(db);
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_SIZE)));
  const { results } = await db.prepare(`SELECT id, name, score, (hidden_name IS NOT NULL AND hidden_name = name) AS hidden FROM players
    WHERE score > 0 ORDER BY score DESC, score_at ASC, id ASC LIMIT ?1 OFFSET ?2`).bind(limit, offset).all();
  // 隠した名前は、本人（id が同じ）には本人の名前のまま返す（隠されたことに気づかない）
  const top = results.map((r, i) => {
    const me = r.id === id, hide = !!r.hidden && !me;
    return { rank: offset + i + 1, name: hide ? HIDDEN_NAME : r.name, score: r.score, me, hidden: hide };
  });
  const total = (await db.prepare('SELECT COUNT(*) AS n FROM players WHERE score > 0').first()).n;
  let me = null;
  if (validId(id)) {
    const mine = await db.prepare('SELECT score, score_at AS at FROM players WHERE id = ?1').bind(id).first();
    if (mine && mine.score > 0) {
      const ahead = await db.prepare(`SELECT COUNT(*) AS n FROM players
        WHERE score > ?1 OR (score = ?1 AND (score_at < ?2 OR (score_at = ?2 AND id < ?3)))`).bind(mine.score, mine.at, id).first();
      me = { rank: ahead.n + 1, score: mine.score };
    }
  }
  return { top, total, me };
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  const q = new URL(request.url).searchParams;
  return json(await ranking(env.DB, q.get('id'), q.get('offset'), q.get('limit')));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const run = cleanRun(body);
  if (!run) return json({ error: 'bad-run' }, 400);
  await submit(env.DB, run);
  return json({ ok: true });
}

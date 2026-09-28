/**
 * 世界ランキングの API（Cloudflare Pages Functions。/api/ranking で動く）。
 * データは D1（Pages の設定で DB という名前でつなぐ）。表は初めて使うときにここで作る。
 *
 * 1人（端末ごとの id）につき1行: スコア・連鎖・コンボのそれぞれの自己ベストと名前。
 *   GET  /api/ranking?kind=score|combo|chain&id=<自分の id>
 *        → { kind, top: [{ rank, name, value, score, chain, combo, me }], me: { rank, value } | null }
 *   POST /api/ranking  { id, name, score, chain, combo }  → 自己ベストを更新（小さい値では下げない）・名前を変える
 * id は他の人に返さない（id を知っていれば名前を書き換えられるので）。
 * ゲームは端末の中で動くので、送られた値が本物かまでは確かめられない（ありえない値だけはねる）
 */
export const KINDS = ['score', 'combo', 'chain'];
export const TOP_SIZE = 50;
export const LIMITS = { score: 100000000, chain: 99, combo: 999 };
export const NAME_MAX = 12;

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
  if (!name) return null;
  const out = { id: body.id, name };
  for (const k of KINDS) {
    const v = body[k];
    if (!Number.isInteger(v) || v < 0 || v > LIMITS[k]) return null;
    out[k] = v;
  }
  return out;
}

async function ensureTable(db) {
  await db.prepare(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, score_at INTEGER NOT NULL DEFAULT 0,
    chain INTEGER NOT NULL DEFAULT 0, chain_at INTEGER NOT NULL DEFAULT 0,
    combo INTEGER NOT NULL DEFAULT 0, combo_at INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0)`).run();
}

/** 自己ベストを更新（上がった値だけ。同じ値なら先に出した時刻のまま） */
export async function submit(db, run, now = Date.now()) {
  await ensureTable(db);
  await db.prepare(`INSERT INTO players (id, name, score, score_at, chain, chain_at, combo, combo_at, updated)
    VALUES (?1, ?2, ?3, ?6, ?4, ?6, ?5, ?6, ?6)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      score_at = CASE WHEN excluded.score > players.score THEN excluded.score_at ELSE players.score_at END,
      score = MAX(players.score, excluded.score),
      chain_at = CASE WHEN excluded.chain > players.chain THEN excluded.chain_at ELSE players.chain_at END,
      chain = MAX(players.chain, excluded.chain),
      combo_at = CASE WHEN excluded.combo > players.combo THEN excluded.combo_at ELSE players.combo_at END,
      combo = MAX(players.combo, excluded.combo),
      updated = excluded.updated`)
    .bind(run.id, run.name, run.score, run.chain, run.combo, now).run();
}

/** そのランキングの上位と、自分の順位（同じ値なら先に出した人が上） */
export async function ranking(db, kind, id) {
  await ensureTable(db);
  const at = `${kind}_at`;
  const { results } = await db.prepare(`SELECT id, name, score, chain, combo, ${kind} AS value FROM players
    WHERE ${kind} > 0 ORDER BY ${kind} DESC, ${at} ASC, id ASC LIMIT ?1`).bind(TOP_SIZE).all();
  const top = results.map((r, i) => ({ rank: i + 1, name: r.name, value: r.value, score: r.score, chain: r.chain, combo: r.combo, me: r.id === id }));
  let me = null;
  if (validId(id)) {
    const mine = await db.prepare(`SELECT ${kind} AS value, ${at} AS at FROM players WHERE id = ?1`).bind(id).first();
    if (mine && mine.value > 0) {
      const ahead = await db.prepare(`SELECT COUNT(*) AS n FROM players WHERE ${kind} > ?1 OR (${kind} = ?1 AND (${at} < ?2 OR (${at} = ?2 AND id < ?3)))`)
        .bind(mine.value, mine.at, id).first();
      me = { rank: ahead.n + 1, value: mine.value };
    }
  }
  return { kind, top, me };
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  const url = new URL(request.url);
  const kind = url.searchParams.get('kind') || 'score';
  if (!KINDS.includes(kind)) return json({ error: 'bad-kind' }, 400);
  return json(await ranking(env.DB, kind, url.searchParams.get('id')));
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

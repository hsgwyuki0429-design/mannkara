/**
 * 作成者だけの管理 API（Cloudflare Pages Functions。/api/admin で動く）。不適切な名前を「隠す」ためだけのもの。
 * 名前を書き換えることはできない。隠した名前は、ほかの人には ＊＊＊ と出て、本人の画面にはそのまま出る（ranking.js）。
 *
 * 合言葉: Pages の Settings → Variables and Secrets に Secret として ADMIN_KEY（16文字以上）を入れる。
 * 無い・短いときはこの API 全体が使えない（503）。呼ぶときは Authorization: Bearer <ADMIN_KEY>。
 * 画面は admin.html。ほかのサイトから呼べないよう、CORS は付けない。
 *   GET  /api/admin?q=<名前の一部>&hidden=1&season=<1|2…>&offset=&limit=
 *        → { season, players: [{ id, rank, name, score, hidden }], total }   （id を返せるのはここだけ。順位はそのシーズンのベストスコア）
 *   POST /api/admin  { id, hidden: true | false }  → その人の今の名前を隠す / 戻す（どのシーズンの表でも）
 */
import { ensureTable, validId, PAGE_SIZE, PAGE_MAX, CURRENT_SEASON } from './ranking.js';

export const ADMIN_KEY_MIN = 16;
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
});

/** 時間で合言葉を当てられないよう、最後まで比べる */
export function sameKey(a, b) {
  const x = new TextEncoder().encode(String(a)), y = new TextEncoder().encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}
/** 使えないなら返す Response（使えるなら null） */
export function guard(request, env) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  if (typeof env.ADMIN_KEY !== 'string' || env.ADMIN_KEY.length < ADMIN_KEY_MIN) return json({ error: 'admin-disabled' }, 503);
  const m = /^Bearer (.+)$/.exec(request.headers.get('Authorization') || '');
  if (!m || !sameKey(m[1], env.ADMIN_KEY)) return json({ error: 'unauthorized' }, 401);
  return null;
}

const likeEscape = (t) => t.replace(/[\\%_]/g, (c) => '\\' + c);

/** 名前の一部で探す・隠しているものだけ、を選べる。そのシーズンのベストスコアの高い順（0 点の人は順位なし） */
export async function adminList(db, { q = '', onlyHidden = false, season = CURRENT_SEASON, offset = 0, limit = PAGE_SIZE } = {}) {
  await ensureTable(db);
  season = Math.max(1, Math.min(CURRENT_SEASON, Math.floor(Number(season) || CURRENT_SEASON)));
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_SIZE)));
  const [table, col, at, scope] = season === 1 ? ['players', 'score', 'score_at', '1 = 1'] : ['season_players', 'best', 'best_at', `season = ${season}`];
  const where = `${scope} AND (?1 = '' OR name LIKE ?2 ESCAPE '\\') AND (?3 = 0 OR (hidden_name IS NOT NULL AND hidden_name = name))`;
  const args = [q, `%${likeEscape(q)}%`, onlyHidden ? 1 : 0];
  const { results } = await db.prepare(`SELECT id, name, ${col} AS score, ${at} AS at, (hidden_name IS NOT NULL AND hidden_name = name) AS hidden FROM ${table}
    WHERE ${where} ORDER BY ${col} DESC, ${at} ASC, id ASC LIMIT ?4 OFFSET ?5`).bind(...args, limit, offset).all();
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).bind(...args).first()).n;
  const players = [];
  for (const r of results) {
    let rank = null;
    if (r.score > 0) {
      rank = 1 + (await db.prepare(`SELECT COUNT(*) AS n FROM ${table}
        WHERE ${scope} AND (${col} > ?1 OR (${col} = ?1 AND (${at} < ?2 OR (${at} = ?2 AND id < ?3))))`).bind(r.score, r.at, r.id).first()).n;
    }
    players.push({ id: r.id, rank, name: r.name, score: r.score, hidden: !!r.hidden });
  }
  return { season, players, total };
}

/** その人の今の名前を隠す（hidden: true）/ 戻す（false）。どのシーズンの表の名前も。人が見つからなければ false */
export async function setHidden(db, id, hidden) {
  await ensureTable(db);
  if (!validId(id)) return false;
  const a = await db.prepare('SELECT id FROM players WHERE id = ?1').bind(id).first();
  const b = await db.prepare('SELECT id FROM season_players WHERE id = ?1 LIMIT 1').bind(id).first();
  if (!a && !b) return false;
  await db.prepare('UPDATE players SET hidden_name = CASE WHEN ?2 = 1 THEN name ELSE NULL END WHERE id = ?1').bind(id, hidden ? 1 : 0).run();
  await db.prepare('UPDATE season_players SET hidden_name = CASE WHEN ?2 = 1 THEN name ELSE NULL END WHERE id = ?1').bind(id, hidden ? 1 : 0).run();
  return true;
}

export async function onRequestGet({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  const q = new URL(request.url).searchParams;
  return json(await adminList(env.DB, { q: (q.get('q') || '').slice(0, 40), onlyHidden: q.get('hidden') === '1', season: q.get('season'), offset: q.get('offset'), limit: q.get('limit') }));
}

export async function onRequestPost({ request, env }) {
  const denied = guard(request, env);
  if (denied) return denied;
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  if (!body || !validId(body.id) || typeof body.hidden !== 'boolean') return json({ error: 'bad-request' }, 400);
  if (!(await setHidden(env.DB, body.id, body.hidden))) return json({ error: 'not-found' }, 404);
  return json({ ok: true });
}

/**
 * 世界ランキングの API（Cloudflare Pages Functions。/api/ranking で動く）。
 * データは D1（Pages の設定で DB という名前でつなぐ）。表は初めて使うときにここで作る。
 *
 * シーズン制（CURRENT_SEASON）:
 *  - シーズン 1 = 表 players（ベストスコアだけ。もう書きこまない。結果を見るだけ）
 *  - シーズン 2〜 = 表 season_players（シーズン × 端末の id で 1 行）。ベストスコア（best）・累計スコア（total = そのシーズンに遊んだゲームのスコアの合計）・
 *    オンライン対戦のレート（rate。1000 から。functions/api/battle.js が勝ち負けで動かす）
 *
 *   GET  /api/ranking?id=<自分の id>&season=<1|2…>&kind=<best|total|rate>&offset=<何人目から>&limit=<何人>
 *        → { season, kind, top: [{ rank, name, score, me, hidden, games }], total: 参加している人数, me: { rank, score, games } | null }
 *        最下位まで見られるように、offset をずらして続きを読む（1回に PAGE_MAX 人まで）
 *        作成者が「隠す」にした不適切な名前は、ほかの人には HIDDEN_NAME で返す（本人には本人の名前のまま。functions/api/admin.js）
 *   POST /api/ranking  { season, id, name, score, add, games, seq }
 *        → 今のシーズンの自己ベストを更新（小さい値では下げない）・累計に add 点（games ゲームぶん）を足す・名前を変える。
 *          seq は端末ごとの送信の通し番号: 送れたのに返事が届かず送り直したときに、累計を 2 回足さない（seq が前より大きいときだけ足す）。
 *          season が今のシーズンでないもの（前のシーズンの古い画面から送られたもの）は受け取るが、どこにも書かない
 * id は他の人に返さない（id を知っていれば名前を書き換えられるので）。
 * ゲームは端末の中で動くので、送られた値が本物かまでは確かめられない（ありえない値だけはねる）
 */
export const CURRENT_SEASON = 2;
export const START_RATE = 1000;
export const KINDS = ['best', 'total', 'rate'];
export const PAGE_SIZE = 50;
export const PAGE_MAX = 100;
export const SCORE_MAX = Number.MAX_SAFE_INTEGER;
export const ADD_MAX_GAMES = 1000;      // 1 回に足せるゲームの数
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
const count = (v) => (Number.isSafeInteger(v) && v >= 0 ? v : null);
/** 送られた記録を確かめる。おかしければ null。{ id, name, score, add, games, seq, season } */
export function cleanRun(body) {
  if (!body || typeof body !== 'object' || !validId(body.id)) return null;
  const name = cleanName(body.name);
  const { score } = body;
  if (!name || !Number.isSafeInteger(score) || score < 0 || score > SCORE_MAX) return null;
  const add = body.add == null ? 0 : count(body.add), games = body.games == null ? 0 : count(body.games), seq = body.seq == null ? 0 : count(body.seq);
  if (add == null || games == null || seq == null || games > ADD_MAX_GAMES) return null;
  return { id: body.id, name, score, add, games, seq, season: Number.isSafeInteger(body.season) ? body.season : 1 };
}

/**
 * hidden_name: 作成者が「隠す」にしたときの名前。今の名前と同じあいだだけ隠す
 * （本人が名前を変えたら、新しい名前はふつうに出る。まだ不適切なら作成者がもう一度隠す）
 */
const ready = new WeakSet();
export async function ensureTable(db) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, name TEXT NOT NULL,
    score INTEGER NOT NULL DEFAULT 0, score_at INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0, hidden_name TEXT)`).run();
  // 隠す機能ができる前の表には列が無いので足す
  const { results } = await db.prepare('PRAGMA table_info(players)').all();
  if (!results.some((c) => c.name === 'hidden_name')) await db.prepare('ALTER TABLE players ADD COLUMN hidden_name TEXT').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS season_players (
    season INTEGER NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
    best INTEGER NOT NULL DEFAULT 0, best_at INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0, total_at INTEGER NOT NULL DEFAULT 0, games INTEGER NOT NULL DEFAULT 0, last_seq INTEGER NOT NULL DEFAULT 0,
    rate INTEGER NOT NULL DEFAULT ${START_RATE}, rate_at INTEGER NOT NULL DEFAULT 0, rate_games INTEGER NOT NULL DEFAULT 0, rate_wins INTEGER NOT NULL DEFAULT 0,
    updated INTEGER NOT NULL DEFAULT 0, hidden_name TEXT, PRIMARY KEY (season, id))`).run();
  for (const k of KINDS) {
    const [col, at] = COLUMNS[k];
    await db.prepare(`CREATE INDEX IF NOT EXISTS season_players_${k} ON season_players (season, ${col} DESC, ${at})`).run();
  }
  ready.add(db);
}
/** 種類ごとの並べる列・同じ値のときに先にした人が上になる時刻の列・参加している条件 */
const COLUMNS = { best: ['best', 'best_at', 'best > 0'], total: ['total', 'total_at', 'total > 0'], rate: ['rate', 'rate_at', 'rate_games > 0'] };

/** 今のシーズンの 1 行を作る（無ければ）。名前は新しいもの */
export async function ensureSeasonRow(db, season, id, name, now = Date.now()) {
  await db.prepare(`INSERT INTO season_players (season, id, name, updated) VALUES (?1, ?2, ?3, ?4)
    ON CONFLICT(season, id) DO UPDATE SET name = excluded.name, updated = excluded.updated`).bind(season, id, name, now).run();
}

/**
 * 記録を受け取る（今のシーズンだけ）。自己ベストは上がったときだけ（同じ点なら先に出した時刻のまま）。
 * 累計は seq が前より大きいときだけ足す（送り直しで 2 回足さない）
 */
export async function submit(db, run, now = Date.now()) {
  await ensureTable(db);
  if ((run.season ?? 1) !== CURRENT_SEASON) return false;
  await db.prepare(`INSERT INTO season_players (season, id, name, best, best_at, total, total_at, games, last_seq, updated)
    VALUES (?1, ?2, ?3, ?4, ?8, ?5, CASE WHEN ?5 > 0 THEN ?8 ELSE 0 END, ?6, ?7, ?8)
    ON CONFLICT(season, id) DO UPDATE SET
      name = excluded.name,
      best_at = CASE WHEN excluded.best > season_players.best THEN excluded.best_at ELSE season_players.best_at END,
      best = MAX(season_players.best, excluded.best),
      total = season_players.total + CASE WHEN ?7 > season_players.last_seq THEN ?5 ELSE 0 END,
      total_at = CASE WHEN ?7 > season_players.last_seq AND ?5 > 0 THEN ?8 ELSE season_players.total_at END,
      games = season_players.games + CASE WHEN ?7 > season_players.last_seq THEN ?6 ELSE 0 END,
      last_seq = MAX(season_players.last_seq, ?7),
      updated = ?8`)
    .bind(CURRENT_SEASON, run.id, run.name, run.score, run.add ?? 0, run.games ?? 0, run.seq ?? 0, now).run();
  return true;
}

/** offset 人目からの limit 人と、参加している人数と、自分の順位（同じ値なら先にした人が上） */
export async function ranking(db, id, { season = CURRENT_SEASON, kind = 'best', offset = 0, limit = PAGE_SIZE } = {}) {
  await ensureTable(db);
  season = Math.max(1, Math.min(CURRENT_SEASON, Math.floor(Number(season) || CURRENT_SEASON)));
  kind = season === 1 ? 'best' : KINDS.includes(kind) ? kind : 'best';
  offset = Math.max(0, Math.floor(Number(offset) || 0));
  limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(limit) || PAGE_SIZE)));
  // シーズン 1 は前の表（ベストスコアだけ）を同じ形で読む
  const [table, col, at, joined, extra] = season === 1
    ? ['players', 'score', 'score_at', 'score > 0', '0 AS games']
    : ['season_players', ...COLUMNS[kind], kind === 'rate' ? 'rate_games AS games, rate_wins AS wins' : 'games'];
  const scope = season === 1 ? '1 = 1' : `season = ${season}`;
  const { results } = await db.prepare(`SELECT id, name, ${col} AS score, ${extra}, (hidden_name IS NOT NULL AND hidden_name = name) AS hidden FROM ${table}
    WHERE ${scope} AND ${joined} ORDER BY ${col} DESC, ${at} ASC, id ASC LIMIT ?1 OFFSET ?2`).bind(limit, offset).all();
  // 隠した名前は、本人（id が同じ）には本人の名前のまま返す（隠されたことに気づかない）
  const top = results.map((r, i) => {
    const me = r.id === id, hide = !!r.hidden && !me;
    return { rank: offset + i + 1, name: hide ? HIDDEN_NAME : r.name, score: r.score, me, hidden: hide, games: r.games ?? 0, ...(r.wins != null ? { wins: r.wins } : {}) };
  });
  const total = (await db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${scope} AND ${joined}`).first()).n;
  let me = null;
  if (validId(id)) {
    const mine = await db.prepare(`SELECT ${col} AS score, ${at} AS at, ${extra} FROM ${table} WHERE ${scope} AND id = ?1 AND ${joined}`).bind(id).first();
    if (mine) {
      const ahead = await db.prepare(`SELECT COUNT(*) AS n FROM ${table}
        WHERE ${scope} AND ${joined} AND (${col} > ?1 OR (${col} = ?1 AND (${at} < ?2 OR (${at} = ?2 AND id < ?3))))`).bind(mine.score, mine.at, id).first();
      me = { rank: ahead.n + 1, score: mine.score, games: mine.games ?? 0, ...(mine.wins != null ? { wins: mine.wins } : {}) };
    }
  }
  return { season, kind, top, total, me };
}

/** 自分のレート（まだ対戦していなければ START_RATE）。{ rate, games, wins } */
export async function myRate(db, id, season = CURRENT_SEASON) {
  await ensureTable(db);
  const row = validId(id) ? await db.prepare('SELECT rate, rate_games, rate_wins FROM season_players WHERE season = ?1 AND id = ?2').bind(season, id).first() : null;
  return row ? { rate: row.rate, games: row.rate_games, wins: row.rate_wins } : { rate: START_RATE, games: 0, wins: 0 };
}

/**
 * レートの増減（イロレーティング。K = RATE_K）。2 人の増減を足すとかならず 0（勝った人が +d、負けた人が −d）。
 * result = 'a'（a の勝ち）/ 'b' / 'draw'。返り値 [a の増減, b の増減]
 */
export const RATE_K = 32;
export function rateDelta(ra, rb, result) {
  const ea = 1 / (1 + 10 ** ((rb - ra) / 400));
  if (result === 'draw') { const d = Math.round(RATE_K * (0.5 - ea)); return [d, -d]; }
  if (result === 'a') { const d = Math.max(1, Math.round(RATE_K * (1 - ea))); return [d, -d]; }
  const d = Math.max(1, Math.round(RATE_K * ea));
  return [-d, d];
}

/** レート戦の結果を 2 人に反映する（a, b = { id, name }。result は rateDelta と同じ）。返り値 { a: { rate, delta }, b: { … } } */
export async function applyRated(db, a, b, result, now = Date.now(), season = CURRENT_SEASON) {
  await ensureTable(db);
  await ensureSeasonRow(db, season, a.id, a.name, now);
  await ensureSeasonRow(db, season, b.id, b.name, now);
  const ra = (await myRate(db, a.id, season)).rate, rb = (await myRate(db, b.id, season)).rate;
  const [da, db_] = rateDelta(ra, rb, result);
  const upd = (id, d, win) => db.prepare(`UPDATE season_players SET rate = rate + ?3, rate_games = rate_games + 1, rate_wins = rate_wins + ?4, rate_at = ?5, updated = ?5
    WHERE season = ?1 AND id = ?2`).bind(season, id, d, win ? 1 : 0, now).run();
  await upd(a.id, da, result === 'a');
  await upd(b.id, db_, result === 'b');
  return { a: { rate: ra + da, delta: da }, b: { rate: rb + db_, delta: db_ } };
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestGet({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  const q = new URL(request.url).searchParams;
  if (q.get('kind') === 'myrate') return json(await myRate(env.DB, q.get('id')));
  return json(await ranking(env.DB, q.get('id'), { season: q.get('season'), kind: q.get('kind') || 'best', offset: q.get('offset'), limit: q.get('limit') }));
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  const run = cleanRun(body);
  if (!run) return json({ error: 'bad-run' }, 400);
  const stored = await submit(env.DB, run);
  return json({ ok: true, season: CURRENT_SEASON, ...(stored ? {} : { ignored: true }) });
}

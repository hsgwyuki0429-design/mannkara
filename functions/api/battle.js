/**
 * オンライン対戦の API（Cloudflare Pages Functions。/api/battle で動く）。データは世界ランキングと同じ D1（DB という名前でつなぐ）。
 * 表は初めて使うときにここで作る。
 *
 * サーバーがするのは「相手を見つける」ことと「2 人の間でメッセージを渡す」ことだけ（ゲームはそれぞれの端末で動く）。
 * 対戦が始まると、端末どうしは WebRTC でじかにつながろうとする（つなぐための情報もここを通す）。じかにつながらない
 * ネットワークでは、このままここを通してメッセージを渡し続ける（client: src/ui/net.js）。
 *
 * すべて POST /api/battle { op, ... }:
 *   op 'match'  { me, name }         → だれでもよい相手を探す。待っている人がいればその部屋に入り（seat 2）、いなければ部屋を作って待つ（seat 1）
 *   op 'create' { me, name }         → 友だちと遊ぶ部屋を作る。4 けたの「あいことば」を返す
 *   op 'join'   { me, name, code }   → あいことばの部屋に入る
 *   op 'poll'   { key, after, wait } → 相手からのメッセージ（seq が after より後）と部屋の様子。何も無ければ wait ms まで待ってから返す
 *   op 'send'   { key, msgs }        → 相手へのメッセージ（JSON にできる値の配列）
 *   op 'leave'  { key }              → 部屋を出る
 *   op 'rated'  { me, name }         → レート戦の相手を探す（match と同じ。部屋の kind が 'rated'）
 *   op 'result' { key, result }      → レート戦の結果を知らせる（'win' / 'lose' / 'draw'）。2 人の知らせが合ったとき・負けた本人が「負け」と
 *                                       知らせたとき・勝った人の相手がもういないとき、に 1 回だけレートを動かす（2 人の増減の和は 0。ranking.js の rateDelta）。
 *                                       2 人の知らせが食い違ったら、その対戦はレートに数えない。
 *                                       → { status: 'pending' | 'done' | 'void', rate, delta }
 * 返り値の room: { id, seat, key, status: 'waiting' | 'playing' | 'closed', code, opponent: { name } | null, gone: 相手が来なくなった }
 * key は部屋に入った本人だけが知る合言葉（32 けたの 16 進）。これが無いとメッセージを送れない・読めない。
 * me（端末ごとの id）は、自分が作った部屋に自分で入らないためだけに使う
 */
import { cleanName, NAME_MAX, applyRated, myRate } from './ranking.js';
export { cleanName, NAME_MAX };
export const MSG_MAX = 8000;           // 1 つのメッセージの大きさ（JSON の文字数）
export const BATCH_MAX = 40;           // 1 回に送れるメッセージの数
export const ROOM_EVENTS_MAX = 20000;  // 1 部屋のメッセージの数の上限
export const WAIT_MAX = 6000;          // poll が待つ時間の上限（ms。待つ間も D1 を見直すので、1 回の呼び出しの CPU 時間を小さく保つ）
export const FRESH_MS = 12000;         // これより長く poll が来ない人は、もういないものとする
export const STALE_MS = 2 * 3600 * 1000;   // これより古い部屋は消す
export const SEEN_EVERY = 3000;        // 「まだいる」の書き込みは、これより間をあける（D1 への書き込みを減らす）

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...CORS },
});

export const validHex = (s, n) => typeof s === 'string' && new RegExp(`^[0-9a-f]{${n}}$`).test(s);
const hex = (bytes) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, '0')).join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ready = new WeakSet();
export async function ensureTables(db) {
  if (ready.has(db)) return;
  await db.prepare(`CREATE TABLE IF NOT EXISTS battle_rooms (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT, status TEXT NOT NULL,
    p1 TEXT NOT NULL, p1_name TEXT NOT NULL, p1_key TEXT NOT NULL, p1_seen INTEGER NOT NULL,
    p2 TEXT, p2_name TEXT, p2_key TEXT, p2_seen INTEGER,
    created INTEGER NOT NULL, updated INTEGER NOT NULL)`).run();
  await db.prepare('CREATE INDEX IF NOT EXISTS battle_rooms_wait ON battle_rooms (kind, status, created)').run();
  // レート戦ができる前の表には列が無いので足す
  const { results: cols } = await db.prepare('PRAGMA table_info(battle_rooms)').all();
  for (const [c, type] of [['p1_res', 'TEXT'], ['p2_res', 'TEXT'], ['rated_done', 'INTEGER NOT NULL DEFAULT 0'], ['rated', 'TEXT']]) {
    if (!cols.some((x) => x.name === c)) await db.prepare(`ALTER TABLE battle_rooms ADD COLUMN ${c} ${type}`).run();
  }
  await db.prepare('CREATE INDEX IF NOT EXISTS battle_rooms_p1key ON battle_rooms (p1_key)').run();
  await db.prepare('CREATE INDEX IF NOT EXISTS battle_rooms_p2key ON battle_rooms (p2_key)').run();
  await db.prepare(`CREATE TABLE IF NOT EXISTS battle_events (
    room TEXT NOT NULL, seq INTEGER NOT NULL, seat INTEGER NOT NULL, body TEXT NOT NULL, at INTEGER NOT NULL,
    PRIMARY KEY (room, seq))`).run();
  ready.add(db);
}

/** 古い部屋とメッセージを消す（ときどき） */
async function sweep(db, now, random = Math.random) {
  if (random() > 0.05) return;
  const old = now - STALE_MS;
  await db.prepare('DELETE FROM battle_events WHERE room IN (SELECT id FROM battle_rooms WHERE updated < ?1)').bind(old).run();
  await db.prepare('DELETE FROM battle_rooms WHERE updated < ?1').bind(old).run();
}

/** 部屋の様子（seat から見た相手） */
function view(row, seat, extra = {}) {
  const other = seat === 1 ? 2 : 1;
  const name = row[`p${other}_name`];
  return {
    id: row.id, seat, key: row[`p${seat}_key`], status: row.status, code: row.code ?? null,
    opponent: name ? { name } : null, ...extra,
  };
}

/** だれでもよい相手を探す: 待っている部屋（いちばん古い・まだいる・自分のではない）に入る。無ければ作って待つ */
export async function match(db, { me, name, kind = 'random' }, now = Date.now()) {
  await ensureTables(db);
  await sweep(db, now);
  const claimed = await claimRandom(db, { me, name, kind }, now, null);
  if (claimed) return claimed;
  return createRoom(db, { me, name, kind }, now);
}

async function claimRandom(db, { me, name, kind = 'random' }, now, newerThan) {
  const key = hex(16);
  // newerThan（自分が待っている部屋）より古い部屋だけ: 2 人が同時に部屋を作ったとき、新しいほうが古いほうへ移る（両方が移り合わない）
  const row = await db.prepare(`UPDATE battle_rooms SET p2 = ?1, p2_name = ?2, p2_key = ?3, p2_seen = ?4, status = 'playing', updated = ?4
    WHERE id = (SELECT id FROM battle_rooms WHERE kind = ?8 AND status = 'waiting' AND p1_seen > ?5 AND p1 != ?1
      AND (?6 IS NULL OR created < ?7 OR (created = ?7 AND id < ?6)) ORDER BY created, id LIMIT 1)
    AND status = 'waiting' RETURNING *`)
    .bind(me, name, key, now, now - FRESH_MS, newerThan?.id ?? null, newerThan?.created ?? 0, kind).first();
  return row ? view(row, 2) : null;
}

async function createRoom(db, { me, name, kind }, now) {
  for (let tries = 0; tries < 20; tries++) {
    const id = hex(8), key = hex(16);
    let code = null;
    if (kind === 'private') {
      code = String(1000 + Math.floor(Math.random() * 9000));
      const used = await db.prepare(`SELECT 1 FROM battle_rooms WHERE kind = 'private' AND code = ?1 AND status = 'waiting' AND p1_seen > ?2`)
        .bind(code, now - FRESH_MS).first();
      if (used) continue;
    }
    await db.prepare(`INSERT INTO battle_rooms (id, kind, code, status, p1, p1_name, p1_key, p1_seen, created, updated)
      VALUES (?1, ?2, ?3, 'waiting', ?4, ?5, ?6, ?7, ?7, ?7)`).bind(id, kind, code, me, name, key, now).run();
    return { id, seat: 1, key, status: 'waiting', code, opponent: null };
  }
  throw new Error('no-code');
}

/** 友だちと遊ぶ部屋を作る（あいことば = 4 けたの数字） */
export async function create(db, { me, name }, now = Date.now()) {
  await ensureTables(db);
  await sweep(db, now);
  return createRoom(db, { me, name, kind: 'private' }, now);
}

/** あいことばの部屋に入る（無ければ null） */
export async function join(db, { me, name, code }, now = Date.now()) {
  await ensureTables(db);
  if (!/^\d{4}$/.test(String(code ?? ''))) return null;
  const key = hex(16);
  const row = await db.prepare(`UPDATE battle_rooms SET p2 = ?1, p2_name = ?2, p2_key = ?3, p2_seen = ?4, status = 'playing', updated = ?4
    WHERE id = (SELECT id FROM battle_rooms WHERE kind = 'private' AND code = ?5 AND status = 'waiting' AND p1_seen > ?6 ORDER BY created DESC LIMIT 1)
    AND status = 'waiting' RETURNING *`).bind(me, name, key, now, String(code), now - FRESH_MS).first();
  return row ? view(row, 2) : null;
}

/** key から部屋と自分の席を探す */
export async function roomOf(db, key) {
  if (!validHex(key, 32)) return null;
  const row = await db.prepare('SELECT * FROM battle_rooms WHERE p1_key = ?1 OR p2_key = ?1 LIMIT 1').bind(key).first();
  return row ? { row, seat: row.p1_key === key ? 1 : 2 } : null;
}

/** 相手へのメッセージを足す */
export async function send(db, { key, msgs }, now = Date.now()) {
  await ensureTables(db);
  const found = await roomOf(db, key);
  if (!found) return { error: 'no-room' };
  const { row, seat } = found;
  if (row.status === 'closed') return { error: 'closed' };
  if (!Array.isArray(msgs) || !msgs.length || msgs.length > BATCH_MAX) return { error: 'bad-msgs' };
  const bodies = msgs.map((m) => JSON.stringify(m));
  if (bodies.some((b) => b.length > MSG_MAX)) return { error: 'too-big' };
  const count = await db.prepare('SELECT COUNT(*) AS n FROM battle_events WHERE room = ?1').bind(row.id).first();
  if (count.n + bodies.length > ROOM_EVENTS_MAX) return { error: 'full' };
  // seq は部屋ごとの通し番号（D1 は 1 つずつ順に実行するので、同時に送っても重ならない）
  for (const body of bodies) {
    await db.prepare(`INSERT INTO battle_events (room, seq, seat, body, at)
      VALUES (?1, (SELECT COALESCE(MAX(seq), 0) + 1 FROM battle_events WHERE room = ?1), ?2, ?3, ?4)`).bind(row.id, seat, body, now).run();
  }
  await touch(db, row, seat, now);
  return { ok: true };
}

async function touch(db, row, seat, now) {
  if (now - (row[`p${seat}_seen`] ?? 0) < SEEN_EVERY) return;
  await db.prepare(`UPDATE battle_rooms SET p${seat}_seen = ?1, updated = ?1 WHERE id = ?2`).bind(now, row.id).run();
  row[`p${seat}_seen`] = now;
}

/**
 * 相手からのメッセージ（seq > after）と部屋の様子。メッセージも部屋の様子の変化も無ければ、wait ms まで interval ごとに見直して待つ。
 * だれでもよい相手を待っている間に、もっと前から待っている人を見つけたら、そちらの部屋へ移る（moved: 移った先の部屋）
 */
export async function poll(db, { key, after = 0, wait = 0, interval = 400 }, now = () => Date.now()) {
  await ensureTables(db);
  let found = await roomOf(db, key);
  if (!found) return { error: 'no-room' };
  const startStatus = found.row.status, startOpp = found.row[`p${found.seat === 1 ? 2 : 1}_name`] ?? null;
  const deadline = now() + Math.min(WAIT_MAX, Math.max(0, Number(wait) || 0));
  after = Math.max(0, Math.floor(Number(after) || 0));
  interval = Math.min(3000, Math.max(400, Number(interval) || 500));
  for (;;) {
    const { row, seat } = found;
    await touch(db, row, seat, now());
    if ((row.kind === 'random' || row.kind === 'rated') && row.status === 'waiting') {
      const moved = await claimRandom(db, { me: row.p1, name: row.p1_name, kind: row.kind }, now(), row);
      if (moved) {
        await db.prepare(`UPDATE battle_rooms SET status = 'closed', updated = ?1 WHERE id = ?2`).bind(now(), row.id).run();
        return { room: moved, moved: true, events: [] };
      }
    }
    const { results } = await db.prepare(`SELECT seq, body FROM battle_events WHERE room = ?1 AND seat != ?2 AND seq > ?3 ORDER BY seq LIMIT 200`)
      .bind(row.id, seat, after).all();
    const other = seat === 1 ? 2 : 1;
    const gone = row.status === 'playing' && now() - (row[`p${other}_seen`] ?? 0) > FRESH_MS;
    const changed = row.status !== startStatus || (row[`p${other}_name`] ?? null) !== startOpp;
    if (results.length || changed || gone || now() >= deadline) {
      return { room: view(row, seat, { gone }), events: results.map((e) => ({ seq: e.seq, msg: JSON.parse(e.body) })) };
    }
    await sleep(Math.min(interval, Math.max(0, deadline - now())));
    found = await roomOf(db, key);
    if (!found) return { error: 'no-room' };
  }
}

/** 部屋を出る（待っている部屋は閉じる。対戦中なら相手には gone / closed で伝わる） */
export async function leave(db, { key }, now = Date.now()) {
  await ensureTables(db);
  const found = await roomOf(db, key);
  if (!found) return { ok: true };
  await db.prepare(`UPDATE battle_rooms SET status = 'closed', updated = ?1 WHERE id = ?2`).bind(now, found.row.id).run();
  return { ok: true };
}

/**
 * レート戦の結果。seat ごとに 'win' / 'lose' / 'draw' を残し、決まったら 1 回だけレートを動かす（rated_done を 0 → 1 にできた呼び出しだけが動かす）
 */
export async function result(db, { key, result: res }, now = Date.now()) {
  await ensureTables(db);
  if (!['win', 'lose', 'draw'].includes(res)) return { error: 'bad-result' };
  const found = await roomOf(db, key);
  if (!found) return { error: 'no-room' };
  const { seat } = found;
  let { row } = found;
  if (row.kind !== 'rated' || !row.p2) return { error: 'not-rated' };
  if (!row[`p${seat}_res`]) {
    await db.prepare(`UPDATE battle_rooms SET p${seat}_res = ?1, updated = ?2 WHERE id = ?3 AND p${seat}_res IS NULL`).bind(res, now, row.id).run();
    row = (await roomOf(db, key)).row;
  }
  const view = () => {
    if (row.rated_done === 2) return { status: 'void' };
    if (row.rated_done !== 1 || !row.rated) return { status: 'pending' };
    const r = JSON.parse(row.rated)[seat === 1 ? 'a' : 'b'];
    return { status: 'done', rate: r.rate, delta: r.delta };
  };
  if (row.rated_done) return view();
  const r1 = row.p1_res, r2 = row.p2_res;
  const gone = (s) => now - (row[`p${s}_seen`] ?? 0) > FRESH_MS;
  let outcome = null;                     // 'a' = seat 1 の勝ち / 'b' / 'draw' / 'void'
  if (r1 && r2) {
    if (r1 === 'win' && r2 === 'lose') outcome = 'a';
    else if (r1 === 'lose' && r2 === 'win') outcome = 'b';
    else if (r1 === 'draw' && r2 === 'draw') outcome = 'draw';
    else outcome = 'void';
  } else if (r1 === 'lose' || r2 === 'lose') outcome = r1 === 'lose' ? 'b' : 'a';       // 負けた本人の知らせは信じる
  else if (r1 && gone(2)) outcome = r1 === 'win' ? 'a' : 'draw';                        // 相手がもういない
  else if (r2 && gone(1)) outcome = r2 === 'win' ? 'b' : 'draw';
  if (!outcome) return view();
  const flip = await db.prepare('UPDATE battle_rooms SET rated_done = ?1, updated = ?2 WHERE id = ?3 AND rated_done = 0').bind(outcome === 'void' ? 2 : 1, now, row.id).run();
  if ((flip.meta?.changes ?? flip.changes ?? 0) === 1 && outcome !== 'void') {
    const rated = await applyRated(db, { id: row.p1, name: row.p1_name }, { id: row.p2, name: row.p2_name }, outcome, now);
    await db.prepare('UPDATE battle_rooms SET rated = ?1 WHERE id = ?2').bind(JSON.stringify(rated), row.id).run();
  }
  row = (await roomOf(db, key)).row;
  return view();
}

export async function onRequestOptions() { return new Response(null, { status: 204, headers: CORS }); }

export async function onRequestPost({ request, env }) {
  if (!env.DB) return json({ error: 'no-db' }, 503);
  let body;
  try { body = await request.json(); } catch { return json({ error: 'bad-json' }, 400); }
  if (!body || typeof body !== 'object') return json({ error: 'bad-json' }, 400);
  const db = env.DB;
  const who = () => {
    const name = cleanName(body.name);
    const me = validHex(body.me, 32) ? body.me : null;
    return name && me ? { me, name } : null;
  };
  try {
    switch (body.op) {
      case 'match': { const w = who(); if (!w) return json({ error: 'bad-player' }, 400); return json({ room: await match(db, w) }); }
      case 'create': { const w = who(); if (!w) return json({ error: 'bad-player' }, 400); return json({ room: await create(db, w) }); }
      case 'join': {
        const w = who(); if (!w) return json({ error: 'bad-player' }, 400);
        const room = await join(db, { ...w, code: body.code });
        return room ? json({ room }) : json({ error: 'no-room' }, 404);
      }
      case 'poll': {
        const res = await poll(db, { key: body.key, after: body.after, wait: body.wait, interval: body.interval });
        return res.error ? json(res, 404) : json(res);
      }
      case 'send': {
        const res = await send(db, { key: body.key, msgs: body.msgs });
        return res.error ? json(res, res.error === 'no-room' ? 404 : 400) : json(res);
      }
      case 'leave': return json(await leave(db, { key: body.key }));
      case 'rated': { const w = who(); if (!w) return json({ error: 'bad-player' }, 400); return json({ room: await match(db, { ...w, kind: 'rated' }), rate: await myRate(db, w.me) }); }
      case 'result': {
        const res = await result(db, { key: body.key, result: body.result });
        return res.error ? json(res, res.error === 'no-room' ? 404 : 400) : json(res);
      }
      default: return json({ error: 'bad-op' }, 400);
    }
  } catch (e) {
    return json({ error: 'server', detail: String(e?.message || e) }, 500);
  }
}

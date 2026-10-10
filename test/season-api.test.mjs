import test from 'node:test';
import assert from 'node:assert/strict';
import * as rk from '../functions/api/ranking.js?v=202610100228';
import * as bt from '../functions/api/battle.js?v=202610100228';
import * as admin from '../functions/api/admin.js?v=202610100228';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}
const skip = !sqlite && 'node:sqlite が無い';
function d1() {
  const raw = new sqlite.DatabaseSync(':memory:');
  return { raw, prepare(sql) {
    let args = [];
    const st = { bind: (...a) => { args = a; return st; },
      run: async () => raw.prepare(sql).run(...args), all: async () => ({ results: raw.prepare(sql).all(...args) }),
      first: async () => raw.prepare(sql).get(...args) ?? null };
    return st;
  } };
}
const A = 'a'.repeat(32), B = 'b'.repeat(32), C = 'c'.repeat(32);
const S = rk.CURRENT_SEASON;

test('今のシーズンは 2', () => { assert.equal(S, 2); });

test('レートの増減は、2 人を足すとかならず 0（イロレーティング）', () => {
  for (const [ra, rb] of [[1000, 1000], [1200, 950], [800, 1500], [1000, 1001]]) {
    for (const r of ['a', 'b', 'draw']) {
      const [da, db] = rk.rateDelta(ra, rb, r);
      assert.equal(da + db, 0, `${ra} vs ${rb} ${r}`);
      if (r === 'a') assert.ok(da >= 1);
      if (r === 'b') assert.ok(db >= 1);
    }
  }
  assert.deepEqual(rk.rateDelta(1000, 1000, 'a'), [16, -16], '同じレートなら ±16');
  assert.ok(rk.rateDelta(1400, 1000, 'a')[0] < rk.rateDelta(1000, 1400, 'a')[0], '強い人が勝っても少ししか増えない');
});

test('シーズン 2: ベスト・累計（送り直しで 2 回足さない）・ゲーム数', { skip }, async () => {
  const db = d1();
  await rk.submit(db, { season: S, id: A, name: 'あ', score: 500, add: 800, games: 2, seq: 1 }, 10);
  await rk.submit(db, { season: S, id: A, name: 'あ', score: 500, add: 800, games: 2, seq: 1 }, 11);   // 送り直し
  await rk.submit(db, { season: S, id: A, name: 'あ', score: 300, add: 300, games: 1, seq: 2 }, 12);
  await rk.submit(db, { season: S, id: B, name: 'び', score: 900, add: 900, games: 1, seq: 1 }, 13);
  const best = await rk.ranking(db, A, { kind: 'best' });
  assert.deepEqual(best.top.map((x) => [x.name, x.score]), [['び', 900], ['あ', 500]]);
  const total = await rk.ranking(db, A, { kind: 'total' });
  assert.deepEqual(total.top.map((x) => [x.name, x.score, x.games]), [['あ', 1100, 3], ['び', 900, 1]]);
  assert.deepEqual(total.me, { rank: 1, score: 1100, games: 3 });
});

test('前のシーズンの古い画面から送られた記録（season なし）は、どこにも書かない', { skip }, async () => {
  const db = d1();
  assert.equal(await rk.submit(db, { id: A, name: 'あ', score: 99999999 }, 1), false);
  assert.equal((await rk.ranking(db, A)).total, 0);
  const res = await rk.onRequestPost({ request: new Request('https://x.test/api/ranking', { method: 'POST', body: JSON.stringify({ id: A, name: 'あ', score: 5 }) }), env: { DB: db } });
  assert.equal((await res.json()).ignored, true);
});

test('シーズン 1 の結果は、前の表（players）のまま見られる（累計・レートは無い）', { skip }, async () => {
  const db = d1();
  await rk.ensureTable(db);
  db.raw.exec(`INSERT INTO players (id, name, score, score_at, updated) VALUES ('${A}', '一期の人', 123456789, 1, 1), ('${B}', '二位', 1000, 2, 2)`);
  const s1 = await rk.ranking(db, A, { season: 1, kind: 'total' });
  assert.equal(s1.season, 1);
  assert.equal(s1.kind, 'best');
  assert.deepEqual(s1.top.map((x) => [x.rank, x.name, x.score, x.me]), [[1, '一期の人', 123456789, true], [2, '二位', 1000, false]]);
  assert.equal((await rk.ranking(db, A)).total, 0, 'シーズン 2 は空から');
  const res = await rk.onRequestGet({ request: new Request(`https://x.test/api/ranking?season=1&id=${A}`), env: { DB: db } });
  assert.equal((await res.json()).top[0].name, '一期の人');
});

test('名前を隠すと、どのシーズンの表でも隠れる', { skip }, async () => {
  const db = d1();
  await rk.ensureTable(db);
  db.raw.exec(`INSERT INTO players (id, name, score, score_at, updated) VALUES ('${A}', 'わるい', 50, 1, 1)`);
  await rk.submit(db, { season: S, id: A, name: 'わるい', score: 10, add: 10, games: 1, seq: 1 }, 5);
  assert.equal(await admin.setHidden(db, A, true), true);
  assert.equal((await rk.ranking(db, null, { season: 1 })).top[0].name, rk.HIDDEN_NAME);
  assert.equal((await rk.ranking(db, null, { kind: 'total' })).top[0].name, rk.HIDDEN_NAME);
  assert.equal((await admin.adminList(db, { season: 1 })).players[0].hidden, true);
  assert.equal((await admin.adminList(db, {})).season, S);
});

/** レート戦を 1 つ作って、2 人が入った状態にする */
async function ratedRoom(db, t = 1000) {
  const a = (await bt.match(db, { me: A, name: 'あ', kind: 'rated' }, t));
  const b = (await bt.match(db, { me: B, name: 'び', kind: 'rated' }, t + 10));
  assert.equal(a.id, b.id);
  return { a, b };
}

test('レート戦: だれでもよい相手とは別に探す', { skip }, async () => {
  const db = d1();
  const r = await bt.match(db, { me: A, name: 'あ' }, 1000);
  const q = await bt.match(db, { me: B, name: 'び', kind: 'rated' }, 1010);
  assert.notEqual(r.id, q.id);
  assert.equal(q.seat, 1);
});

test('レート戦: 2 人の結果が合ったら 1 回だけレートが動き、和は 0', { skip }, async () => {
  const db = d1();
  const { a, b } = await ratedRoom(db);
  assert.deepEqual(await bt.result(db, { key: a.key, result: 'win' }, 2000), { status: 'pending' });
  const rb = await bt.result(db, { key: b.key, result: 'lose' }, 2001);
  assert.deepEqual(rb, { status: 'done', rate: 984, delta: -16 });
  const ra = await bt.result(db, { key: a.key, result: 'win' }, 2002);
  assert.deepEqual(ra, { status: 'done', rate: 1016, delta: 16 });
  const rate = await rk.ranking(db, A, { kind: 'rate' });
  assert.deepEqual(rate.top.map((x) => [x.name, x.score, x.games, x.wins]), [['あ', 1016, 1, 1], ['び', 984, 1, 0]]);
  // 2 戦目（新しい部屋）
  const second = await ratedRoom(db, 5000);
  await bt.result(db, { key: second.b.key, result: 'win' }, 6000);
  const done = await bt.result(db, { key: second.a.key, result: 'lose' }, 6001);
  assert.equal(done.status, 'done');
  const mine = await rk.myRate(db, A), theirs = await rk.myRate(db, B);
  assert.equal(mine.rate + theirs.rate, 2000, '何戦しても 2 人の合計は変わらない');
});

test('レート戦: 負けた本人の「負け」だけで決まる・勝った人の相手がいなくなったら決まる・食い違ったら数えない', { skip }, async () => {
  let db = d1();
  let { a, b } = await ratedRoom(db);
  assert.equal((await bt.result(db, { key: b.key, result: 'lose' }, 2000)).status, 'done');
  assert.equal((await rk.myRate(db, A)).rate, 1016);
  db = d1();
  ({ a, b } = await ratedRoom(db, 1000));
  assert.equal((await bt.result(db, { key: a.key, result: 'win' }, 2000)).status, 'pending', '相手がまだいるうちは待つ');
  assert.equal((await bt.result(db, { key: a.key, result: 'win' }, 1010 + bt.FRESH_MS + 100)).status, 'done', '相手が来なくなった');
  db = d1();
  ({ a, b } = await ratedRoom(db, 1000));
  await bt.result(db, { key: a.key, result: 'win' }, 2000);
  assert.deepEqual(await bt.result(db, { key: b.key, result: 'win' }, 2001), { status: 'void' });
  assert.equal((await rk.myRate(db, A)).rate, rk.START_RATE);
  assert.deepEqual(await bt.result(db, { key: a.key, result: 'maybe' }), { error: 'bad-result' });
});

test('レート戦でない部屋は、結果を受け付けない', { skip }, async () => {
  const db = d1();
  const a = await bt.match(db, { me: A, name: 'あ' }, 1000);
  await bt.match(db, { me: B, name: 'び' }, 1001);
  assert.deepEqual(await bt.result(db, { key: a.key, result: 'win' }), { error: 'not-rated' });
});

test('前からある対戦の表にも、レート戦の列が足される', { skip }, async () => {
  const db = d1();
  db.raw.exec(`CREATE TABLE battle_rooms (id TEXT PRIMARY KEY, kind TEXT NOT NULL, code TEXT, status TEXT NOT NULL,
    p1 TEXT NOT NULL, p1_name TEXT NOT NULL, p1_key TEXT NOT NULL, p1_seen INTEGER NOT NULL,
    p2 TEXT, p2_name TEXT, p2_key TEXT, p2_seen INTEGER, created INTEGER NOT NULL, updated INTEGER NOT NULL)`);
  const { a, b } = await ratedRoom(db);
  await bt.result(db, { key: a.key, result: 'win' }, 2000);
  assert.equal((await bt.result(db, { key: b.key, result: 'lose' }, 2001)).status, 'done');
  void C;
});

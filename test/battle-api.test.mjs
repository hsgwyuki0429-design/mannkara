import test from 'node:test';
import assert from 'node:assert/strict';
import * as api from '../functions/api/battle.js?v=202610091103';

let sqlite = null;
try { sqlite = await import('node:sqlite'); } catch {}

/** D1 の代わりに node:sqlite（使えない Node では飛ばす） */
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
const skip = !sqlite && 'node:sqlite が無い';

test('名前と id の確かめ方', () => {
  assert.equal(api.cleanName('  あい\u0000う  '), 'あいう');
  assert.equal(api.cleanName(''), null);
  assert.equal(api.validHex(A, 32), true);
  assert.equal(api.validHex('xyz', 32), false);
});

test('だれでもよい相手: 1 人目は部屋を作って待ち、2 人目がその部屋に入る', { skip }, async () => {
  const db = d1();
  const a = await api.match(db, { me: A, name: 'あい' }, 1000);
  assert.equal(a.seat, 1);
  assert.equal(a.status, 'waiting');
  assert.equal(a.opponent, null);
  const b = await api.match(db, { me: B, name: 'びー' }, 2000);
  assert.equal(b.seat, 2);
  assert.equal(b.id, a.id);
  assert.equal(b.status, 'playing');
  assert.deepEqual(b.opponent, { name: 'あい' });
  const p = await api.poll(db, { key: a.key }, () => 2500);
  assert.equal(p.room.status, 'playing');
  assert.deepEqual(p.room.opponent, { name: 'びー' });
});

test('自分の部屋には自分で入らない・いなくなった人の部屋には入らない', { skip }, async () => {
  const db = d1();
  await api.match(db, { me: A, name: 'a' }, 1000);
  const again = await api.match(db, { me: A, name: 'a' }, 1500);
  assert.equal(again.seat, 1, '同じ端末はもう 1 つ部屋を作る');
  const late = await api.match(db, { me: B, name: 'b' }, 1000 + api.FRESH_MS + 5000);
  assert.equal(late.seat, 1, '12 秒より前から poll していない部屋には入らない');
});

test('2 人が同時に部屋を作ったら、新しいほうが古いほうへ移る', { skip }, async () => {
  const db = d1();
  // 2 人とも、相手の部屋ができる前に探したことにする（それぞれ部屋を作る）
  const a = await api.match(db, { me: A, name: 'a' }, 1000);
  db.raw.prepare("UPDATE battle_rooms SET status = 'hold'").run();
  const b = await api.match(db, { me: B, name: 'b' }, 1001);
  db.raw.prepare("UPDATE battle_rooms SET status = 'waiting' WHERE status = 'hold'").run();
  assert.notEqual(a.id, b.id);
  const pa = await api.poll(db, { key: a.key }, () => 1200);
  assert.equal(pa.moved, undefined, '古いほうは動かない');
  const pb = await api.poll(db, { key: b.key }, () => 1300);
  assert.equal(pb.moved, true, '新しいほうが古い部屋へ移る');
  assert.equal(pb.room.id, a.id);
  assert.equal(pb.room.seat, 2);
  const pa2 = await api.poll(db, { key: a.key }, () => 1400);
  assert.deepEqual(pa2.room.opponent, { name: 'b' });
});

test('あいことばの部屋: 作った人と、あいことばを知っている人だけが入れる', { skip }, async () => {
  const db = d1();
  const a = await api.create(db, { me: A, name: 'a' }, 1000);
  assert.match(a.code, /^\d{4}$/);
  assert.equal(await api.join(db, { me: B, name: 'b', code: a.code === '1234' ? '1235' : '1234' }, 1100), null, '違うあいことば');
  assert.equal(await api.join(db, { me: B, name: 'b', code: 'abcd' }, 1100), null);
  const b = await api.join(db, { me: B, name: 'b', code: a.code }, 1200);
  assert.equal(b.id, a.id);
  assert.equal(b.seat, 2);
  assert.equal(await api.join(db, { me: C, name: 'c', code: a.code }, 1300), null, '3 人目は入れない');
  const m = await api.match(db, { me: C, name: 'c' }, 1300);
  assert.notEqual(m.id, a.id, 'だれでもよい相手の探し方では、あいことばの部屋に入らない');
});

test('メッセージ: 相手のものだけが、送った順に届く（after で続きから）', { skip }, async () => {
  const db = d1();
  const a = await api.match(db, { me: A, name: 'a' }, 1000);
  const b = await api.match(db, { me: B, name: 'b' }, 1100);
  assert.deepEqual(await api.send(db, { key: a.key, msgs: [{ t: 'hello' }, { t: 'x', n: 1 }] }, 1200), { ok: true });
  await api.send(db, { key: b.key, msgs: [{ t: 'hi' }] }, 1250);
  await api.send(db, { key: a.key, msgs: [{ t: 'x', n: 2 }] }, 1300);
  const pb = await api.poll(db, { key: b.key, after: 0 }, () => 1400);
  assert.deepEqual(pb.events.map((e) => e.msg), [{ t: 'hello' }, { t: 'x', n: 1 }, { t: 'x', n: 2 }]);
  const last = pb.events.at(-1).seq;
  assert.deepEqual((await api.poll(db, { key: b.key, after: last }, () => 1500)).events, []);
  const pa = await api.poll(db, { key: a.key, after: 0 }, () => 1500);
  assert.deepEqual(pa.events.map((e) => e.msg), [{ t: 'hi' }]);
});

test('合言葉が違えば送れない・読めない。大きすぎるメッセージははねる', { skip }, async () => {
  const db = d1();
  const a = await api.match(db, { me: A, name: 'a' }, 1000);
  assert.deepEqual(await api.send(db, { key: 'f'.repeat(32), msgs: [{ t: 1 }] }), { error: 'no-room' });
  assert.deepEqual(await api.poll(db, { key: 'nope' }), { error: 'no-room' });
  assert.deepEqual(await api.send(db, { key: a.key, msgs: [{ t: 'x'.repeat(api.MSG_MAX) }] }), { error: 'too-big' });
  assert.deepEqual(await api.send(db, { key: a.key, msgs: [] }), { error: 'bad-msgs' });
});

test('poll は、何も無ければ待ってから返し、相手のメッセージが来たらすぐ返す', { skip }, async () => {
  const db = d1();
  const a = await api.match(db, { me: A, name: 'a' }, Date.now());
  const b = await api.match(db, { me: B, name: 'b' }, Date.now());
  const t0 = Date.now();
  const empty = await api.poll(db, { key: b.key, wait: 600, interval: 250 });
  assert.ok(Date.now() - t0 >= 550, '何も無ければ wait まで待つ');
  assert.deepEqual(empty.events, []);
  const t1 = Date.now();
  const p = api.poll(db, { key: b.key, wait: 5000, interval: 250 });
  setTimeout(() => api.send(db, { key: a.key, msgs: [{ t: 'go' }] }), 300);
  const res = await p;
  assert.ok(Date.now() - t1 < 2000, 'メッセージが来たらすぐ返る');
  assert.deepEqual(res.events.map((e) => e.msg), [{ t: 'go' }]);
});

test('出ていった・来なくなった相手は分かる', { skip }, async () => {
  const db = d1();
  const a = await api.match(db, { me: A, name: 'a' }, 1000);
  const b = await api.match(db, { me: B, name: 'b' }, 1100);
  const gone = await api.poll(db, { key: b.key }, () => 1100 + api.FRESH_MS + 1000);
  assert.equal(gone.room.gone, true, '相手の poll が来なくなった');
  await api.leave(db, { key: a.key }, 2000);
  const closed = await api.poll(db, { key: b.key }, () => 2100);
  assert.equal(closed.room.status, 'closed');
  assert.deepEqual(await api.send(db, { key: b.key, msgs: [{ t: 1 }] }), { error: 'closed' });
});

test('HTTP: POST の op ごと・おかしな入力は 400', { skip }, async () => {
  const db = d1();
  const call = async (body) => {
    const res = await api.onRequestPost({ request: new Request('https://x.test/api/battle', { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) }), env: { DB: db } });
    return { status: res.status, body: await res.json() };
  };
  assert.equal((await call('{')).status, 400);
  assert.equal((await call({ op: 'match', me: 'x', name: 'a' })).status, 400);
  assert.equal((await call({ op: 'what' })).status, 400);
  const m = await call({ op: 'match', me: A, name: 'あ' });
  assert.equal(m.status, 200);
  assert.equal(m.body.room.seat, 1);
  assert.equal((await call({ op: 'join', me: B, name: 'b', code: '0000' })).status, 404);
  const s = await call({ op: 'send', key: m.body.room.key, msgs: [{ t: 'a' }] });
  assert.equal(s.status, 200);
  const noDb = await api.onRequestPost({ request: new Request('https://x.test/api/battle', { method: 'POST', body: '{}' }), env: {} });
  assert.equal(noDb.status, 503);
});

test('通信（net.js）: 中継だけでも、2 人が見つかり、メッセージが順番どおり 1 回ずつ届く', { skip }, async () => {
  globalThis.location ??= { hostname: 'localhost', origin: 'http://localhost' };
  const { BattleNet } = await import('../src/ui/net.js?v=202610091103');
  const db = d1();
  const fetchImpl = async (url, init) => api.onRequestPost({ request: new Request('https://x.test/api/battle', { method: 'POST', body: init.body }), env: { DB: db } });
  const a = new BattleNet({ me: A, name: 'あ', fetchImpl, relayOnly: true });
  const b = new BattleNet({ me: B, name: 'び', fetchImpl, relayOnly: true });
  const ra = a.matchRandom();
  await new Promise((r) => setTimeout(r, 100));
  const [roomA, roomB] = await Promise.all([ra, b.matchRandom()]);
  assert.equal(roomA.id, roomB.id);
  assert.deepEqual([roomA.opponent.name, roomB.opponent.name], ['び', 'あ']);
  const gotA = [], gotB = [];
  a.onMessage = (m) => gotA.push(m);
  b.onMessage = (m) => gotB.push(m);
  a.start(); b.start();
  for (let i = 0; i < 25; i++) a.send({ t: 'n', i });
  b.send({ t: 'hello' });
  const until = async (f, ms = 8000) => { const t0 = Date.now(); while (!f() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 30)); };
  await until(() => gotB.length >= 25 && gotA.length >= 1);
  assert.deepEqual(gotB.map((m) => m.i), Array.from({ length: 25 }, (_, i) => i));
  assert.deepEqual(gotA, [{ t: 'hello' }]);
  // 同じ包みが 2 回届いても 1 回しか渡さない（道の切り替えで送り直したとき）
  b.receive({ m: 1, d: { t: 'n', i: 0 } });
  assert.equal(gotB.length, 25);
  await until(() => a.outbox.size === 0);
  assert.equal(a.outbox.size, 0, '届いたものは送り直し用の控えから消える（ack）');
  let goneB = null;
  b.onGone = (r) => { goneB = r; };
  await a.cancel();
  await until(() => goneB);
  assert.equal(goneB, 'left');
  await b.cancel();
});

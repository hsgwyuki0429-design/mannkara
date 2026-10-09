/**
 * オンライン対戦の通信（サーバーは functions/api/battle.js）。
 *  1. サーバーで相手を見つける（だれでもよい相手 / あいことばの部屋）
 *  2. 見つかったら、まずサーバーを通してメッセージを渡しはじめ（中継）、同時に WebRTC で端末どうしをじかにつなぐ
 *     （つなぐための情報も中継で渡す）。じかにつながったら、そちらで送る（速い・サーバーを使わない）。
 *     つながらないネットワーク（会社・学校の回線など）では中継のまま続ける
 *  3. どちらの道を通っても、メッセージは送った順に 1 回ずつ届く（番号 mid を付け、届いた番号を ack で返す。道が切り替わったら、
 *     まだ届いたと言われていないものを新しい道で送り直す。重なって届いたものは捨てる）
 * 相手からのメッセージは onMessage(msg)。相手がいなくなったら onGone(reason)（'left' 出ていった / 'lost' 通信が途切れた）
 */
import { apiBase } from './world.js?v=202610091214';

export const PROTOCOL = 2;          // 2: 対戦のルールを変えた（同じ順番の手駒・使った枠にすぐ補充・おじゃまは連鎖が終わったらすぐ）
const ICE_SERVERS = [{ urls: 'stun:stun.cloudflare.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }];
const GATHER_MS = 2500;          // つなぐ候補を集める時間の上限
const P2P_GIVE_UP_MS = 9000;     // これまでにじかにつながらなければ、中継のまま
const PING_P2P_MS = 1000, PING_RELAY_MS = 3000;
const LOST_MS = 15000;           // これだけ何も届かなければ、通信が途切れた
const WAIT_MS = 6000;            // 中継の poll が待つ時間

export class BattleNet {
  /** me = 端末の id（32 けたの 16 進）、name = なまえ。fetchImpl / RTC はテスト用に差し替えられる */
  constructor({ me, name, api = null, fetchImpl = null, RTC = globalThis.RTCPeerConnection, relayOnly = false }) {
    this.me = me; this.name = name;
    this.api = api ?? (apiBase() + 'battle');
    this.fetch = fetchImpl ?? ((...a) => fetch(...a));
    this.RTC = relayOnly ? null : RTC;
    this.room = null;
    this.closed = false;
    this.onMessage = null; this.onGone = null; this.onTransport = null; this.onWaiting = null;
    this.resetStream();
  }
  resetStream() {
    this.mid = 0;                 // 送ったメッセージの番号
    this.outbox = new Map();      // まだ届いたと言われていない mid -> メッセージ
    this.recv = 0;                // 届いて渡し終えた番号
    this.early = new Map();       // 先に届いた（順番がとんだ）もの
    this.lastSeq = 0;             // 中継で読んだところ
    this.relayQueue = [];
    this.lastHeard = Date.now();
    this.transport = 'relay';
    this.rtt = 0;
  }

  async call(body) {
    const res = await this.fetch(this.api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
    let data = null;
    try { data = await res.json(); } catch {}
    if (!res.ok) throw Object.assign(new Error(data?.error || `HTTP ${res.status}`), { status: res.status, code: data?.error });
    return data;
  }

  /* ---------- 相手を見つける ---------- */
  /** だれでもよい相手。見つかったら room（opponent つき）で解決する。cancel() で null */
  async matchRandom() { return this.waitFor(await this.call({ op: 'match', me: this.me, name: this.name })); }
  /** あいことばの部屋を作る。作れたら onWaiting(room)（room.code）。相手が来たら解決する */
  async createRoom() { return this.waitFor(await this.call({ op: 'create', me: this.me, name: this.name })); }
  /** あいことばの部屋に入る（無ければ 'no-room' のエラー） */
  async joinRoom(code) { return this.waitFor(await this.call({ op: 'join', me: this.me, name: this.name, code: String(code) })); }
  /** レート戦の相手（だれでもよい相手と同じ探し方で、レート戦どうし）。自分のレートは this.rate */
  async matchRated() {
    const res = await this.call({ op: 'rated', me: this.me, name: this.name });
    this.rate = res.rate?.rate ?? null;
    return this.waitFor(res);
  }
  /**
   * レート戦の結果を知らせる（'win' / 'lose' / 'draw'）。相手の知らせを待つあいだは少しずつ聞き直す（最大 waitMs）。
   * → { status: 'done', rate, delta } / { status: 'void' } / { status: 'pending' }（決まらなかった）
   */
  async reportResult(result, waitMs = 25000) {
    const key = this.room?.key;
    if (!key) return { status: 'pending' };
    const until = Date.now() + waitMs;
    for (;;) {
      let res = null;
      try { res = await this.call({ op: 'result', key, result }); } catch {}
      if (res && res.status !== 'pending') return res;
      if (Date.now() > until) return res ?? { status: 'pending' };
      await sleep(1500);
    }
  }

  async waitFor({ room }) {
    this.room = room;
    if (this.closed) { this.call({ op: 'leave', key: room.key }).catch(() => {}); return null; }   // 探している途中でやめた（できた部屋に人が入らないように）
    if (room.opponent) return room;
    this.onWaiting?.(room);
    while (!this.closed) {
      let res;
      try { res = await this.call({ op: 'poll', key: this.room.key, after: 0, wait: WAIT_MS, interval: 700 }); }
      catch (e) { if (e.status === 404) throw e; await sleep(1500); continue; }
      if (this.closed) break;
      this.room = res.room;
      if (res.room.opponent && res.room.status === 'playing') return res.room;
      if (res.room.status === 'closed') throw Object.assign(new Error('closed'), { code: 'closed' });
    }
    return null;
  }

  /** 探すのをやめる・部屋を出る */
  async cancel() {
    this.closed = true;
    this.stopP2P();
    clearInterval(this.pingTimer);
    const key = this.room?.key;
    if (key) {
      try { await this.call({ op: 'leave', key }); } catch {}
    }
  }
  close() { return this.cancel(); }

  /* ---------- 対戦中のメッセージ ---------- */
  /** 相手が見つかったあとに呼ぶ: 中継の poll を始め、じかにつなぐのを試す */
  start() {
    this.lastHeard = Date.now();
    this.relayLoop();
    if (this.RTC && this.room.seat === 1) this.offer().catch((e) => { console.warn('p2p', e); this.stopP2P(); });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => this.heartbeat(), 500);
    this.p2pDeadline = setTimeout(() => { if (this.transport !== 'p2p') this.stopP2P(); }, P2P_GIVE_UP_MS);
  }

  /** 相手へ（届いた順・1 回ずつ） */
  send(msg) {
    if (this.closed) return;
    const m = ++this.mid;
    const env = { m, d: msg };
    this.outbox.set(m, env);
    this.transmit(env);
  }
  transmit(env) {
    env.a = this.recv;
    if (this.transport === 'p2p' && this.dc?.readyState === 'open') {
      try { this.dc.send(JSON.stringify(env)); return; } catch { this.fallBack(); }
    }
    this.relayQueue.push(env);
    this.flushSoon();
  }
  flushSoon() {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), 25);
  }
  async flush() {
    this.flushTimer = null;
    if (!this.relayQueue.length || this.closed || this.flushing) return;
    this.flushing = true;
    const batch = this.relayQueue.splice(0, 30);
    try {
      await this.call({ op: 'send', key: this.room.key, msgs: batch });
    } catch (e) {
      if (e.code === 'closed' || e.status === 404) { this.gone('left'); return; }
      this.relayQueue.unshift(...batch.filter((env) => env.m == null || this.outbox.has(env.m)));
      await sleep(800);
    } finally {
      this.flushing = false;
    }
    if (this.relayQueue.length) this.flushSoon();
  }

  /** 届いた包み（どちらの道からでも） */
  receive(env) {
    if (!env || typeof env !== 'object') return;
    this.lastHeard = Date.now();
    if (typeof env.a === 'number') for (const m of [...this.outbox.keys()]) if (m <= env.a) this.outbox.delete(m);
    if (env.p != null) { this.transmitControl({ q: env.p }); return; }
    if (env.q != null) { this.rtt = Date.now() - env.q; return; }
    if (env.m == null || env.m <= this.recv) return;
    this.early.set(env.m, env.d);
    while (this.early.has(this.recv + 1)) {
      const d = this.early.get(this.recv + 1);
      this.early.delete(++this.recv);
      if (d?.t === 'sig') this.onSignal(d).catch((e) => { console.warn('p2p', e); this.stopP2P(); });
      else this.onMessage?.(d);
      if (this.closed) return;
    }
  }
  /** 届いたかどうかは数えない包み（ack と ping） */
  transmitControl(env) {
    env.a = this.recv;
    if (this.transport === 'p2p' && this.dc?.readyState === 'open') { try { this.dc.send(JSON.stringify(env)); return; } catch {} }
    this.relayQueue.push(env);
    this.flushSoon();
  }
  heartbeat() {
    if (this.closed) return;
    const now = Date.now();
    if (now - this.lastHeard > LOST_MS) { this.gone('lost'); return; }
    const every = this.transport === 'p2p' ? PING_P2P_MS : PING_RELAY_MS;
    if (now - (this.pingAt || 0) >= every) { this.pingAt = now; this.transmitControl({ p: now }); }
  }

  async relayLoop() {
    while (!this.closed && this.room) {
      let res;
      try {
        res = await this.call({ op: 'poll', key: this.room.key, after: this.lastSeq, wait: WAIT_MS, interval: this.transport === 'p2p' ? 2500 : 450 });
      } catch (e) {
        if (this.closed) return;
        if (e.status === 404) { this.gone('left'); return; }
        await sleep(1200);
        continue;
      }
      if (this.closed) return;
      for (const ev of res.events) {
        this.lastSeq = Math.max(this.lastSeq, ev.seq);
        this.receive(ev.msg);
        if (this.closed) return;
      }
      if (res.room.status === 'closed') { this.gone('left'); return; }
      if (res.room.gone) { this.gone('lost'); return; }
    }
  }

  gone(reason) {
    if (this.closed) return;
    this.closed = true;
    this.stopP2P();
    clearInterval(this.pingTimer);
    this.onGone?.(reason);
  }

  /* ---------- WebRTC（じかにつなぐ） ---------- */
  makePC() {
    const pc = new this.RTC({ iceServers: ICE_SERVERS });
    this.pc = pc;
    pc.onconnectionstatechange = () => {
      if (['failed', 'closed'].includes(pc.connectionState) && this.pc === pc) this.fallBack();
    };
    return pc;
  }
  bindDC(dc) {
    this.dc = dc;
    dc.onopen = () => {
      if (this.closed || this.dc !== dc) return;
      this.transport = 'p2p';
      this.onTransport?.('p2p');
      for (const env of this.outbox.values()) this.transmit(env);       // 中継で送ったまま届いたと言われていないものを、こちらで送り直す
    };
    dc.onmessage = (e) => { try { this.receive(JSON.parse(e.data)); } catch {} };
    dc.onclose = () => { if (this.dc === dc) this.fallBack(); };
  }
  async gather(pc) {
    if (pc.iceGatheringState === 'complete') return;
    await new Promise((resolve) => {
      const t = setTimeout(resolve, GATHER_MS);
      pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); } });
    });
  }
  async offer() {
    const pc = this.makePC();
    this.bindDC(pc.createDataChannel('game', { ordered: true }));
    await pc.setLocalDescription(await pc.createOffer());
    await this.gather(pc);
    if (this.closed || this.pc !== pc) return;
    this.send({ t: 'sig', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
  }
  async onSignal({ sdp }) {
    if (!this.RTC || this.closed || !sdp) return;
    if (sdp.type === 'offer') {
      const pc = this.makePC();
      pc.ondatachannel = (e) => this.bindDC(e.channel);
      await pc.setRemoteDescription(sdp);
      await pc.setLocalDescription(await pc.createAnswer());
      await this.gather(pc);
      if (this.closed || this.pc !== pc) return;
      this.send({ t: 'sig', sdp: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
    } else if (sdp.type === 'answer' && this.pc && !this.pc.currentRemoteDescription) {
      await this.pc.setRemoteDescription(sdp);
    }
  }
  /** じかの道が切れた: 中継に戻し、まだ届いていないものを中継で送り直す */
  fallBack() {
    const was = this.transport;
    this.stopP2P();
    if (was === 'p2p' && !this.closed) {
      this.onTransport?.('relay');
      for (const env of this.outbox.values()) this.transmit(env);
    }
  }
  stopP2P() {
    clearTimeout(this.p2pDeadline);
    this.transport = 'relay';
    const pc = this.pc, dc = this.dc;
    this.pc = null; this.dc = null;
    try { dc?.close(); } catch {}
    try { pc?.close(); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

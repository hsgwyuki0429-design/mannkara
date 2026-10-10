import { BattleSide, BATTLE_SPEED, BATTLE_TIGHT_RATE, BATTLE_ALL_CLEAR_RATE, marginBlocks, marginStartOf, MARGIN_MS, MARGIN_MAX, packBoard, unpackBoard, samePack } from '../core/battle.js?v=202610100117';
import { Game } from '../core/game.js?v=202610100117';
import { Piece, seedOf } from '../core/pieces.js?v=202610100117';
import { createGarbage } from '../core/board.js?v=202610100117';
import { isInside } from '../core/constants.js?v=202610100117';
import { OppBoard, turnCost } from './opp-board.js?v=202610100117';
import { TrayDealer } from './tray-dealer.js?v=202610100117';
import { Renderer } from './renderer.js?v=202610100117';
import { PROTOCOL } from './net.js?v=202610100117';
import { track } from './analytics.js?v=202610100117';

/**
 * 対戦の画面側（ルールは core/battle.js）。相手は CPU か、オンラインのだれか（net.js）。
 *  - 自分の盤面はふだんと同じ（main.js）。相手の盤面も同じ描き方で、自分の盤面の上に同じ大きさで映す（opp-board.js）
 *  - 相手から飛んできたおじゃまは、自分の盤面の上に「予告」として並ぶ（相手の連鎖が終わるまでは薄く、終わったら濃く）
 *  - 3・2・1・GO で始まり、置けなくなったほうの負け。結果のカードから「もう一度」（同じ相手と）・「ホームへ」
 * main.js とは api（自分のゲーム・描画・音・入力のロックなど）でつながる
 */
export const BATTLE_RATES = { tight: BATTLE_TIGHT_RATE, allClear: BATTLE_ALL_CLEAR_RATE };
/** CPU の強さ: 考える時間（ms の幅）・一番良い手を選ぶ割合（残りは、良い手の上のほうからでたらめに）・先読みの時間 */
export const CPU_LEVELS = {
  easy: { name: 'よわい', think: [2700, 4300], best: 0.3, spread: 0.6, budget: 0 },
  normal: { name: 'ふつう', think: [1800, 2900], best: 0.7, spread: 0.25, budget: 20 },
  hard: { name: 'つよい', think: [1000, 1700], best: 1, spread: 0, budget: 60 },
};
const RECORD_KEY = 'blockmancala-versus';
const COUNT_MS = 800;              // カウントダウンの 1 つぶん
/** タブレットの横向き（styles.css と同じ条件。相手の盤面は自分の盤面の右に並べる） */
const WIDE = '(min-width:900px) and (min-aspect-ratio:4/3)';

/** 一時停止できる時計（CPU との対戦は一時停止できる） */
class Clock {
  constructor() { this.offset = 0; this.pausedAt = null; }
  now() { return (this.pausedAt ?? performance.now()) - this.offset; }
  pause() { if (this.pausedAt == null) this.pausedAt = performance.now(); }
  resume() { if (this.pausedAt != null) { this.offset += performance.now() - this.pausedAt; this.pausedAt = null; } }
}

export function readRecords() {
  try { return { cpu: {}, online: { w: 0, l: 0 }, ...JSON.parse(localStorage.getItem(RECORD_KEY) || '{}') }; } catch { return { cpu: {}, online: { w: 0, l: 0 } }; }
}
function saveRecord(kind, level, result) {
  const rec = readRecords();
  const slot = kind === 'cpu' ? (rec.cpu[level] ??= { w: 0, l: 0 }) : rec.online;
  if (result === 'win') slot.w++; else if (result === 'lose') slot.l++;
  try { localStorage.setItem(RECORD_KEY, JSON.stringify(rec)); } catch {}
  return rec;
}

export class Versus {
  /**
   * api（main.js）: game / renderer / sfx / $ / myName() / enter() 対戦の画面にして新しいゲーム / restart() 同じ対戦でもう一度 /
   * exit() ホームへ / lock(bool) 手駒を触れなくする / enqueueDrop(res) おじゃまが落ちるのを再生の列に並べる /
   * playLeft() 自分の再生の残り ms / setPaused(bool) / workerUrl
   */
  constructor(api) {
    this.api = api;
    const $ = api.$;
    this.$ = $;
    this.active = false;
    this.view = new OppBoard($('vsOppField'));
    this.timers = [];
    this.tickTimer = 0;
    this.series = null;
    $('vsRematch').addEventListener('click', () => { api.sfx.unlock(); this.rematch(); });
    $('vsHome').addEventListener('click', () => { api.sfx.unlock(); this.exit(); });
    window.addEventListener('resize', () => { if (this.active) this.layout(); });
  }

  /* ---------- 始める ---------- */
  /** CPU と対戦（level = easy / normal / hard） */
  startCpu(level) {
    this.rated = false;
    const L = CPU_LEVELS[level] ? level : 'normal';
    const same = this.kind === 'cpu' && this.level === L && this.series;
    this.kind = 'cpu'; this.level = L; this.net = null;
    this.oppName = 'CPU'; this.oppTag = CPU_LEVELS[L].name;
    if (!same) this.series = { me: 0, opp: 0 };
    this.cpuDealer ??= new TrayDealer(this.api.workerUrl);
    this.view.base = BATTLE_SPEED;                 // CPU の連鎖も、自分と同じ速さで
    this.begin();
  }

  /** オンライン対戦（net = 相手が見つかった BattleNet、room = その部屋） */
  startOnline(net, room, { rated = false } = {}) {
    this.kind = 'online'; this.level = null; this.rated = rated;
    this.net = net; this.room = room;
    this.oppName = room.opponent?.name || 'あいて'; this.oppTag = rated ? 'レート戦' : 'オンライン';
    this.series = { me: 0, opp: 0 };
    this.helloSeen = false; this.startSent = false;
    this.rematchMe = false; this.rematchOpp = false;
    this.round = 0;                                // 何戦目か（手駒の順番を決める種に使う。2 人とも同じ）
    net.onMessage = (m) => this.onNet(m);
    net.onGone = (reason) => this.onGone(reason);
    net.onTransport = (t) => { this.transport = t; };
    this.view.base = BATTLE_SPEED;                 // 相手の連鎖も、相手の画面と同じ速さで
    this.begin();
    this.waitText();
    net.send({ t: 'hello', name: this.api.myName(), v: PROTOCOL, rate: rated ? net.rate : undefined });
    net.start();
    if (room.seat === 1) this.later(2600, () => this.maybeStart(), true);    // じかにつながるのを少し待ってから
  }

  /** 対戦の画面にして、盤面を新しくし、カウントダウンを待つ */
  begin() {
    const api = this.api, $ = this.$;
    this.clearTimers();
    this.active = true;
    this.ended = false;
    this.started = false;
    this.myOverAt = null; this.oppOverAt = null;
    // 手駒の順番を決める種（自分と相手で同じ順番の手駒が出る）。オンラインは部屋と何戦目かから、2 人とも同じ種を作る
    this.seed = this.kind === 'cpu' ? Math.floor(Math.random() * 2 ** 32) : seedOf(`${this.room?.id}:${this.round ?? 0}`);
    $('vsResult').classList.add('hidden');
    $('vsWaitNote').classList.add('hidden');
    $('vsMeName').textContent = api.myName() || 'YOU';
    $('vsOppName').textContent = this.oppName;
    $('vsOppTag').textContent = this.oppTag;
    $('vsHead').classList.remove('hidden');
    $('vsOpp').classList.remove('hidden');
    $('vsMargin').classList.add('hidden');
    $('vsTimer').textContent = '0:00';
    api.enter();
    track('battle_start', { kind: this.kind, level: this.level || undefined, rated: !!this.rated });
    api.lock(true);
    this.clock = new Clock();
    this.makeSides();
    this.layout();
    clearInterval(this.tickTimer);
    this.tickTimer = setInterval(() => this.tick(), 100);
    if (this.kind === 'cpu') this.later(500, () => this.countdown(), true);
  }

  makeSides() {
    const api = this.api;
    const me = this.me = new BattleSide({ game: api.game, now: () => this.clock.now(), idPrefix: 'm', busy: () => api.busy(), hooks: {
      send: (atk) => this.sendAttack(atk),
      drop: (res) => this.myDrop(res),
    } });
    me.over = false;
    if (this.kind === 'cpu') {
      const g = this.cpu = new Game({ hooks: {}, battle: { rates: BATTLE_RATES, seed: this.seed } });   // 自分と同じ種 = 同じ順番の手駒
      this.opp = new BattleSide({ game: g, now: () => this.clock.now(), idPrefix: 'c', busy: () => this.view.playLeft() > 0, hooks: {
        send: (atk) => this.incoming(atk),
        drop: (res) => this.view.playDrop(res.landed),
        over: () => this.oppLost(this.clock.now() - (this.goAt ?? 0)),
      } });
      this.cpuBusy = false;
      this.cpuNextAt = Infinity;
      this.mirror = null;
      this.view.reset(g.board);
    } else {
      this.cpu = null; this.opp = null;
      this.mirror = Game.mirror();
      this.view.reset(this.mirror.board);
    }
  }

  /**
   * 相手の盤面の大きさ。スマホの縦向きなどでは、自分の盤面の上に並べて、2 つの三角がちょうど同じ大きさで収まるマスにする
   * （自分の盤面は renderer.js の layout が、残りの高さに収まるように決める）。タブレットの横向きは、自分の盤面の右に並べる
   */
  layout() {
    const field = this.$('vsOppField'), app = this.$('app'), opp = this.$('vsOpp');
    const cs = getComputedStyle(app);
    if (window.matchMedia?.(WIDE).matches) {
      // タブレットの横向き: 自分の盤面の右の列に、同じ大きさで（自分の盤面は左の列で、同じ幅・同じ高さに収まる大きさになる）
      const h = app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      this.view.layout(Math.max(6, Math.floor(Math.min((opp.clientWidth - 4) / Renderer.spanW, (h - 10) / Renderer.spanH))));
      return;
    }
    let rest = app.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    for (const el of app.children) {
      if (el === opp || el.classList.contains('stage')) continue;
      const st = getComputedStyle(el);
      if (st.display === 'none' || st.position === 'absolute' || st.position === 'fixed') continue;
      rest -= el.offsetHeight + parseFloat(st.marginTop) + parseFloat(st.marginBottom);
    }
    const os = getComputedStyle(opp);
    rest -= opp.offsetHeight - field.offsetHeight + parseFloat(os.marginTop) + parseFloat(os.marginBottom);
    // 2 つの盤面は同じ作り: どちらも縦 spanH マス（+ 数 px）・横 spanW マス（renderer.js の layout）
    const cell = Math.floor(Math.min((app.clientWidth + 16 - 4) / Renderer.spanW, (rest - 16) / (2 * Renderer.spanH)));
    this.view.layout(Math.max(6, cell));
  }

  /** オンライン: 相手とつないでいる間（始まるまで）の小さな文字 */
  waitText() {
    const el = this.$('vsCount');
    el.textContent = 'じゅんび中…';
    el.className = 'vs-count wait';
  }

  /* ---------- カウントダウン ---------- */
  countdown() {
    if (!this.active || this.ended) return;
    const el = this.$('vsCount');
    const show = (text, cls) => {
      el.textContent = text;
      el.className = `vs-count show ${cls}`;
      el.animate([{ scale: '2', opacity: 0 }, { scale: '.9', opacity: 1, offset: 0.25 }, { scale: '1', opacity: 1, offset: 0.7 }, { scale: '1.1', opacity: 0 }],
        { duration: COUNT_MS, easing: 'cubic-bezier(.2,.9,.3,1)' });
    };
    [3, 2, 1].forEach((n, i) => this.later(i * COUNT_MS, () => { show(String(n), 'n'); this.api.sfx.countdown(n); }, true));
    this.later(3 * COUNT_MS, () => {
      show('GO!', 'go');
      this.api.sfx.go();
      this.go();
    }, true);
    this.later(4 * COUNT_MS, () => { el.className = 'vs-count hidden'; }, true);
  }
  go() {
    this.started = true;
    this.goAt = this.clock.now();
    this.me.startAt = this.goAt;
    if (this.opp) this.opp.startAt = this.goAt;
    this.api.lock(false);
    if (this.cpu) this.cpuNextAt = this.goAt + this.thinkTime() * 0.6;
  }

  /* ---------- 時計 ---------- */
  /** ms 後に fn（real = 一時停止に関係なく。カウントダウンなど） */
  later(ms, fn, real = false) {
    const t = { at: (real ? performance.now() : this.clock?.now() ?? performance.now()) + ms, fn, real };
    this.timers.push(t);
    return t;
  }
  clearTimers() { this.timers = []; }

  tick() {
    if (!this.active) return;
    const now = this.clock.now(), real = performance.now();
    for (const t of [...this.timers]) {
      if ((t.real ? real : now) < t.at) continue;
      this.timers.splice(this.timers.indexOf(t), 1);
      if (!t.real && this.clock.pausedAt != null) { this.timers.push(t); continue; }
      t.fn();
    }
    if (!this.started || this.ended || this.clock.pausedAt != null) return;
    this.me.tick();
    if (this.opp) this.opp.tick();
    if (this.cpu) this.cpuTick();
    const el = Math.max(0, now - this.goAt), s = Math.floor(el / 1000);   // GO! の直前に読んだ時刻だと負になる（-1:-1 と出ないように）
    const txt = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    if (this.$('vsTimer').textContent !== txt) this.$('vsTimer').textContent = txt;
    const m = this.$('vsMargin'), blocks = marginBlocks(el);
    if (el >= MARGIN_MS) {
      const label = `おじゃま ×${blocks}`;
      if (m.textContent !== label) {
        m.textContent = label;
        m.classList.remove('hidden');
        m.animate([{ scale: '1.6' }, { scale: '1' }], { duration: 380, easing: 'cubic-bezier(.3,1.6,.5,1)' });
        this.announceMargin(blocks);
      }
    }
  }

  /** マージンタイムで 1 回に送るおじゃまの個数が増えた: 画面の真ん中に「おじゃま ×N / 何分何秒から」を出して、警告の音を鳴らす */
  announceMargin(blocks) {
    const sec = Math.round(marginStartOf(blocks) / 1000);
    const at = `${Math.floor(sec / 60)}分${String(sec % 60).padStart(2, '0')}秒`;
    this.api.renderer.showText(`おじゃま ×${blocks}<small>${at}をすぎた${blocks >= MARGIN_MAX ? '（さいだい）' : ''}</small>`, 't3');
    this.api.sfx.garbageIncoming?.(blocks, 0);
  }

  setPaused(on) {
    if (!this.active || this.kind !== 'cpu' || !this.clock) return;
    if (on) this.clock.pause(); else this.clock.resume();
    this.view.setPaused(on);
  }

  /* ---------- 自分 ---------- */
  /** 自分が置いた（main.js の onTurn）。readyIn = この連鎖の再生が終わるまで */
  onLocalTurn(turn, readyIn) {
    if (!this.active || this.ended) return;
    this.me.placed(turn, readyIn);
    if (this.net) {
      const rest = turn.rest ?? [];
      this.net.send({ t: 'turn', p: turn.piece.name, ox: turn.ox, oy: turn.oy, rest, b: packBoard(this.api.game.board) });
    }
  }
  /** 自分のおじゃまが盤面に落ちた（ルールはもう確定。画面では再生の列に並べる） */
  myDrop(res) {
    this.api.enqueueDrop(res);
    if (this.net) this.net.send({ t: 'drop', land: res.landed.map(({ block, x, r, n }) => ({ id: block.id, n, x, r })), b: packBoard(this.api.game.board) });
  }
  /** 自分が送った: 自分の連鎖が見え終わるころに、自分のゴールから相手のゴールへ飛んでいく（そのあと相手の盤面に置かれる） */
  sendAttack(atk) {
    if (this.opp) this.opp.receive({ ...atk });
    if (this.net) this.net.send({ t: 'atk', id: atk.id, n: atk.n, count: atk.count, readyIn: atk.readyIn });
    this.later(atk.readyIn, () => {
      if (!this.active) return;
      const g = this.api.renderer.goal.getBoundingClientRect();
      this.fly({ x: g.left + g.width / 2, y: g.top + g.height / 2 }, this.view.goalPoint(), atk, () => this.api.sfx.attackHit());
      this.api.sfx.attack(atk.n);
    });
  }
  /** 相手から飛んできた: 相手の連鎖が終わるころに、相手のゴールから自分のゴールへ飛んでくる（そのあと自分の盤面に置かれる） */
  incoming(atk) {
    const rtt = this.net?.rtt ?? 0;
    const readyIn = Math.max(0, (atk.readyIn ?? 0) - rtt / 2);
    this.me.receive({ ...atk, readyIn });
    this.later(readyIn, () => {
      if (!this.active || this.ended) return;
      const g = this.api.renderer.goal.getBoundingClientRect();
      this.fly(this.view.goalPoint(), { x: g.left + g.width / 2, y: g.top + g.height / 2 }, atk, () => this.api.sfx.garbageWarn(atk.n));
    });
  }

  /** おじゃまのタイルが飛んでいく（数字つき。宝石と同じ塗り。光の玉は使わない） */
  fly(from, to, atk, done) {
    const el = document.createElement('div');
    el.className = 'atk-fly';
    el.innerHTML = `<i class="cell block garbage c-garbage"><b class="gnum">${atk.n}</b></i>` + (atk.count > 1 ? `<span class="atk-count">×${atk.count}</span>` : '');
    document.body.appendChild(el);
    const mid = { x: (from.x + to.x) / 2, y: Math.min(from.y, to.y) - 60 };
    const at = (p, s) => `translate(${p.x}px,${p.y}px) scale(${s})`;
    const anim = el.animate([
      { transform: at(from, 0.4), opacity: 0 },
      { transform: at(from, 1.15), opacity: 1, offset: 0.15 },
      { transform: at(mid, 1), offset: 0.55 },
      { transform: at(to, 0.85), opacity: 1 },
    ], { duration: 520, easing: 'cubic-bezier(.4,.1,.5,1)' });
    anim.onfinish = () => { el.remove(); done?.(); };
  }

  /** 自分が負けた（置ける場所がない！ が見えたところ。main.js から） */
  localLost() {
    if (!this.active || this.ended || this.myOverAt != null) return;
    this.myOverAt = this.clock.now() - (this.goAt ?? 0);
    this.me.over = true;
    if (this.net) {
      this.net.send({ t: 'over', at: this.myOverAt });
      // 相手もほぼ同時に負けていたら、その知らせを少し待つ（先に置けなくなったほうの負け・ほぼ同時なら引き分け）
      if (this.oppOverAt != null) this.decide();
      else this.later(1200, () => this.decide(), true);
    } else if (this.oppOverAt != null) this.decide();        // CPU のほうが先に置けなくなっていた（まだ再生中で見えていなかった）
    else this.finish('lose');
  }
  oppLost(at) {
    if (!this.active || this.ended || this.oppOverAt != null) return;
    this.oppOverAt = at;
    if (this.myOverAt != null) { this.decide(); return; }
    // 相手の盤面の再生が追いついてから（相手が置けなくなったのが見えてから）
    this.view.settled().then(() => { if (this.myOverAt == null) this.finish('win'); else this.decide(); });
  }
  decide() {
    if (this.ended) return;
    if (this.oppOverAt == null) { this.finish('lose'); return; }
    const d = this.myOverAt - this.oppOverAt;
    this.finish(Math.abs(d) < 300 ? 'draw' : d < 0 ? 'lose' : 'win');
  }

  /* ---------- CPU ---------- */
  thinkTime() {
    const [a, b] = CPU_LEVELS[this.level].think;
    return a + Math.random() * (b - a);
  }
  cpuTick() {
    const g = this.cpu, now = this.clock.now();
    if (this.cpuBusy || g.gameOver || this.opp.over || !g.tray.some(Boolean)) return;
    // 対戦では連鎖の再生が終わるまで置けない（自分と同じルール）。終わってから少し考えて置く
    if (this.view.playLeft() > 0) { this.cpuNextAt = Math.max(this.cpuNextAt, now + this.thinkTime() * 0.4); return; }
    if (now < this.cpuNextAt) return;
    this.cpuBusy = true;
    const L = CPU_LEVELS[this.level];
    const { cells, garbage } = g.cellLists();
    const names = g.tray.map((p) => p && p.name);
    const seq = this.cpuSeq = (this.cpuSeq ?? 0) + 1;
    this.cpuDealer.hint(cells, names, garbage, { budgetMs: L.budget, ranked: true }).then((list) => {
      if (seq !== this.cpuSeq || !this.active || this.ended || g !== this.cpu) return;
      this.cpuBusy = false;
      if (!list?.length) { if (!g.hasMove()) { g.gameOver = true; this.opp.lose(); } return; }
      let m = list[0];
      if (Math.random() >= L.best) {
        const ok = list.filter((x) => x.survive);
        const pool = (ok.length ? ok : list).slice(0, Math.max(1, Math.ceil((ok.length || list.length) * L.spread)));
        m = pool[Math.floor(Math.random() * pool.length)];
      }
      const rest = g.tray.filter((p, i) => p && i !== m.slot).map((p) => p.name);
      const turn = g.placePiece(m.slot, m.ox, m.oy);
      if (!turn) { this.cpuNextAt = this.clock.now() + 300; return; }   // そのあいだにおじゃまが落ちて置けなくなった
      turn.rest = rest;
      const readyIn = this.view.playLeft() + turnCost(turn) / this.view.base;
      this.opp.placed(turn, readyIn);
      this.view.playTurn(turn);
      this.cpuNextAt = this.clock.now() + this.thinkTime();
      const lost = () => { if (g === this.cpu && g.gameOver) this.opp.lose(); };
      if (turn.trayReady) turn.trayReady.then(lost); else lost();
    }).catch((e) => { console.error(e); this.cpuBusy = false; });
  }

  /* ---------- オンライン ---------- */
  onNet(m) {
    if (!this.active || !m) return;
    switch (m.t) {
      case 'hello':
        this.helloSeen = true;
        if (m.v !== PROTOCOL) { this.finish('version'); return; }
        if (m.name) { this.oppName = m.name; this.$('vsOppName').textContent = m.name; }
        if (this.rated && Number.isFinite(m.rate)) { this.oppTag = `レート ${m.rate}`; this.$('vsOppTag').textContent = this.oppTag; }
        if (this.room.seat === 1) this.maybeStart();
        break;
      case 'start':
        if (this.room.seat === 2) this.startRound();
        break;
      case 'turn': this.remoteTurn(m); break;
      case 'atk': if (this.started && !this.ended) this.incoming(m); break;
      case 'drop': this.remoteDrop(m); break;
      case 'over': this.oppLost(m.at ?? 0); break;
      case 'rematch': this.rematchOpp = true; this.maybeRematch(); break;
      case 'bye': this.onGone('left'); break;
    }
  }
  /** 部屋を作った側: 相手の hello が届いていて、じかにつながった（か、待ちきれなくなった）ら始める */
  maybeStart() {
    if (this.room?.seat !== 1 || this.startSent || !this.helloSeen || !this.active) return;
    if (this.transport !== 'p2p' && performance.now() - (this.helloWaitFrom ??= performance.now()) < 2500) {
      this.later(300, () => this.maybeStart(), true);
      return;
    }
    this.startSent = true;
    this.net.send({ t: 'start' });
    this.startRound();
  }
  startRound() {
    if (this.started && !this.ended) return;
    this.countdown();
  }
  remoteTurn(m) {
    const g = this.mirror;
    if (!g) return;
    g.tray = [new Piece(m.p), ...(m.rest || []).map((n) => new Piece(n))].concat([null, null]).slice(0, 3);
    let turn = null;
    try { turn = g.canPlace(0, m.ox, m.oy) ? g.placePiece(0, m.ox, m.oy) : null; } catch (e) { console.error(e); }
    if (turn) this.view.playTurn(turn);
    if (!turn || (m.b && !samePack(packBoard(g.board), m.b))) this.resync(m.b);
  }
  remoteDrop(m) {
    const g = this.mirror;
    if (!g) return;
    const landed = [];
    for (const l of m.land || []) {
      if (!isInside(l.x, l.r) || g.board.get(l.x, l.r)) continue;
      const block = createGarbage(l.n, 'o' + l.id);
      g.board.set(l.x, l.r, block);
      landed.push({ block, x: l.x, r: l.r, n: l.n, path: l.path });
    }
    this.view.playDrop(landed);
    if (m.b && !samePack(packBoard(g.board), m.b)) this.resync(m.b);
  }
  /** 相手の盤面と食い違ったら、届いた盤面に合わせる（再生が終わってから） */
  resync(pack) {
    if (!pack) return;
    this.mirror.board = unpackBoard(pack);
    const board = this.mirror.board;
    this.view.settled().then(() => { if (this.mirror?.board === board) this.view.reset(board); });
  }
  onGone(reason) {
    if (!this.active) return;
    this.netGone = reason;
    if (!this.ended && this.started) this.finish('gone');
    else if (!this.ended) this.finish('gone');
    else { this.$('vsRematch').disabled = true; this.$('vsWaitNote').textContent = '相手が部屋を出ました'; this.$('vsWaitNote').classList.remove('hidden'); }
  }

  /* ---------- おわり ---------- */
  finish(result) {
    if (this.ended) return;
    this.ended = true;
    this.api.lock(true);
    if (this.cpu) this.cpuSeq = (this.cpuSeq ?? 0) + 1;
    const $ = this.$;
    // 始まる前に相手がいなくなったときは、勝ちにしない（戦績・連勝の数にも入れない）
    const win = result === 'win' || (result === 'gone' && this.started);
    if (win) this.series.me++;
    else if (result === 'lose') this.series.opp++;
    if (win || result === 'lose') saveRecord(this.kind, this.level, win ? 'win' : 'lose');
    track('battle_end', { kind: this.kind, level: this.level || undefined, rated: !!this.rated, result });
    const big = { win: 'WIN!', lose: 'LOSE…', draw: 'DRAW', gone: win ? 'WIN!' : '—', version: '—' }[result];
    const title = { win: 'あなたの勝ち！', lose: '置ける場所がない！', draw: '引き分け', version: 'バージョンがちがいます',
      gone: this.netGone === 'left' ? '相手が対戦をやめました' : '相手との通信が切れました' }[result];
    $('vsResTitle').textContent = title;
    $('vsResBig').textContent = big;
    $('vsResBig').className = `vs-res-big ${result === 'gone' && !win ? 'version' : result}`;
    $('vsResVs').textContent = `vs ${this.oppName}${this.kind === 'cpu' || this.rated ? `（${this.oppTag}）` : ''}`;
    $('vsResSeries').textContent = `${this.series.me} - ${this.series.opp}`;
    $('vsResSeries').classList.toggle('hidden', !!this.rated);
    $('vsRate').classList.toggle('hidden', !this.rated || result === 'version');
    $('vsRematch').textContent = this.rated ? 'もう一度さがす' : 'もう一度';
    if (this.rated && result !== 'version') {
      if (this.started) this.reportRated(result === 'gone' ? 'win' : result);
      else $('vsRate').textContent = '対戦が始まる前だったので、レートは動きません';
    }
    const sc = this.api.game.score;
    $('vsStatChain').textContent = sc.bestChain;
    $('vsStatSent').textContent = this.me.stats.sent;
    $('vsStatChip').textContent = this.me.stats.chipped;
    const canRematch = this.kind === 'cpu' || this.rated || (!this.netGone && result !== 'version');
    $('vsRematch').disabled = !canRematch;
    $('vsWaitNote').classList.toggle('hidden', !(result === 'version'));
    if (result === 'version') $('vsWaitNote').textContent = 'ページを読みこみ直してください';
    this.later(result === 'lose' ? 450 : 650, () => {
      if (!this.active) return;
      $('vsResult').classList.remove('hidden');
      if (win) this.api.sfx.win(); else if (result === 'lose') this.api.sfx.lose();
      if (win) this.api.celebrate?.();
    }, true);
  }

  /** レート戦の結果をサーバーへ（2 人の知らせが合ったら、レートが動く）。結果のカードにレートの増減を出す */
  async reportRated(result) {
    const el = this.$('vsRate'), net = this.net;
    el.innerHTML = 'レートを計算しています…';
    el.className = 'vs-rate';
    const res = await net.reportResult(result);
    if (this.net !== net && this.net) return;
    if (res.status === 'done') {
      const from = res.rate - res.delta, up = res.delta > 0, cls = up ? 'up' : res.delta < 0 ? 'down' : '';
      el.innerHTML = `レート　${from} → <b>${res.rate}</b> <span class="vs-delta ${cls}">${up ? '+' : ''}${res.delta}</span>`;
      el.className = `vs-rate ${cls}`;
      el.animate([{ scale: '1.15' }, { scale: '1' }], { duration: 320, easing: 'cubic-bezier(.3,1.6,.5,1)' });
    } else el.textContent = res.status === 'void' ? 'この対戦はレートに数えませんでした（結果が食い違いました）' : 'レートはあとで反映されます';
  }

  rematch() {
    if (!this.active) return;
    if (this.kind === 'cpu') { this.startCpu(this.level); return; }
    if (this.rated) { const find = this.api.findRated; this.exit(); find?.(); return; }      // レート戦は 1 戦ずつ。新しい相手をさがす
    if (this.netGone) return;
    this.rematchMe = true;
    this.net.send({ t: 'rematch' });
    this.$('vsRematch').disabled = true;
    this.$('vsWaitNote').textContent = '相手を待っています…';
    this.$('vsWaitNote').classList.remove('hidden');
    this.maybeRematch();
  }
  maybeRematch() {
    if (!this.rematchMe || !this.rematchOpp || !this.active) return;
    this.rematchMe = this.rematchOpp = false;
    const series = this.series;
    this.helloSeen = true; this.startSent = false;
    this.round = (this.round ?? 0) + 1;            // 2 人とも同じだけ数える（手駒の順番の種）
    this.begin();
    this.waitText();
    this.series = series;
    if (this.room.seat === 1) { this.startSent = true; this.later(600, () => { this.net.send({ t: 'start' }); this.startRound(); }, true); }
  }

  /** ホームへ（オンラインなら部屋を出る） */
  exit() {
    if (!this.active) return;
    this.active = false;
    this.endedBeforeExit = this.ended;
    this.ended = true;
    clearInterval(this.tickTimer);
    this.clearTimers();
    if (this.cpu) this.cpuSeq = (this.cpuSeq ?? 0) + 1;
    this.cpu = null; this.opp = null; this.mirror = null;
    this.view.reset(null);
    const net = this.net;
    this.net = null;
    // レート戦の途中でやめたら負け（自分で「負け」と知らせる）
    if (net && this.rated && this.started && !this.endedBeforeExit) net.reportResult('lose', 0).catch(() => {});
    if (net) { try { net.send({ t: 'bye' }); } catch {} setTimeout(() => net.cancel(), 150); }
    this.netGone = null;
    const $ = this.$;
    for (const id of ['vsResult', 'vsHead', 'vsOpp', 'vsCount']) $(id).classList.add('hidden');
    $('vsRematch').disabled = false;
    this.series = null;
    this.api.exit();
  }
}

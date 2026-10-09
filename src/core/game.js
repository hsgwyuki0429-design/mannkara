import { Board, createBlock, createGarbage, isGarbage } from './board.js?v=202610091500';
import { edgeSpot, chipOrder } from './battle.js?v=202610091500';
import { PieceGenerator, Piece, SHAPES, seededRandom, BATTLE_SHAPES } from './pieces.js?v=202610091500';
import { ScoreManager } from './score.js?v=202610091500';
import { nextActivation, lineMoves } from './mancala.js?v=202610091500';
import { solvable, countWays, spots, planAllClear, keyAfter } from './planner.js?v=202610091500';
import * as Sim from './sim.js?v=202610091500';
import { tightRateFor, allClearRateFor, TIGHT_COOLDOWN } from './difficulty.js?v=202610091500';
import { bestMove } from './advisor.js?v=202610091500';
import {
  SIZE, TRAY_SIZE, CHAIN_PIECE_RATE, FIT_WEIGHTS, HARD_FILL, WAYS_MAX, WAYS_TOLERANCE,
  TIGHT_RATE, TIGHT_MAX_FILL, TIGHT_MIN_SPOTS, TIGHT_MAX_WAYS, TIGHT_CAP, TIGHT_BUDGET_MS,
  LINEUP_CANDIDATES, LINEUP_BUDGET_MS, targetWays,
  ALL_CLEAR_RATE, ALL_CLEAR_PIECES, ALL_CLEAR_BUDGET_MS, TRAY_RETRIES,
} from './constants.js?v=202610091500';

/**
 * ゲーム本体（DOM 非依存）。ルールは同期的に即確定し、描画側は hooks.onTurn で記録を受け取って再生する。
 * 流れ: 置く → 満杯のライン(縦/横)のうち最小番号を1本発動、を発動が無くなるまで繰り返す
 *       → スコア確定 → トレイ補充（3つ使い切ったら。対戦は使った枠にすぐ）→ ゲームオーバー判定
 */
const now = () => (globalThis.performance?.now?.() ?? Date.now());

export class Game {
  /**
   * dealer: 手駒の決め方（spawnTray）を別スレッドで動かすもの（{ reset(), deal(cells) → Promise }。ui/tray-dealer.js）。
   * 手駒を決める探索は時間で打ち切る作りで、1回に 100ms 近くかかることがある。このスレッドで動かすと、その間は
   * 置いたピースの表示も連鎖の再生も止まるので、画面では別スレッドに任せる。決め方のコードは同じ（dealer.js が
   * このクラスの spawnTray をそのまま使う）。無ければ今までどおり、このスレッドで同期的に決める（テストなど）
   */
  constructor({ random = Math.random, hooks = {}, dealer = null, battle = null } = {}) {
    this.generator = new PieceGenerator(random);
    this.hooks = hooks;
    this.dealer = dealer;
    this.dealSeq = 0;             // 新しいゲームにするたびに増やす（前のゲームの手駒が後から届いても使わない）
    if (battle) this.setBattle(true, battle.rates ?? null, battle);    // 対戦（battle = { rates, seed }）。最初の手駒から対戦の出し方で
    this.reset();
  }

  /** 手駒を決めることだけに使う Game（盤面は使う側が毎回入れる。最初の手駒は配らない。dealer.js） */
  static forDealing(random = Math.random) {
    const g = Object.create(Game.prototype);
    g.generator = new PieceGenerator(random);
    g.hooks = {};
    g.dealer = null;
    g.board = new Board();
    g.resetDealing();
    return g;
  }

  /** 盤面とスコアだけの Game（対戦で、相手の盤面を写すのに使う。手駒は配らず、詰みも判定しない。手は外から置く） */
  static mirror(random = Math.random) {
    const g = Game.forDealing(random);
    g.score = new ScoreManager();
    g.tray = new Array(TRAY_SIZE).fill(null);
    g.gameOver = false;
    g.scripted = true;
    g.dealSeq = 0;
    g.dealerState = null;
    g.setBattle(true, null);
    return g;
  }

  reset() {
    this.board = new Board();
    this.score = new ScoreManager();
    this.resetDealing();
    this.dealerState = null;      // dealer（別スレッド）が持っている手駒の決め方の状態の写し（途中から再開用）
    this.dealSeq++;
    this.stream = null;
    if (this.pieceSeed != null) {
      // 対戦: 種から決まる順番で 1 つずつ出す（2 人とも同じ種なので、同じ順番の手駒になる）。使った枠には、すぐ次が入る
      this.stream = new PieceGenerator(seededRandom(this.pieceSeed), BATTLE_SHAPES);
      this.tray = this.stream.spawnTray(TRAY_SIZE);
      this.trayReady = null;
    } else if (this.dealer) {
      // 最初の手駒も別スレッドで決める（決まるまでトレイは空。届いたら hooks.onTray）
      this.dealer.reset();
      this.tray = new Array(TRAY_SIZE).fill(null);
      this.trayReady = this.dealAsync(true);
    } else this.tray = this.spawnTray();
    this.gameOver = false;
    this.scripted = false;         // チュートリアル中（置いた手駒を補充しない・詰みを判定しない。盤面と手駒は画面側が決める）
  }
  /**
   * 対戦のルール（連鎖でおじゃまを削る）を使うか。手駒の決め方は出来に合わせず、決まった確率。
   * seed を渡すと、手駒は種から決まる順番で 1 つずつ出し、使った枠にすぐ次を入れる（2 人に同じ順番の手駒。次の reset から）
   */
  setBattle(on, rates = null, { seed = null } = {}) {
    this.battle = !!on;
    this.fixedRates = on ? rates : null;
    this.pieceSeed = on && seed != null ? seed >>> 0 : null;
  }

  /** 手駒の決め方の状態（全消しの計画・ループの判定の履歴など）を最初に戻す */
  resetDealing() {
    this.planTray = null;         // 今のトレイで、全消しの手順どおりにまだ置いていない手 [{ name, ox, oy }]
    this.plan = null;             // 全消しの計画の続き { key: ここまで手順どおりに置いた盤面, rest: 残りの手順 }
    this.stats = { refills: 0, allClearRolled: 0, allClearSearches: 0, allClearFound: 0 };   // 手駒の決め方の集計（確率が狙いどおりか調べる用）
    this.wantAllClear = false;    // 全消しのチャンスを引いたが、まだ手順が見つかっていない
    this.wantTight = false;       // 置き方の少ない組み合わせのチャンスを引いたが、まだ見つかっていない
    this.tightCooldown = 0;       // ひっかけを配った後、ひっかけを出さない残りの補充の回数
    this.allClearRate = ALL_CLEAR_RATE;   // 全消しのチャンスの確率（tightRate と同じく、画面側の skill から決めて渡す）
    this.tightRate = TIGHT_RATE;  // ひっかけの確率（画面側が skill から決めて、配るたびに渡す。difficulty.js）
    this.history = new Set();     // これまでに手駒を配った時の盤面（ループの判定用）
    this.lastLineup = null;       // 直前に配った手駒の決め方（デバッグ・テスト用）
  }

  /**
   * 今の盤面で、別スレッドに手駒を決めてもらう。届いたら tray・planTray を入れ替え、（補充なら）詰みを判定して
   * hooks.onTray を呼ぶ。返り値は届いた時に { gameOver } になる Promise（その間に新しいゲームになったら null）
   */
  /** 遊んでいる人の出来（skill = { best, recent }。画面側が入れる）と今のスコアから決めた、ひっかけの確率。
   *  対戦では出来に合わせず、決まった確率（fixedRates = { tight, allClear }。画面側が入れる） */
  currentTightRate() { return this.fixedRates ? this.fixedRates.tight : tightRateFor(this.score?.score ?? 0, this.skill); }
  currentAllClearRate() { return this.fixedRates ? this.fixedRates.allClear : allClearRateFor(this.score?.score ?? 0, this.skill); }
  /** 埋まっているマスの番号（r * 8 + x）の一覧。おじゃまは別の一覧（別スレッドの手駒の決め方・おすすめに渡す） */
  cellLists() {
    const cells = [], garbage = [];
    for (const { x, r, block } of this.board.entries()) (isGarbage(block) ? garbage : cells).push(r * SIZE + x);
    return { cells, garbage };
  }

  dealAsync(initial) {
    const seq = this.dealSeq;
    const { cells, garbage } = this.cellLists();
    return this.dealer.deal(cells, this.currentTightRate(), this.currentAllClearRate(), garbage).then((res) => {
      if (seq !== this.dealSeq) return null;
      this.tray = res.names.map((name) => new Piece(name));
      this.planTray = res.planTray;
      this.dealerState = res.state ?? null;
      this.lastLineup = res.lastLineup;
      if (!initial && !this.hasMove()) this.gameOver = true;     // 同期のときと同じく、補充のときだけ詰みを判定する
      this.hooks.onTray?.({ initial, gameOver: this.gameOver });
      return { gameOver: this.gameOver };
    });
  }

  /**
   * 今のゲームの状態（途中から再開用。JSON にできる形）。
   * 盤面（位置と色）・トレイ・全消しの手順・スコア・詰み・手駒の決め方の状態（全消しの計画・ループの判定の履歴など）
   */
  exportState() {
    const board = [];
    for (const { block, x, r } of this.board.entries()) board.push(isGarbage(block) ? [x, r, block.color, block.garbage] : [x, r, block.color]);
    return {
      v: 1, board, tray: this.tray.map((p) => p && p.name), planTray: this.planTray, score: { ...this.score },
      gameOver: this.gameOver, dealing: this.dealingState(),
    };
  }

  /** exportState で残した状態に戻す（トレイが空なら、その盤面で手駒を決め直す） */
  importState(st) {
    this.dealSeq++;                                            // 決めている途中の手駒が後から届いても使わない
    this.board = new Board();
    for (const [x, r, color, n] of st.board) this.board.set(x, r, color === 'garbage' ? createGarbage(n) : createBlock(color));
    this.tray = st.tray.map((name) => name && new Piece(name));
    this.planTray = st.planTray ?? null;
    this.score = Object.assign(new ScoreManager(), st.score);
    this.gameOver = !!st.gameOver;
    this.scripted = false;
    this.lastLineup = null;
    this.trayReady = null;
    const d = st.dealing;
    if (this.dealer) {
      this.dealerState = d ?? null;
      if (d) this.dealer.load(d); else this.dealer.reset();
    } else if (d) {
      this.plan = d.plan; this.history = new Set(d.history); this.wantAllClear = d.wantAllClear; this.wantTight = d.wantTight; this.tightCooldown = d.tightCooldown ?? 0;
    }
    if (!this.gameOver && this.tray.every((p) => !p)) {
      if (this.dealer) this.trayReady = this.dealAsync(false);
      else { this.tray = this.spawnTray(); if (!this.hasMove()) this.gameOver = true; }
    }
  }

  /** 手駒の決め方の状態（全消しの計画・ループの判定の履歴・チャンスを引いたか） */
  dealingState() {
    if (this.dealer) return this.dealerState;
    return { plan: this.plan, history: [...this.history], wantAllClear: this.wantAllClear, wantTight: this.wantTight, tightCooldown: this.tightCooldown };
  }

  /**
   * 対戦: 送られてきたおじゃま items = [{ id, n }] を盤面に置く（core/battle.js の edgeSpot。一番外側の辺の空きマスに、真ん中から順に）。
   * 置いたあと、トレイのどのピースも置けなければ詰み。{ landed: [{ block, x, r, n }], left: 置けなかった items, gameOver }
   */
  dropGarbage(items, random = this.generator.random) {
    const landed = [], left = [];
    for (const item of items) {
      const spot = edgeSpot((x, r) => !!this.board.get(x, r), random);
      if (!spot) { left.push(item); continue; }
      const block = createGarbage(item.n, item.id);
      this.board.set(spot.x, spot.r, block);
      landed.push({ block, x: spot.x, r: spot.r, n: block.garbage });   // n = 置かれたときの数字（画面は後から再生するので、そのときの数字を残す）
    }
    if (landed.length && !this.gameOver && !this.scripted && this.tray.some(Boolean) && !this.hasMove()) this.gameOver = true;
    this.chainCache = this.fitCache = null;
    return { landed, left, gameOver: this.gameOver };
  }
  /**
   * 対戦: 自分が k 連鎖したので、盤面のおじゃまを削る。**合計 k**（5 連鎖なら合計 −5）を、一番外側のおじゃま 1 個から順に当てる:
   * 連鎖の 1 段ごとに −1 を、いま一番先のおじゃまに（同じおじゃまが 0 以下になって消えたら、残りの段は次のおじゃまへ）。
   * 順番は**外側のおじゃまから**（一番外側の辺から。辺の中は、角から一番遠い端のおじゃまが先、角に近い内側のおじゃまはあと。chipOrder）。
   * hits = 段ごとの記録 [{ step, damage, block, x, r, from, n, removed }]（damage = そのおじゃまが、このターンでここまでに削られた合計 = 画面に出す「−1」「−2」…、
   * n = そのあとの数字。画面が 1 段ずつ見せる）、changed / removed = このターンで数字が減った / 消えたものの、ターンの最初からの結果
   */
  chipGarbage(k) {
    const hits = [], changed = [], removed = [];
    if (!(k > 0)) return { hits, changed, removed };
    const at = new Map(this.board.garbage().map((g) => [g.x + ',' + g.r, g]));
    const list = chipOrder().map((c) => at.get(c.x + ',' + c.r)).filter(Boolean);
    const first = new Map(), dealt = new Map();                  // block.id -> ターンの最初の数字 / ここまでに削られた合計
    for (let step = 1; step <= k && list.length; step++) {
      const e = list[0], { block, x, r } = e;
      const from = block.garbage;
      first.has(block.id) || first.set(block.id, { e, from });
      block.garbage = from - 1;
      const damage = (dealt.get(block.id) ?? 0) + 1;
      dealt.set(block.id, damage);
      const gone = block.garbage <= 0;
      hits.push({ step, damage, block, x, r, from, n: Math.max(0, block.garbage), removed: gone });
      if (gone) { this.board.set(x, r, null); list.shift(); }
    }
    for (const { e, from } of first.values()) {
      if (e.block.garbage <= 0) removed.push({ block: e.block, x: e.x, r: e.r, from });
      else changed.push({ block: e.block, x: e.x, r: e.r, n: e.block.garbage, from });
    }
    if (removed.length) this.chainCache = this.fitCache = null;
    return { hits, changed, removed };
  }

  canPlace(slot, ox, oy) {
    const piece = this.tray[slot];
    return !!piece && this.board.canPlace(piece, ox, oy);
  }

  /**
   * トレイ slot のピースを (ox, oy)=左上の画面座標 に置く。
   * 連鎖・スコア・補充・ゲームオーバー判定まで**同期的に即座に**確定させ、
   * 描画用の記録（turn）を返す。描画は hooks.onTurn で受け取って後から再生する。
   * そのため描画中でもプレイヤーは次のピースを置ける。
   */
  placePiece(slot, ox, oy) {
    if (this.gameOver || !this.canPlace(slot, ox, oy)) return null;
    const piece = this.tray[slot];
    this.tray[slot] = null;
    const rest = this.tray.filter(Boolean).map((p) => p.name);     // 置いた時点で残っている手駒（対戦で、相手の画面が同じ連鎖を再現するのに使う）
    // 全消しの手順どおりの手か（違ったら、このトレイではもう手順を教えない）
    if (this.planTray) {
      const i = this.planTray.findIndex((m) => m.name === piece.name && m.ox === ox && m.oy === oy);
      this.planTray = i < 0 ? null : this.planTray.filter((_, j) => j !== i);
    }
    const { kind: fit, rect } = Sim.fitOf(Sim.fromBoard(this.board), piece.cells, ox, oy);
    const placed = this.board.place(piece, ox, oy);
    this.score.addPlaced(placed.length);
    const fitBonus = this.score.addFit({ kind: fit, rect }, placed.length);
    const scoreAfterPlace = this.score.score;

    const steps = this.resolve();
    this.score.endTurn(steps.length > 0);
    // 対戦: 連鎖したら、その数だけ盤面のおじゃまの数字を減らす（ルールは置いた瞬間に確定。画面ではこのターンの再生の最後に見せる）。
    // 連鎖でブロックが無くなり、最後のおじゃまも消えたら全消し
    const chip = this.battle && steps.length ? this.chipGarbage(steps.length) : null;
    const allClear = steps.length > 0 && this.board.totalBlocks() === 0;
    const allClearBonus = allClear ? this.score.addAllClear() : 0;

    let refilled = false, trayReady = null;
    if (this.stream && !this.scripted) {
      this.tray[slot] = this.stream.next();                    // 対戦: 使った枠に、すぐ次の手駒（連鎖を決めたあとに入れる。相手の画面も同じ順で再現できる）
      refilled = true;
    } else if (this.tray.every((p) => !p) && !this.scripted) {
      this.planTray = null;
      if (this.dealer) trayReady = this.dealAsync(false);     // 別スレッドで決める（詰みの判定は届いてから）
      else this.tray = this.spawnTray();
      refilled = true;
    }
    if (!trayReady && !this.scripted && !this.hasMove()) this.gameOver = true;

    const turn = {
      slot, piece, ox, oy, rest, placed, steps, refilled, refillSlot: this.stream && refilled ? slot : null, scoreAfterPlace, fit, rect, fitBonus,
      allClear, allClearBonus, chip,
      score: this.score.score, streak: this.score.streak, boostTurns: this.score.boostTurns, gameOver: this.gameOver,
    };
    // 手駒を別スレッドで決めているときは、届いた時に解決する（その時に gameOver を入れ直す）
    if (trayReady) turn.trayReady = trayReady.then((r) => { if (r) turn.gameOver = r.gameOver; return r; });
    this.hooks.onTurn?.(turn);
    return turn;
  }

  /**
   * 発動が無くなるまで1本ずつ処理（毎回盤面を再判定）。各ステップに前後のスナップショットを残す。
   * 縦横の両方が満杯のときは、まだトレイにある手駒で詰まない向きを先に選ぶ（mancala.nextActivation）
   */
  resolve() {
    const steps = [];
    const rest = this.tray.filter(Boolean).map((p) => p.cells);
    for (let act; (act = nextActivation(this.board, rest)); ) {
      const before = this.board.snapshot();
      const step = { kind: act.kind, n: act.n, chain: steps.length + 1, stack: [], moves: [], goals: 0, before };
      for (const ev of lineMoves(this.board, act.kind, act.n)) {
        if (ev.type === 'take') { step.stack = ev.blocks; continue; }
        step.moves.push({ block: ev.block, to: ev.to });
        if (ev.to === 'goal') step.goals++;
      }
      step.after = this.board.snapshot();
      step.gained = this.score.addStep(step);
      step.score = this.score.score;
      steps.push(step);
      if (steps.length > 2000) break;
    }
    return steps;
  }

  /**
   * 新しいトレイを作る（仕様は constants.js の WAYS_MAX の説明）:
   *  - 全消しのチャンス（allClearTray）なら、計算した手駒
   *  - それ以外は必ず詰まない置き方が1つ以上ある組み合わせ。置き方の数は埋まり具合に比例して減らし、
   *    ときどき（searchTight）「1つずつなら置ける場所は多いのに、3つとも置ける置き方は1〜2通り」の組み合わせ
   *  - 例外: 埋まり具合が HARD_FILL 以上で、詰まない組み合わせが置き方1通りだけ・置くと前の盤面に戻る（ループ）なら、
   *    詰む組み合わせを配る（同じ盤面を永遠にくり返さないように）
   */
  spawnTray() {
    if (this.skill !== undefined) { this.tightRate = this.currentTightRate(); this.allClearRate = this.currentAllClearRate(); }
    const fill = this.board.fillRate();
    this.stats.refills++;
    const start = Sim.fromBoard(this.board);
    this.history.add(Sim.keyOf(start));
    const planned = this.allClearTray(fill);
    if (planned) { this.lastLineup = { kind: 'allClear' }; return planned; }

    if (fill >= TIGHT_MAX_FILL) this.wantTight = false;
    else if (this.tightCooldown > 0) { this.tightCooldown--; this.wantTight = false; }
    else this.wantTight ||= this.generator.random() < this.tightRate;
    let pick = this.wantTight ? this.searchTight(start) : null;
    if (pick) { this.wantTight = false; this.tightCooldown = TIGHT_COOLDOWN; }                          // 見つからなければ次の補充でもう一度
    pick ??= this.searchTray(start, fill);
    if (!pick) { this.lastLineup = { kind: 'rescue' }; return this.rescueTray(start); }
    if (fill >= HARD_FILL && pick.count === 1 && pick.loopOnly && !pick.escape) {
      const stuck = this.stuckTray(start);
      if (stuck) { this.lastLineup = { ...pick, kind: 'stuck' }; return stuck; }
    }
    this.lastLineup = pick;
    return pick.tray;
  }

  /**
   * 候補を抽選して、置き方の数が目標（targetWays）に一番近い組み合わせを選ぶ。
   * 置き終えた盤面がどれも前に配った時の盤面と同じ（ループ）になる候補は、ほかに候補があれば選ばない。
   * 詰まない候補が1つも無ければ null。
   * 返り値 { kind, tray, count, target, loopOnly, escape: ループしない詰まない候補があったか }
   */
  searchTray(start, fill) {
    const target = targetWays(fill);
    const cap = Math.min(WAYS_MAX, Math.ceil(target * WAYS_TOLERANCE) + 1);
    const deadline = now() + LINEUP_BUDGET_MS;
    let best = null, escape = false;
    for (let i = 0; i < LINEUP_CANDIDATES && (i < 3 || now() < deadline); i++) {
      const tray = this.drawTray();
      const { count, ends } = countWays(start, tray.map((p) => p.name), cap);
      if (!count) continue;
      const loopOnly = this.loops(ends);
      if (!loopOnly) escape = true;
      const score = Math.abs(Math.log(count / target)) + (loopOnly ? 10 : 0);
      if (!best || score < best.score) best = { kind: 'normal', tray, count, target, loopOnly, score };
      if (!loopOnly && count <= target * WAYS_TOLERANCE && count * WAYS_TOLERANCE >= target) break;
    }
    return best && { ...best, escape };
  }

  /**
   * 「1つずつなら置ける場所は多い（TIGHT_MIN_SPOTS か所以上）のに、3つとも置ける置き方は TIGHT_MAX_WAYS 通り以下」
   * の組み合わせを探す。ランダムに引くとほとんど出ないので、1つずつ形を入れ替え、置き方が減る（増えない）なら
   * 採用する、をくり返す（行き詰まったら最初からやり直す）。TIGHT_BUDGET_MS で見つからなければ null。
   */
  searchTight(start) {
    const ok = SHAPES.filter((s) => spots(start, s.name) >= TIGHT_MIN_SPOTS);
    if (!ok.length) return null;
    const pick = () => this.generator.pick(ok).name;
    const ways = (names) => countWays(start, names, TIGHT_CAP);
    const deadline = now() + TIGHT_BUDGET_MS;
    let best = null;
    while (now() < deadline && !(best?.count === 1)) {
      let cur = Array.from({ length: TRAY_SIZE }, pick), w = ways(cur);
      if (!w.count) continue;
      for (let it = 0; it < 60 && w.count > 1 && now() < deadline; it++) {
        const cand = [...cur];
        cand[Math.floor(this.generator.random() * TRAY_SIZE)] = pick();
        const cw = ways(cand);
        if (cw.count >= 1 && cw.count <= w.count) { cur = cand; w = cw; }
      }
      if (w.count <= TIGHT_MAX_WAYS && !this.loops(w.ends) && (!best || w.count < best.count)) best = { names: cur, ...w };
    }
    if (!best) return null;
    return { kind: 'tight', tray: this.deal(best.names.map((name) => ({ name }))), count: best.count, target: 1, loopOnly: false, escape: true };
  }

  /** 置き終えた盤面がどれも、これまでに手駒を配った時の盤面と同じか（＝同じ局面のくり返し） */
  loops(ends) {
    for (const k of ends) if (!this.history.has(k)) return false;
    return true;
  }

  /**
   * 抽選で詰まない組み合わせが見つからなかったとき: 置ける形だけから組み直し、
   * それでもだめなら小さい形の組み合わせを順に全部試す。どうやっても無ければ（本当に詰んだ盤面）1つは置ける組み合わせ。
   */
  rescueTray(start) {
    const placeable = SHAPES.filter((s) => Sim.fits(start, new Piece(s.name).cells));
    if (!placeable.length) return this.drawTray();           // 何も入らない＝詰み
    const ok = (names) => countWays(start, names, 1).count > 0;
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const names = Array.from({ length: TRAY_SIZE }, () => this.generator.pick(placeable).name);
      if (ok(names)) return this.deal(names.map((name) => ({ name })));
    }
    const small = [...placeable].sort((a, b) => a.cells.length - b.cells.length).slice(0, 10).map((s) => s.name);
    for (let i = 0; i < small.length; i++) for (let j = i; j < small.length; j++) for (let k = j; k < small.length; k++) {
      const names = [small[i], small[j], small[k]];
      if (ok(names)) return this.deal(names.map((name) => ({ name })));
    }
    return [new Piece(this.generator.pick(placeable).name), ...this.drawTray().slice(1)];
  }

  /**
   * 詰む組み合わせ（ただし1つは置ける）。まず普通に抽選し、見つからなければ置ける形を1つ含む組み合わせを
   * 順に調べる（抽選だけだと、たまたま見つからずに規則が効かないことがある）。どうしても無ければ null
   */
  stuckTray(start) {
    const stuck = (names) => countWays(start, names, 1).count === 0;
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const tray = this.drawTray();
      if (!tray.some((p) => Sim.fits(start, p.cells))) continue;
      if (stuck(tray.map((p) => p.name))) return tray;
    }
    const fit = SHAPES.filter((s) => Sim.fits(start, new Piece(s.name).cells)).map((s) => s.name);
    if (!fit.length) return null;
    const all = SHAPES.map((s) => s.name);
    for (let tries = 0; tries < 300; tries++) {
      const names = [this.generator.pick(fit.map((name) => ({ name, weight: 1 }))).name,
        all[Math.floor(this.generator.random() * all.length)], all[Math.floor(this.generator.random() * all.length)]];
      if (stuck(names)) return this.deal(names.map((name) => ({ name })));
    }
    return null;
  }

  /**
   * 全消しのチャンス（手順どおりに置いた時だけ全消しになる手駒）:
   *  - 盤面が空でも残っていても同じ: 補充のたびに ALL_CLEAR_RATE の確率で、今の盤面から ALL_CLEAR_PIECES 個の手順を計算する
   *    （見つからなければ次の補充でもう一度。回数は this.stats.allClear に数える）
   * どちらも最初の3個を配り、残りは計画として持つ。次に配る時、ここまで手順どおりの盤面なら続きを配り、
   * 違っていたら計画はおしまい。該当しない・手順が見つからないときは null（普通の手駒にする）。
   */
  allClearTray(fill) {
    const random = this.generator.random;
    const plan = this.plan;
    this.plan = null;
    if (plan && Sim.keyOf(Sim.fromBoard(this.board)) === plan.key) return this.dealPlan(plan.rest);
    if (plan) return null;                                     // 手順から外れた直後は、ふつうの手駒にする
    if (Sim.garbageCount(Sim.fromBoard(this.board))) return null;   // 対戦でおじゃまがあると全消しはできない（おじゃまは置いても消えない）
    const rolled = !this.wantAllClear && random() < this.allClearRate;
    this.wantAllClear ||= rolled;
    if (!this.wantAllClear) return null;
    if (rolled) this.stats.allClearRolled++;
    this.stats.allClearSearches++;
    const seq = planAllClear(this.board, { depths: ALL_CLEAR_PIECES, random, budgetMs: ALL_CLEAR_BUDGET_MS });
    if (!seq) return null;                                     // 見つからなければ次の補充でもう一度
    this.stats.allClearFound++;
    this.wantAllClear = false;
    return this.dealPlan(seq);
  }

  /** 手順の最初の3個を配り、残りを計画として持つ（次に配る時、ここまで手順どおりの盤面なら続きを配る） */
  dealPlan(seq) {
    const first = seq.slice(0, TRAY_SIZE), rest = seq.slice(TRAY_SIZE);
    this.planTray = first.map((m) => ({ ...m }));
    if (rest.length) this.plan = { key: keyAfter(this.board, first), rest };
    return this.deal(first);
  }

  /** 手順の形をトレイにする（並びは混ぜて、置く順番がそのまま見えないようにする） */
  deal(seq) {
    const tray = seq.map((m) => new Piece(m.name));
    for (let i = tray.length - 1; i > 0; i--) {
      const j = Math.floor(this.generator.random() * (i + 1));
      [tray[i], tray[j]] = [tray[j], tray[i]];
    }
    return tray;
  }

  /**
   * 条件なしの1回分の抽選。各枠、CHAIN_PIECE_RATE（50%）で置けば発動が起きる形（連鎖ピース）、残り（50%）で穴・凹みに気持ちよくはまる形。
   * 選んだ種類の形が今の盤面に1つも無いときは、もう一方の種類、それも無ければ重みどおりのランダム
   */
  drawTray() {
    return Array.from({ length: TRAY_SIZE }, () => {
      const chainFirst = this.generator.random() < CHAIN_PIECE_RATE;
      for (const list of chainFirst ? [this.chainPieces(), this.fitPieces()] : [this.fitPieces(), this.chainPieces()]) {
        if (list.length) return new Piece(this.generator.pick(list).name);
      }
      return this.generator.next();
    });
  }

  /**
   * 今の盤面の穴・凹みに気持ちよくはまる形の向き一覧 [{name, fit, weight}]（Sim.fitOf。同じ盤面なら前回の結果を使う）。
   * 置ける場所のうち一番気持ちよいはまり方で、FIT_WEIGHTS × 形のマス数の重み
   */
  fitPieces() {
    const start = Sim.fromBoard(this.board);
    const key = Sim.keyOf(start);
    if (this.fitCache?.key === key) return this.fitCache.list;
    const out = [];
    for (const shape of SHAPES) {
      const { cells } = new Piece(shape.name);
      let best = null;
      for (const [ox, oy] of Sim.placements(start, cells)) {
        const { kind } = Sim.fitOf(start, cells, ox, oy);
        if (kind && (!best || FIT_WEIGHTS[kind] > FIT_WEIGHTS[best])) best = kind;
        if (best === 'perfect') break;
      }
      if (best) out.push({ name: shape.name, fit: best, weight: cells.length * FIT_WEIGHTS[best] });
    }
    this.fitCache = { key, list: out };
    return out;
  }

  /** 今の盤面で発動を起こせる形の向き一覧 [{name, chain, weight}]（同じ盤面なら前回の結果を使う） */
  chainPieces() {
    const start = Sim.fromBoard(this.board);
    const key = Sim.keyOf(start);
    if (this.chainCache?.key === key) return this.chainCache.list;
    const out = [];
    for (const shape of SHAPES) {
      const { cells } = new Piece(shape.name);
      let best = 0;
      for (const [ox, oy] of Sim.placements(start, cells)) {
        const b = Sim.cloneSim(start);
        Sim.place(b, cells, ox, oy);
        best = Math.max(best, Sim.resolveAll(b));
      }
      if (best > 0) out.push({ name: shape.name, chain: best, weight: best });
    }
    this.chainCache = { key, list: out };
    return out;
  }

  /**
   * 学習モードのおすすめ { slot, ox, oy, plan }。全消しの手順どおりに進んでいる間はその手順の次の手（plan: true）、
   * それ以外は advisor.bestMove（今の盤面での総当たり）。置ける手が無ければ null
   */
  hint() {
    if (this.gameOver) return null;
    const planned = this.planHint();
    if (planned) return planned;
    const m = bestMove(this.board, this.tray);
    return m && { ...m, plan: false };
  }

  /** 全消しの手順どおりの次の手（今のトレイで置けるもの）。無ければ null */
  planHint() {
    for (const m of this.planTray ?? []) {
      const slot = this.tray.findIndex((p) => p?.name === m.name);
      if (slot >= 0 && this.board.canPlace(this.tray[slot], m.ox, m.oy)) return { slot, ox: m.ox, oy: m.oy, plan: true };
    }
    return null;
  }

  /**
   * hint と同じ答えを Promise で返す。総当たり（bestMove）は dealer があれば別スレッドで行う
   * （時間の上限つきの総当たりで、画面を止めないように）。dealer が無ければ hint と同じくこの場で
   */
  hintAsync() {
    if (this.gameOver || !this.dealer) return Promise.resolve(this.hint());
    const planned = this.planHint();
    if (planned) return Promise.resolve(planned);
    const { cells, garbage } = this.cellLists();
    return this.dealer.hint(cells, this.tray.map((p) => p && p.name), garbage).then((m) => m && { ...m, plan: false });
  }

  hasMove() {
    return this.tray.some((p) => p && this.board.fits(p));
  }

  debugStatus() { return this.board.debugLines(); }
}

/** 手順集の1本（"形@xy 形@xy …"）を [{ name, ox, oy }, …] にする */
export const decodePlan = (code) => code.split(' ').map((m) => {
  const [name, xy] = m.split('@');
  return { name, ox: Number(xy[0]), oy: Number(xy[1]) };
});

/** トレイのピースを全部置けるか（順番は自由、置くたびに連鎖も解決する。planner.solvable） */
export function isSolvable(board, pieces) {
  return solvable(Sim.fromBoard(board), pieces.filter(Boolean).map((p) => p.name));
}

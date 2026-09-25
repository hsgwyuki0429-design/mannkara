import { Board } from './board.js?v=202609251354';
import { PieceGenerator, Piece, SHAPES } from './pieces.js?v=202609251354';
import { ScoreManager } from './score.js?v=202609251354';
import { nextActivation, lineMoves } from './mancala.js?v=202609251354';
import { solvable, countWays, spots, planAllClear, keyAfter } from './planner.js?v=202609251354';
import * as Sim from './sim.js?v=202609251354';
import { ALL_CLEAR_PLANS } from './allclear-library.js?v=202609251354';
import { bestMove } from './advisor.js?v=202609251354';
import {
  TRAY_SIZE, CHAIN_PIECE_RATE, HARD_FILL, WAYS_MAX, WAYS_TOLERANCE,
  TIGHT_RATE, TIGHT_MAX_FILL, TIGHT_MIN_SPOTS, TIGHT_MAX_WAYS, TIGHT_CAP, TIGHT_BUDGET_MS,
  LINEUP_CANDIDATES, LINEUP_BUDGET_MS, targetWays,
  ALL_CLEAR_RATE, ALL_CLEAR_PIECES, EMPTY_ALL_CLEAR_RATE, ALL_CLEAR_BUDGET_MS, TRAY_RETRIES,
} from './constants.js?v=202609251354';

/**
 * ゲーム本体（DOM 非依存）。ルールは同期的に即確定し、描画側は hooks.onTurn で記録を受け取って再生する。
 * 流れ: 置く → 満杯のライン(縦/横)のうち最小番号を1本発動、を発動が無くなるまで繰り返す
 *       → スコア確定 → トレイ補充（3つ使い切ったら）→ ゲームオーバー判定
 */
const now = () => (globalThis.performance?.now?.() ?? Date.now());

export class Game {
  constructor({ random = Math.random, hooks = {} } = {}) {
    this.generator = new PieceGenerator(random);
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.board = new Board();
    this.score = new ScoreManager();
    this.planTray = null;         // 今のトレイで、全消しの手順どおりにまだ置いていない手 [{ name, ox, oy }]
    this.plan = null;             // 全消しの計画の続き { key: ここまで手順どおりに置いた盤面, rest: 残りの手順 }
    this.wantAllClear = false;    // 全消しのチャンスを引いたが、まだ手順が見つかっていない
    this.wantTight = false;       // 置き方の少ない組み合わせのチャンスを引いたが、まだ見つかっていない
    this.history = new Set();     // これまでに手駒を配った時の盤面（ループの判定用）
    this.lastLineup = null;       // 直前に配った手駒の決め方（デバッグ・テスト用）
    this.tray = this.spawnTray();
    this.gameOver = false;
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
    // 全消しの手順どおりの手か（違ったら、このトレイではもう手順を教えない）
    if (this.planTray) {
      const i = this.planTray.findIndex((m) => m.name === piece.name && m.ox === ox && m.oy === oy);
      this.planTray = i < 0 ? null : this.planTray.filter((_, j) => j !== i);
    }
    const placed = this.board.place(piece, ox, oy);
    this.score.addPlaced(placed.length);
    const scoreAfterPlace = this.score.score;

    const steps = this.resolve();
    this.score.endTurn(steps.length > 0);

    let refilled = false;
    if (this.tray.every((p) => !p)) {
      this.planTray = null;
      this.tray = this.spawnTray();
      refilled = true;
    }
    if (!this.hasMove()) this.gameOver = true;

    const turn = {
      slot, piece, placed, steps, refilled, scoreAfterPlace,
      allClear: steps.length > 0 && this.board.totalBlocks() === 0,
      score: this.score.score, streak: this.score.streak, gameOver: this.gameOver,
    };
    this.hooks.onTurn?.(turn);
    return turn;
  }

  /** 発動が無くなるまで1本ずつ処理（毎回盤面を再判定）。各ステップに前後のスナップショットを残す */
  resolve() {
    const steps = [];
    for (let act; (act = nextActivation(this.board)); ) {
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
    const fill = this.board.fillRate();
    const start = Sim.fromBoard(this.board);
    this.history.add(Sim.keyOf(start));
    const planned = this.allClearTray(fill);
    if (planned) { this.lastLineup = { kind: 'allClear' }; return planned; }

    if (fill >= TIGHT_MAX_FILL) this.wantTight = false;
    else this.wantTight ||= this.generator.random() < TIGHT_RATE;
    let pick = this.wantTight ? this.searchTight(start) : null;
    if (pick) this.wantTight = false;                          // 見つからなければ次の補充でもう一度
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
   *  - 盤面が空: EMPTY_ALL_CLEAR_RATE の確率で、手順集（allclear-library.js）から1本選ぶ
   *  - ブロックが残っている: ALL_CLEAR_RATE の確率で、今の盤面から ALL_CLEAR_PIECES 個の手順を計算する
   *    （見つからなければ次の補充でもう一度）
   * どちらも最初の3個を配り、残りは計画として持つ。次に配る時、ここまで手順どおりの盤面なら続きを配り、
   * 違っていたら計画はおしまい。該当しない・手順が見つからないときは null（普通の手駒にする）。
   */
  allClearTray(fill) {
    const random = this.generator.random;
    const plan = this.plan;
    this.plan = null;
    if (plan && Sim.keyOf(Sim.fromBoard(this.board)) === plan.key) return this.dealPlan(plan.rest);
    if (this.board.totalBlocks() === 0) {
      this.wantAllClear = false;
      if (random() >= EMPTY_ALL_CLEAR_RATE) return null;
      return this.dealPlan(decodePlan(ALL_CLEAR_PLANS[Math.floor(random() * ALL_CLEAR_PLANS.length)]));
    }
    if (plan) return null;                                     // 手順から外れた直後は、ふつうの手駒にする
    this.wantAllClear ||= random() < ALL_CLEAR_RATE;
    if (!this.wantAllClear) return null;
    const seq = planAllClear(this.board, { depths: ALL_CLEAR_PIECES, random, budgetMs: ALL_CLEAR_BUDGET_MS });
    if (!seq) return null;                                     // 見つからなければ次の補充でもう一度
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

  /** 条件なしの1回分の抽選（各枠 CHAIN_PIECE_RATE で連鎖ピース） */
  drawTray() {
    return Array.from({ length: TRAY_SIZE }, () => {
      if (this.generator.random() < CHAIN_PIECE_RATE) {
        const chainers = this.chainPieces();
        if (chainers.length) return new Piece(this.generator.pick(chainers).name);
      }
      return this.generator.next();
    });
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
    for (const m of this.planTray ?? []) {
      const slot = this.tray.findIndex((p) => p?.name === m.name);
      if (slot >= 0 && this.board.canPlace(this.tray[slot], m.ox, m.oy)) return { slot, ox: m.ox, oy: m.oy, plan: true };
    }
    const m = bestMove(this.board, this.tray);
    return m && { ...m, plan: false };
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

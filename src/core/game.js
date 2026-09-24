import { Board } from './board.js?v=202609240026';
import { PieceGenerator, Piece, SHAPES } from './pieces.js?v=202609240026';
import { ScoreManager } from './score.js?v=202609240026';
import { nextActivation, lineMoves } from './mancala.js?v=202609240026';
import { solvable, planAllClear, keyAfter } from './planner.js?v=202609240026';
import * as Sim from './sim.js?v=202609240026';
import {
  TRAY_SIZE, CHAIN_PIECE_RATE, HARD_FILL, HARD_SOLVABLE_RATE,
  ALL_CLEAR_FILL, ALL_CLEAR_RATE, ALL_CLEAR_PIECES, ALL_CLEAR_BUDGET_MS, TRAY_RETRIES,
} from './constants.js?v=202609240026';

/**
 * ゲーム本体（DOM 非依存）。ルールは同期的に即確定し、描画側は hooks.onTurn で記録を受け取って再生する。
 * 流れ: 置く → 満杯のライン(縦/横)のうち最小番号を1本発動、を発動が無くなるまで繰り返す
 *       → スコア確定 → トレイ補充（3つ使い切ったら）→ ゲームオーバー判定
 */
export class Game {
  constructor({ random = Math.random, hooks = {} } = {}) {
    this.generator = new PieceGenerator(random);
    this.hooks = hooks;
    this.reset();
  }

  reset() {
    this.board = new Board();
    this.score = new ScoreManager();
    this.plan = null;             // 全消しの計画の続き { key: 1回目を置き終えた盤面, rest: 2回目の手駒 }
    this.wantAllClear = false;    // 全消しのチャンスを引いたが、まだ手順が見つかっていない
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
    const placed = this.board.place(piece, ox, oy);
    this.score.addPlaced(placed.length);
    const scoreAfterPlace = this.score.score;

    const steps = this.resolve();
    this.score.endTurn(steps.length > 0);

    let refilled = false;
    if (this.tray.every((p) => !p)) {
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
   * 新しいトレイを作る（仕様。埋まり具合 fill = Board.fillRate）:
   *  - 全消しのチャンス（allClearTray）なら、計算した手駒
   *  - HARD_FILL 以上: HARD_SOLVABLE_RATE の確率で「うまい順番と場所なら3つとも置ける」組み合わせ、
   *    残りは条件なしのランダム
   *  - HARD_FILL 未満: 必ず「順番と場所を選べば3つとも置ける」組み合わせ（詰まない手順が1つ以上ある）
   * 3つとも置ける組み合わせが見つからない盤面では、せめて1つは置ける組み合わせにする。
   */
  spawnTray() {
    const fill = this.board.fillRate();
    const planned = this.allClearTray(fill);
    if (planned) return planned;
    if (fill >= HARD_FILL && this.generator.random() >= HARD_SOLVABLE_RATE) return this.drawTray();

    let fallback = null;
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const tray = this.drawTray();
      if (!tray.some((p) => this.board.fits(p))) continue;
      if (isSolvable(this.board, tray)) return tray;
      fallback ??= tray;
    }
    // 抽選で見つからなければ、置ける形だけから組み直す
    const placeable = SHAPES.filter((s) => this.board.fits(new Piece(s.name)));
    if (!placeable.length) return this.drawTray();           // 何も入らない＝詰み
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const tray = Array.from({ length: TRAY_SIZE }, () => new Piece(this.generator.pick(placeable).name));
      if (isSolvable(this.board, tray)) return tray;
    }
    return fallback ?? [new Piece(this.generator.pick(placeable).name), ...this.drawTray().slice(1)];
  }

  /**
   * 全消しのチャンス。埋まり具合が ALL_CLEAR_FILL 以下のとき ALL_CLEAR_RATE の確率で、
   * 「ALL_CLEAR_PIECES 個（トレイ2回ぶん）置いたところで全消しできる」手順を計算し、その1回目を配る。
   * 2回目は、計画どおりの盤面になっていれば計画の続きを、違っていれば今の盤面から3つで全消しできる組を探し直して配る。
   * 該当しない・手順が見つからないときは null（普通の手駒にする）。
   */
  allClearTray(fill) {
    const random = this.generator.random;
    const plan = this.plan;
    this.plan = null;
    if (plan) {
      if (Sim.keyOf(Sim.fromBoard(this.board)) === plan.key) return this.deal(plan.rest);
      const seq = planAllClear(this.board, { depth: TRAY_SIZE, random, budgetMs: ALL_CLEAR_BUDGET_MS });
      if (seq) return this.deal(seq);
    }
    if (fill > ALL_CLEAR_FILL) { this.wantAllClear = false; return null; }
    this.wantAllClear ||= random() < ALL_CLEAR_RATE;
    if (!this.wantAllClear) return null;
    const seq = planAllClear(this.board, { depth: ALL_CLEAR_PIECES, random, budgetMs: ALL_CLEAR_BUDGET_MS });
    if (!seq) return null;                                     // 見つからなければ次の補充でもう一度
    this.wantAllClear = false;
    const first = seq.slice(0, TRAY_SIZE), rest = seq.slice(TRAY_SIZE);
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

  hasMove() {
    return this.tray.some((p) => p && this.board.fits(p));
  }

  debugStatus() { return this.board.debugLines(); }
}

/** トレイのピースを全部置けるか（順番は自由、置くたびに連鎖も解決する。planner.solvable） */
export function isSolvable(board, pieces) {
  return solvable(Sim.fromBoard(board), pieces.filter(Boolean).map((p) => p.name));
}

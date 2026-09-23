import { Board } from './board.js?v=202609230413';
import { PieceGenerator, Piece, SHAPES } from './pieces.js?v=202609230413';
import { ScoreManager } from './score.js?v=202609230413';
import { nextActivation, lineMoves, resolveChains } from './mancala.js?v=202609230413';
import { TRAY_SIZE, CHAIN_PIECE_RATE, SOLVABLE_TRAY_RATE, TRAY_RETRIES } from './constants.js?v=202609230413';

/**
 * ゲーム本体（DOM 非依存）。描画側は hooks（async 可）で進行を受け取る。
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
    this.tray = this.spawnTray();
    this.gameOver = false;
    this.busy = false;
  }

  canPlace(slot, ox, oy) {
    const piece = this.tray[slot];
    return !!piece && this.board.canPlace(piece, ox, oy);
  }

  /** トレイ slot のピースを (ox, oy)=左上の画面座標 に置く。連鎖まで完全に処理する */
  async placePiece(slot, ox, oy) {
    if (this.busy || this.gameOver || !this.canPlace(slot, ox, oy)) return false;
    this.busy = true;
    const piece = this.tray[slot];
    this.tray[slot] = null;
    const placed = this.board.place(piece, ox, oy);
    this.score.addPlaced(placed.length);
    await this.hooks.onPlaced?.(placed, piece);

    const steps = await this.resolve();
    this.score.endTurn(steps.length > 0);
    await this.hooks.onTurnEnd?.(steps);

    if (this.tray.every((p) => !p)) {
      this.tray = this.spawnTray();
      await this.hooks.onTrayRefill?.(this.tray);
    }
    if (!this.hasMove()) {
      this.gameOver = true;
      await this.hooks.onGameOver?.();
    }
    this.busy = false;
    return true;
  }

  /** 発動が無くなるまで1つずつ処理（毎回盤面を再判定） */
  async resolve() {
    const steps = [];
    for (let act; (act = nextActivation(this.board)); ) {
      const step = { kind: act.kind, n: act.n, chain: steps.length + 1, stack: [], moves: [], goals: 0 };
      for (const ev of lineMoves(this.board, act.kind, act.n)) {
        if (ev.type === 'take') { step.stack = ev.blocks; continue; }
        step.moves.push({ block: ev.block, to: ev.to });
        if (ev.to === 'goal') step.goals++;
      }
      await this.hooks.onLine?.(step);
      steps.push(step);
      const gained = this.score.addStep(step);
      await this.hooks.onStep?.(step, gained);
      if (steps.length > 2000) break;
    }
    return steps;
  }

  /**
   * トレイ3枠を作る。各枠 CHAIN_PIECE_RATE の確率で「今の盤面のどこかに置けば発動が起きる」
   * テトロミノを選ぶ（連鎖数が大きい向きほど選ばれやすい）。該当が無ければ通常の抽選。
   */
  /**
   * 新しいトレイを作る（仕様）:
   *  - 必ず1つ以上は今の盤面に置ける
   *  - SOLVABLE_TRAY_RATE の確率で「順番と場所を選べば3つとも置ける」組み合わせにする
   * 条件を満たすまで抽選し直す。盤面にテトロミノが1つも入らない時だけは保証できない。
   */
  spawnTray() {
    const wantSolvable = this.generator.random() < SOLVABLE_TRAY_RATE;
    let fallback = null;
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const tray = this.drawTray();
      if (!tray.some((p) => this.board.fits(p))) continue;
      if (!wantSolvable || isSolvable(this.board, tray)) return tray;
      fallback ??= tray;
    }
    // 抽選で見つからなければ、置ける形だけから組み直す
    const placeable = SHAPES.filter((s) => this.board.fits(new Piece(s.name)));
    if (!placeable.length) return this.drawTray();           // 何も入らない＝詰み
    for (let tries = 0; tries < TRAY_RETRIES; tries++) {
      const tray = Array.from({ length: TRAY_SIZE }, () => new Piece(this.generator.pick(placeable).name));
      if (!wantSolvable || isSolvable(this.board, tray)) return tray;
    }
    return fallback ?? [new Piece(this.generator.pick(placeable).name), ...this.drawTray().slice(1)];
  }

  /** 条件なしの1回分の抽選（各枠 CHAIN_PIECE_RATE で連鎖ピース） */
  drawTray() {
    let chainers = null;
    return Array.from({ length: TRAY_SIZE }, () => {
      if (this.generator.random() < CHAIN_PIECE_RATE) {
        chainers ??= this.chainPieces();
        if (chainers.length) return new Piece(this.generator.pick(chainers).name);
      }
      return this.generator.next();
    });
  }

  /** 今の盤面で発動を起こせるテトロミノの向き一覧 [{name, chain, weight}] */
  chainPieces() {
    const out = [];
    for (const shape of SHAPES) {
      const piece = new Piece(shape.name);
      let best = 0;
      for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) {
        if (!this.board.canPlace(piece, ox, oy)) continue;
        const b = this.board.clone();
        b.place(piece, ox, oy);
        best = Math.max(best, resolveChains(b).length);
      }
      if (best > 0) out.push({ name: shape.name, chain: best, weight: best });
    }
    return out;
  }

  hasMove() {
    return this.tray.some((p) => p && this.board.fits(p));
  }

  debugStatus() { return this.board.debugLines(); }
}

/**
 * トレイのピースを全部置けるか（順番は自由、置くたびに連鎖も解決する）。
 * 深さ優先で「残りのどれかを、どこかに置く」を試し、1通りでも最後まで置ければ true。
 */
export function isSolvable(board, pieces) {
  const rest = pieces.filter(Boolean);
  if (rest.length === 0) return true;
  if (rest.length === 1) return board.fits(rest[0]);
  const tried = new Set();
  for (let i = 0; i < rest.length; i++) {
    const p = rest[i];
    if (tried.has(p.name)) continue;                  // 同じ形は1回試せば十分
    tried.add(p.name);
    const others = rest.filter((_, j) => j !== i);
    for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) {
      if (!board.canPlace(p, ox, oy)) continue;
      const b = board.clone();
      b.place(p, ox, oy);
      resolveChains(b);
      if (isSolvable(b, others)) return true;
    }
  }
  return false;
}

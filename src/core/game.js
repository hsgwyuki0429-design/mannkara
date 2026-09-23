import { Board } from './board.js';
import { PieceGenerator } from './pieces.js';
import { ScoreManager } from './score.js';
import { nextActivation, lineMoves } from './mancala.js';
import { TRAY_SIZE } from './constants.js';

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
    this.tray = this.generator.spawnTray(TRAY_SIZE);
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
      this.tray = this.generator.spawnTray(TRAY_SIZE);
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

  hasMove() {
    return this.tray.some((p) => p && this.board.fits(p));
  }

  debugStatus() { return this.board.debugLines(); }
}

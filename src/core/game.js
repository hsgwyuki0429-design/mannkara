import { Board } from './board.js';
import { PieceGenerator } from './pieces.js';
import { ScoreManager } from './score.js';
import { columnMoves } from './mancala.js';
import { COLUMN_COUNT, screenXToColIndex } from './constants.js';

/**
 * ゲーム本体（DOM 非依存）。
 * 描画側は hooks（すべて async 可）で進行を受け取る。
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
    this.candidates = this.generator.spawnCandidates([], 3);
    this.gameOver = false;
    this.busy = false;
  }

  /** 候補 index のピースを screenX（左端）に落とす。連鎖まで完全に処理する。 */
  async placePiece(candidateIndex, screenX) {
    if (this.busy || this.gameOver) return false;
    const p = this.candidates[candidateIndex];
    if (!p) return false;
    const cells = p.cellsAt(screenX);
    if (!this.board.canPlaceCells(cells)) return false;

    this.busy = true;
    const placed = this.board.placeCells(cells);
    await this.hooks.onPlaced?.(placed);

    // 連鎖：1列発動するたびに盤面を再判定（最小番号優先）
    const steps = [];
    for (;;) {
      const candidatesCols = this.board.findExactColumns();
      if (candidatesCols.length === 0) break;
      const column = Math.min(...candidatesCols);
      const chain = steps.length + 1;
      const step = { column, chain, moves: [], goalCount: 1 };
      steps.push(step);
      let stack = [];
      for (const ev of columnMoves(this.board, column)) {
        if (ev.type === 'suck') stack = ev.blocks; // 下から順のブロック列
        else step.moves.push({ block: ev.block, from: ev.from, to: ev.to });
      }
      step.stack = stack;
      await this.hooks.onColumnResolve?.(step);
      const gained = this.score.addStep(chain, 1);
      await this.hooks.onChainStep?.(step, gained);
    }
    await this.hooks.onChainEnd?.(steps);

    // 候補補充
    this.candidates.splice(candidateIndex, 1);
    this.candidates = this.generator.spawnCandidates(this.candidates, 3);

    // ゲームオーバー判定（連鎖完全終了後）
    if (this.board.isOverflow() || !this.hasLegalPlacement()) {
      this.gameOver = true;
      await this.hooks.onGameOver?.();
    }
    this.busy = false;
    return true;
  }

  hasLegalPlacement() {
    for (const p of this.candidates) {
      const w = p.width;
      for (let x = 0; x + w <= COLUMN_COUNT; x++) {
        if (this.board.canPlaceCells(p.cellsAt(x))) return true;
      }
    }
    return false;
  }

  debugStatus() { return this.board.debugLines(); }
}

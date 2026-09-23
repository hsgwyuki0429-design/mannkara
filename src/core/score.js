import {
  SCORE_PER_CELL_PLACED, SCORE_PER_COLUMN_GOAL, SCORE_PER_ROW_CELL,
  chainMultiplier, streakMultiplier,
} from './constants.js';

export class ScoreManager {
  constructor() { this.reset(); }
  reset() {
    this.score = 0; this.goals = 0;
    this.lastChain = 0; this.bestChain = 0;
    this.streak = 0; this.bestStreak = 0;
  }
  addPlaced(cells) {
    this.score += cells * SCORE_PER_CELL_PLACED;
  }
  /** 1発動ぶん。streak は「このターンを含む連続発動手数」 */
  addStep(step) {
    this.goals += step.goals;
    this.lastChain = step.chain;
    this.bestChain = Math.max(this.bestChain, step.chain);
    const base = step.type === 'rows' ? step.goals * SCORE_PER_ROW_CELL : step.goals * SCORE_PER_COLUMN_GOAL;
    const gained = Math.round(base * chainMultiplier(step.chain) * streakMultiplier(Math.max(1, this.streak + 1)));
    this.score += gained;
    return gained;
  }
  /** ターン終了。何か発動したら streak 継続、なければ途切れる */
  endTurn(activated) {
    this.streak = activated ? this.streak + 1 : 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (!activated) this.lastChain = 0;
  }
}

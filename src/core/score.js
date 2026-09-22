import { SCORE_PER_GOAL, chainMultiplier } from './constants.js';

export class ScoreManager {
  constructor() { this.reset(); }
  reset() { this.score = 0; this.bestChain = 0; this.lastChain = 0; this.goals = 0; }
  /** 1ステップ（1列発動）ぶんを加算 */
  addStep(chain, goalCount = 1) {
    this.goals += goalCount;
    this.lastChain = chain;
    if (chain > this.bestChain) this.bestChain = chain;
    const gained = Math.round(SCORE_PER_GOAL * goalCount * chainMultiplier(chain));
    this.score += gained;
    return gained;
  }
}

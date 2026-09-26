import {
  SCORE_PER_CELL_PLACED, SCORE_PER_GOAL, ALL_CLEAR_BONUS, SCORE_PER_PERFECT_FIT_CELL, SCORE_PER_RECT_CELL,
  chainMultiplier, streakMultiplier,
} from './constants.js?v=202609261155';

export class ScoreManager {
  constructor() { this.reset(); }
  reset() {
    this.score = 0; this.goals = 0;
    this.lastChain = 0; this.bestChain = 0;
    this.streak = 0; this.bestStreak = 0;
    this.allClears = 0; this.perfectFits = 0; this.rects = 0;
  }
  addPlaced(cells) {
    this.score += cells * SCORE_PER_CELL_PLACED;
  }
  /** 1発動ぶん。streak は「このターンを含む連続発動手数」 */
  addStep(step) {
    this.goals += step.goals;
    this.lastChain = step.chain;
    this.bestChain = Math.max(this.bestChain, step.chain);
    const base = step.goals * SCORE_PER_GOAL;
    const gained = Math.round(base * chainMultiplier(step.chain) * streakMultiplier(Math.max(1, this.streak + 1)));
    this.score += gained;
    return gained;
  }
  /** 気持ちよくはまった置き方のボーナス（Sim.fitOf の結果）。穴にぴったり + 長方形ができた、は足す */
  addFit({ kind, rect }, cells) {
    let gained = 0;
    if (kind === 'perfect') { this.perfectFits++; gained += cells * SCORE_PER_PERFECT_FIT_CELL; }
    if (rect) { this.rects++; gained += rect.w * rect.h * SCORE_PER_RECT_CELL; }
    this.score += gained;
    return gained;
  }
  /** 全消しのボーナス。endTurn のあと（streak = このターンを含む連続発動手数）に呼ぶ */
  addAllClear() {
    this.allClears++;
    const gained = Math.round(ALL_CLEAR_BONUS * streakMultiplier(Math.max(1, this.streak)));
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

import {
  SCORE_PER_CELL_PLACED, SCORE_PER_GOAL, ALL_CLEAR_BONUS, SCORE_PER_PERFECT_FIT_CELL, SCORE_PER_RECT_CELL,
  ALL_CLEAR_BOOST, ALL_CLEAR_BOOST_TURNS, chainMultiplier, streakMultiplier,
} from './constants.js?v=2026100104';

export class ScoreManager {
  constructor() { this.reset(); }
  reset() {
    this.score = 0; this.goals = 0;
    this.lastChain = 0; this.bestChain = 0;
    this.streak = 0; this.bestStreak = 0;
    this.allClears = 0; this.perfectFits = 0; this.rects = 0;
    this.boostTurns = 0;          // 全消しのあとの倍率が残っている手数（このターンを含む）
  }
  /** 全消しのあとの倍率（残っていなければ 1）。このターンに手に入るスコアすべてに掛ける */
  get boost() { return this.boostTurns > 0 ? ALL_CLEAR_BOOST : 1; }
  addPlaced(cells) {
    this.score += Math.round(cells * SCORE_PER_CELL_PLACED * this.boost);
  }
  /** 1発動ぶん。streak は「このターンを含む連続発動手数」 */
  addStep(step) {
    this.goals += step.goals;
    this.lastChain = step.chain;
    this.bestChain = Math.max(this.bestChain, step.chain);
    const base = step.goals * SCORE_PER_GOAL;
    const gained = Math.round(base * chainMultiplier(step.chain) * streakMultiplier(Math.max(1, this.streak + 1)) * this.boost);
    this.score += gained;
    return gained;
  }
  /** 気持ちよくはまった置き方のボーナス（Sim.fitOf の結果）。穴にぴったり + 長方形ができた、は足す */
  addFit({ kind, rect }, cells) {
    let gained = 0;
    if (kind === 'perfect') { this.perfectFits++; gained += cells * SCORE_PER_PERFECT_FIT_CELL; }
    if (rect) { this.rects++; gained += rect.w * rect.h * SCORE_PER_RECT_CELL; }
    gained = Math.round(gained * this.boost);
    this.score += gained;
    return gained;
  }
  /**
   * 全消しのボーナス。endTurn のあと（streak = このターンを含む連続発動手数）に呼ぶ。
   * 次の ALL_CLEAR_BOOST_TURNS 手のあいだ、手に入るスコアに ×ALL_CLEAR_BOOST（もう一度全消しすると手数が戻る）
   */
  addAllClear() {
    this.allClears++;
    const gained = Math.round(ALL_CLEAR_BONUS * streakMultiplier(Math.max(1, this.streak)));
    this.score += gained;
    this.boostTurns = ALL_CLEAR_BOOST_TURNS;
    return gained;
  }
  /** ターン終了。何か発動したら streak 継続、なければ途切れる。全消しのあとの倍率を1手ぶん減らす */
  endTurn(activated) {
    if (this.boostTurns > 0) this.boostTurns--;
    this.streak = activated ? this.streak + 1 : 0;
    this.bestStreak = Math.max(this.bestStreak, this.streak);
    if (!activated) this.lastChain = 0;
  }
}

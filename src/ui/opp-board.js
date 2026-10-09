import { ANIM } from '../core/constants.js?v=202610091340';
import { dropPlayMs } from '../core/battle.js?v=202610091340';
import { Renderer, planSpeeds, turnPlayCost, PRAISE } from './renderer.js?v=202610091340';

/**
 * 対戦で、相手の盤面を映す。自分の盤面と同じ描き方（renderer.js の Renderer をもう 1 つ。盤面の種類・土台の色・宝石・通路の番号・ゴール・
 * 連鎖の動き・おじゃまの落ち方と「−1」まで、まったく同じ見た目）。音は鳴らさない。
 * 相手が置いたターン（core/game.js の turn と同じ形）を、相手の画面と同じ速さ・同じ長さで再生する（速さは base。対戦では 3 倍）。
 * 再生が溜まっても早送りしない（自分の盤面の連鎖と、いつも同じ速さ）
 */
export class OppBoard {
  /** root = 盤面を作る入れ物（.stage と同じ役目） */
  constructor(root) {
    this.root = root;
    this.r = new Renderer(null, { root });
    this.queue = Promise.resolve();
    this.left = 0;                 // 再生の残り（速さ 1 のときの ms）
    this.paused = false;
    this.gen = 0;
    this.base = 1;
    this.r.timeScale = 1;
  }
  /** 土台の層（背景の色に合わせて変わる。ambient.bindBoard に渡す） */
  get plateSets() { return this.r.plateSets; }

  /** 盤面の高さ（マスの大きさ cell で、自分の盤面と同じ見える範囲が収まる高さ。renderer.js の layout） */
  static height(cell) { return Math.ceil(Renderer.spanH * cell + 6); }
  /** マスの大きさを決める（入れ物の高さを合わせると、Renderer が収まる大きさで並べ直す） */
  layout(cell) {
    this.root.style.height = OppBoard.height(cell) + 'px';
    this.r.layout();
  }

  /** 盤面（core/board.js の Board）をそのまま映す（再生の途中のものは打ち切る） */
  reset(board) {
    this.gen++;
    this.queue = Promise.resolve();
    this.left = 0;
    this.r.reset();
    if (board) this.r.bindBoard(board);
    this.sync();
  }

  /** 再生の残り（ms。相手の画面での残りと同じ見積もり。速さで割った、ほんとうの時間） */
  playLeft() { return this.left / this.base; }
  setPaused(on) {
    this.paused = !!on;
    this.r.setPaused(this.paused);
    this.sync();
  }
  /** 再生の速さ: いつも base（自分の盤面と同じ。再生が溜まっても早送りしない） */
  speed() { return this.base; }
  sync() { this.r.timeScale = this.paused ? 0 : this.speed(); }

  /** 再生の列に並べる（順番に 1 つずつ） */
  enqueue(cost, fn) {
    const gen = this.gen;
    this.left += cost;
    this.sync();
    this.queue = this.queue.then(() => (gen === this.gen ? fn() : null)).catch((e) => console.error(e)).finally(() => {
      if (gen === this.gen) { this.left = Math.max(0, this.left - cost); this.sync(); }
    });
    return this.queue;
  }

  /**
   * 相手が置いたターンを再生する（自分の盤面の再生 main.js の playTurn と同じ動き・文字。得点の数字・画面全体の色は出さない）。
   * 返り値は、この再生が終わったときに解決する Promise
   */
  playTurn(turn) {
    return this.enqueue(turnCost(turn), async () => {
      const r = this.r, gen = this.gen, stale = () => gen !== this.gen;
      r.popIn(turn.placed, turn.fit === 'perfect' || !!turn.rect);
      if (turn.steps.length && turn.streak >= 2) r.showCombo(turn.streak);
      const speeds = planSpeeds(turn.steps);
      for (const [i, step] of turn.steps.entries()) {
        if (i === 0) await r.charge(step.kind, step.n, step.stack, ANIM.charge);
        if (stale()) return;
        await r.playStep(step, speeds[i]);
        if (stale()) return;
        for (const h of turn.chip?.hits ?? []) if (h.step === i + 1) r.garbageHit(h);   // 連鎖の 1 段ごとに、おじゃま 1 個を「−その段の数」
        const [, praise, tier] = PRAISE.find(([n]) => step.chain >= n) ?? [];
        if (step.chain >= 2) r.showText(`${step.chain} CHAIN<small>${praise}</small>`, `t${tier}`);
        await r.wait(ANIM.betweenChains / speeds[i]);
        if (stale()) return;
      }
      if (turn.allClear) {
        r.showText('ALL CLEAR!', 't5');                  // 得点の数字は出さない（対戦では点数は使わない）
        r.allClearBlast();
      }
    });
  }

  /** おじゃまが落ちてくる（landed = [{ block, x, r, n }]。自分の盤面と同じ置かれ方） */
  playDrop(landed) {
    if (!landed?.length) return this.queue;
    return this.enqueue(dropPlayMs(landed.length), () => this.r.garbageLand(landed));
  }

  /** ゴールの画面の座標（攻撃が飛び立つ場所） */
  goalPoint() {
    const g = this.r.goal.getBoundingClientRect();
    return { x: g.left + g.width / 2, y: g.top + g.height / 2 };
  }
}

/** 相手のターンの再生時間（速さ 1 のとき。自分の盤面の見積もりと同じ。置いただけのターンは置いた弾みのぶん） */
export function turnCost(turn) {
  return turn.steps.length ? turnPlayCost(turn) : 120;
}

import { Game } from './game.js?v=202610091147';
import { Piece } from './pieces.js?v=202610091147';
import { bestMove } from './advisor.js?v=202610091147';
import { Board, createGarbage } from './board.js?v=202610091147';
import { SIZE } from './constants.js?v=202610091147';

/**
 * 手駒の決め方（Game.spawnTray）だけを受け持つ。画面では Web Worker の中で動かす（dealer-worker.js）。
 * 決め方のコード・時間の上限は Game のものをそのまま使う（ここでは何も変えない）。
 * 全消しの計画・ループの判定の履歴などの状態はここで持ち続け、盤面は配るたびにメインスレッドからもらう
 * （手駒の決め方が見るのは「どのマスが埋まっているか」だけ）。
 */
/** 盤面を埋めるだけの印（手駒の決め方はブロックの色や id を見ないので、通し番号を使う createBlock は使わない） */
const FILLED = Object.freeze({ id: 'dealer', color: 'x' });

export class DealerCore {
  constructor(random = Math.random) {
    this.random = random;
    this.reset();
  }

  /** 新しいゲーム: 状態を最初に戻す */
  reset() {
    this.game = Game.forDealing(this.random);
  }

  /**
   * cells = 埋まっているマスの番号（r * 8 + x）の一覧。
   * 返り値 { names: 手駒の形の名前, planTray: 全消しの手順どおりの手（あれば）, lastLineup: 決め方（デバッグ用） }
   */
  deal(cells, tightRate, allClearRate, garbage = []) {
    const g = this.game;
    if (typeof tightRate === 'number') g.tightRate = tightRate;
    if (typeof allClearRate === 'number') g.allClearRate = allClearRate;
    g.board = boardOf(cells, garbage);
    g.planTray = null;                 // Game.placePiece と同じく、補充の前に消しておく
    const tray = g.spawnTray();
    const lineup = g.lastLineup && { ...g.lastLineup };
    if (lineup?.tray) lineup.tray = lineup.tray.map((p) => p.name);   // Piece はそのまま送れないので名前だけ
    return { names: tray.map((p) => p.name), planTray: g.planTray, lastLineup: lineup, state: this.state() };
  }

  /** 手駒の決め方の状態（途中から再開用） */
  state() {
    const g = this.game;
    return { plan: g.plan, history: [...g.history], wantAllClear: g.wantAllClear, wantTight: g.wantTight, tightCooldown: g.tightCooldown };
  }
  /** state() で残した状態に戻す */
  load(st) {
    const g = this.game;
    g.plan = st.plan ?? null; g.history = new Set(st.history ?? []); g.wantAllClear = !!st.wantAllClear; g.wantTight = !!st.wantTight; g.tightCooldown = st.tightCooldown ?? 0;
  }

  /** 学習モードのおすすめ・対戦の CPU の総当たり（advisor.bestMove そのまま）。names = トレイの形の名前（使った枠は null） */
  hint(cells, names, garbage = [], opts) {
    return bestMove(boardOf(cells, garbage), names.map((n) => n && new Piece(n)), opts);
  }
}

/** garbage = おじゃまのマスの番号（手駒の決め方は、おじゃまのマスを「動かない壁・ラインを満杯にさせないマス」として扱う） */
function boardOf(cells, garbage = []) {
  const board = new Board();
  for (const i of cells) board.set(i % SIZE, Math.floor(i / SIZE), FILLED);
  for (const i of garbage || []) board.set(i % SIZE, Math.floor(i / SIZE), createGarbage(1, 'dealer-g'));
  return board;
}

import { Game } from './game.js?v=202609261436';
import { Piece } from './pieces.js?v=202609261436';
import { bestMove } from './advisor.js?v=202609261436';
import { Board } from './board.js?v=202609261436';
import { SIZE } from './constants.js?v=202609261436';

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
  deal(cells) {
    const g = this.game;
    g.board = boardOf(cells);
    g.planTray = null;                 // Game.placePiece と同じく、補充の前に消しておく
    const tray = g.spawnTray();
    const lineup = g.lastLineup && { ...g.lastLineup };
    if (lineup?.tray) lineup.tray = lineup.tray.map((p) => p.name);   // Piece はそのまま送れないので名前だけ
    return { names: tray.map((p) => p.name), planTray: g.planTray, lastLineup: lineup };
  }

  /** 学習モードのおすすめの総当たり（advisor.bestMove そのまま）。names = トレイの形の名前（使った枠は null） */
  hint(cells, names) {
    return bestMove(boardOf(cells), names.map((n) => n && new Piece(n)));
  }
}

function boardOf(cells) {
  const board = new Board();
  for (const i of cells) board.set(i % SIZE, Math.floor(i / SIZE), FILLED);
  return board;
}

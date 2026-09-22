import { Board } from './board.js';

/**
 * 列N（列番号）の発動を1move ずつ進めるジェネレータ。
 *  - 列Nの N個すべてを取り出す（= 盤面から抜ける）
 *  - 1個目 -> 列N-1, 2個目 -> 列N-2, …, 最後の1個 -> ゴール
 *  - 配られたブロックは対象列の「下から」入り、既存を押し上げる
 * 各 yield 時点で盤面はその move ぶんだけ進んでいる。
 */
export function* columnMoves(board, columnNumber) {
  const blocks = board.takeAll(columnNumber - 1);
  yield { type: 'suck', column: columnNumber, blocks };
  for (let k = 0; k < blocks.length; k++) {
    const targetNumber = columnNumber - 1 - k; // 0 ならゴール
    const block = blocks[k];
    if (targetNumber === 0) {
      yield { type: 'goal', block, from: columnNumber, to: 'goal' };
    } else {
      board.insertBottom(targetNumber - 1, block);
      yield { type: 'deal', block, from: columnNumber, to: targetNumber };
    }
  }
}

/** 列を最後まで発動（同期）。戻り値はアニメーション用の move リスト。 */
export function resolveColumn(board, columnNumber) {
  const moves = [];
  for (const ev of columnMoves(board, columnNumber)) {
    if (ev.type !== 'suck') moves.push({ block: ev.block, from: ev.from, to: ev.to });
  }
  return { column: columnNumber, moves, goalCount: 1 };
}

/**
 * 連鎖解決（仕様 12）。
 * while(true) { 完全一致列を全部探す -> 最小番号を1つだけ発動 -> 盤面再判定 }
 */
export function resolveChains(board, onStep) {
  const steps = [];
  for (;;) {
    const candidates = board.findExactColumns();
    if (candidates.length === 0) break;
    const column = Math.min(...candidates);
    const step = resolveColumn(board, column);
    step.chain = steps.length + 1;
    steps.push(step);
    if (onStep) onStep(step);
    if (steps.length > 2000) break; // 安全弁
  }
  return steps;
}

export { Board };

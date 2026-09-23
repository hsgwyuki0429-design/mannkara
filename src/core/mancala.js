import { Board } from './board.js';

/**
 * 列N（列番号）の発動を1move ずつ進めるジェネレータ。
 *  - 列Nの N個すべてを取り出す
 *  - 上のブロックから順に 列N-1, 列N-2, …, 列1 へ1個ずつ、最後の1個（一番下）はゴールへ
 *  - 配られたブロックは対象列の「下から」入り、一番下の空欄までを押し上げる
 * 最小番号優先で処理しているので、配布先(列N-1…1)は必ず空欄を持つ。
 * 念のため空欄が無い列へ来た場合はゴールへ流す（overflow）。
 */
export function* columnMoves(board, columnNumber) {
  const stack = board.takeColumn(columnNumber - 1); // 下から順
  yield { type: 'take', column: columnNumber, blocks: stack };
  const deal = [...stack].reverse();
  for (let k = 0; k < deal.length; k++) {
    const target = columnNumber - 1 - k; // 0 ならゴール
    const block = deal[k];
    if (target > 0 && board.insertBottom(target - 1, block)) {
      yield { type: 'deal', block, from: columnNumber, to: target };
    } else {
      yield { type: 'goal', block, from: columnNumber, to: 'goal', overflow: target > 0 };
    }
  }
}

/** 列を最後まで発動（同期） */
export function resolveColumn(board, columnNumber) {
  const step = { type: 'column', column: columnNumber, moves: [], stack: [], goals: 0 };
  for (const ev of columnMoves(board, columnNumber)) {
    if (ev.type === 'take') { step.stack = ev.blocks; continue; }
    step.moves.push({ block: ev.block, from: ev.from, to: ev.to });
    if (ev.to === 'goal') step.goals++;
  }
  return step;
}

/** 満杯の横ラインを同時に消す。消えたブロックはすべてゴールへ */
export function resolveRows(board, rows) {
  const removed = [];
  for (const r of rows) removed.push(...board.clearRow(r));
  return { type: 'rows', rows, removed, goals: removed.length };
}

/**
 * 次に起きる発動を1つ決める（ルールの優先順位はここだけで決まる）。
 *   1. 満杯の横ラインがあれば、それを全部同時に消す
 *   2. なければ満杯の列のうち、列番号が最小の1列を発動
 */
export function nextActivation(board) {
  const rows = board.fullRows();
  if (rows.length) return { type: 'rows', rows };
  const cols = board.fullColumns();
  if (cols.length) return { type: 'column', column: Math.min(...cols) };
  return null;
}

export function applyActivation(board, act) {
  return act.type === 'rows' ? resolveRows(board, act.rows) : resolveColumn(board, act.column);
}

/** 連鎖解決（同期）。1発動ごとに盤面全体を再判定する */
export function resolveChains(board, onStep) {
  const steps = [];
  for (let act; (act = nextActivation(board)); ) {
    const step = applyActivation(board, act);
    step.chain = steps.length + 1;
    steps.push(step);
    onStep?.(step);
    if (steps.length > 2000) break; // 安全弁
  }
  return steps;
}

export { Board };

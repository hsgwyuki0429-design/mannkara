import { Board } from './board.js?v=202609230215';
import { KIND_PRIORITY } from './constants.js?v=202609230215';

/**
 * ライン(kind, n) の発動を1move ずつ進めるジェネレータ。縦列・横列で完全に同じ処理。
 *  - n 個すべてを取り出す
 *  - 奥（斜辺から遠い側）のブロックから順に 同じ種類の n-1, n-2, …, 1 番ラインへ1個ずつ、
 *    最後の1個（斜辺側の端）はゴールへ
 *  - 配られたブロックは斜辺側の端から入り、一番近い空欄までを押し込む
 */
export function* lineMoves(board, kind, n) {
  const stack = board.takeLine(kind, n);
  yield { type: 'take', kind, n, blocks: stack };
  const deal = [...stack].reverse();
  for (let k = 0; k < deal.length; k++) {
    const target = n - 1 - k;
    const block = deal[k];
    if (target > 0 && board.insertBottom(kind, target, block)) {
      yield { type: 'deal', block, to: target };
    } else {
      yield { type: 'goal', block, to: 'goal', overflow: target > 0 };
    }
  }
}

export function resolveLine(board, kind, n) {
  const step = { kind, n, stack: [], moves: [], goals: 0 };
  for (const ev of lineMoves(board, kind, n)) {
    if (ev.type === 'take') { step.stack = ev.blocks; continue; }
    step.moves.push({ block: ev.block, to: ev.to });
    if (ev.to === 'goal') step.goals++;
  }
  return step;
}
/** 互換：縦列だけを発動 */
export const resolveColumn = (board, n) => resolveLine(board, 'col', n);

/**
 * 次に発動するラインを1つ決める（優先順位はここだけで決まる）。
 * 満杯のライン（縦・横）のうち番号が最小のもの。同じ番号なら縦列が先。
 */
export function nextActivation(board) {
  const lines = board.fullLines();
  if (!lines.length) return null;
  lines.sort((a, b) => a.n - b.n || KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind]);
  return lines[0];
}

/** 連鎖解決（同期）。1発動ごとに盤面全体を再判定する */
export function resolveChains(board, onStep) {
  const steps = [];
  for (let act; (act = nextActivation(board)); ) {
    const step = resolveLine(board, act.kind, act.n);
    step.chain = steps.length + 1;
    steps.push(step);
    onStep?.(step);
    if (steps.length > 2000) break;
  }
  return steps;
}

export { Board };

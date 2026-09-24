import { Board } from './board.js?v=202609240125';
import { KIND_PRIORITY } from './constants.js?v=202609240125';

/**
 * ライン(kind, n) の発動を1move ずつ進めるジェネレータ。縦列・横列で完全に同じ処理。
 *  - n 個すべてを取り出す
 *  - 奥（斜辺から遠い側）のブロックから順に 同じ種類の n-1, n-2, …, 1 番ラインへ1個ずつ、
 *    最後の1個（斜辺側の端）はゴールへ
 *  - 配られたブロックは斜辺側の端から入り、ブロックか壁に当たる手前まで奥へ進む
 *    （配布先が満杯より1個少ないときだけ、手前のブロックを奥へ詰めて空欄を埋める。Board.insertBottom）
 *  - 配布先に入れない（満杯、または手前の端が埋まっている）なら、そのブロックはゴールへ流れる
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
 *  - 同じ向きの中では番号が最小のライン
 *  - 縦と横の両方に満杯のラインがある時は、それぞれの最小ラインから始めた場合の連鎖数を
 *    シミュレーションし、連鎖が大きくなる向きを選ぶ（同じなら縦）
 */
export function nextActivation(board) {
  return decide(board).act;
}

/** nextActivation の詳細版。{ act, tie } tie = 縦横で連鎖数が同じだったか */
export function decide(board) {
  const lines = board.fullLines();
  if (!lines.length) return { act: null, tie: false };
  const minOf = (kind) => {
    const ns = lines.filter((l) => l.kind === kind).map((l) => l.n);
    return ns.length ? { kind, n: Math.min(...ns) } : null;
  };
  const col = minOf('col'), row = minOf('row');
  if (!col || !row) return { act: col ?? row, tie: false };
  const lenCol = chainFrom(board, col), lenRow = chainFrom(board, row);
  if (lenRow > lenCol) return { act: row, tie: false };
  return { act: col, tie: lenRow === lenCol };
}

/* 連鎖数シミュレーション（盤面ごとにメモ化） */
const memo = new Map();
const keyOf = (board) => board.grid.map((row) => row.map((v) => (v ? 1 : 0)).join('')).join('');
/** act を発動してから連鎖が終わるまでの発動回数（act 自身を含む） */
function chainFrom(board, act) {
  const b = board.clone();
  resolveLine(b, act.kind, act.n);
  return 1 + chainLength(b);
}
/** この盤面から始まる連鎖の発動回数 */
export function chainLength(board) {
  const key = keyOf(board);
  const hit = memo.get(key);
  if (hit !== undefined) return hit;
  let n = 0;
  const b = board.clone();
  for (let act; (act = nextActivation(b)); ) {
    resolveLine(b, act.kind, act.n);
    if (++n > 2000) break;
  }
  if (memo.size > 50000) memo.clear();
  memo.set(key, n);
  return n;
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

import { Board } from './board.js?v=202610091500';
import * as Sim from './sim.js?v=202610091500';

/**
 * ライン(kind, n) の発動を1move ずつ進めるジェネレータ。縦列・横列で完全に同じ処理。
 *  - n 個すべてを取り出す
 *  - 奥（斜辺から遠い側）のブロックから順に 同じ種類の n-1, n-2, …, 1 番ラインへ1個ずつ、
 *    最後の1個（斜辺側の端）はゴールへ
 *  - 配られたブロックは斜辺側の端から入り、ブロックか壁に当たる手前まで奥へ進む
 *    （配布先の手前の端が埋まっているときは、手前のブロックを奥へ詰めて空欄を埋める。Board.insertBottom）
 *  - 配布先が満杯なら、そのブロックはゴールへ流れる
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
 * 次に発動するラインを1つ決める（優先順位は sim.js の nextActivation だけで決まる）。
 *  - 同じ向きの中では番号が最小のライン
 *  - 縦と横の両方に満杯のラインがある時は、それぞれの最小ラインから始めた場合を最後までシミュレーションして
 *     1. 残りの手駒（rest: 形のセル配列の配列。まだトレイにあるピース）で詰まない向き
 *        （全部置ける > どれか1つは置ける > 1つも置けない）
 *     2. 連鎖が長くなる向き
 *     3. それでも同じなら縦
 */
export function nextActivation(board, rest = []) {
  return decide(board, rest).act;
}

/** nextActivation の詳細版。{ act, tie } tie = 縦横で詰み具合も連鎖数も同じだったか */
export function decide(board, rest = []) {
  const lines = board.fullLines();
  if (!lines.length) return { act: null, tie: false };
  const d = Sim.decide(Sim.fromBoard(board), Sim.restOf(rest));
  return { act: { kind: d.kind, n: d.n }, tie: d.tie };
}

/* 連鎖数シミュレーション（盤面ごとにメモ化）。decide は sim.js の同じ計算を使う（こちらは互換のために残す） */
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

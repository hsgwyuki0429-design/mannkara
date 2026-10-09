// 対戦のルール（core/battle.js）の数値を調整するための、CPU 同士の対戦のシミュレーション（画面なし・時間は仮想）。
// 2 人とも学習モードのおすすめ（advisor.bestMove）で置き、連鎖の再生が終わってから think ms ほど考えて 1 手。
// 手駒は 2 人とも同じ種から同じ順番で出る。連鎖の再生時間は画面と同じ見積もり（playDuration を 3 倍速）。
// 使い方: node scripts/sim-battle.mjs [n=4] [think=2500] [miss=0] [budget=25] [offset=0]
//   miss = でたらめな場所に置く割合 / offset=1 = 予告のおじゃまも連鎖で削る（ぷよぷよの相殺）
// 出力: 1 戦ごとの長さ・負けた理由、連鎖の数の分布、送ったおじゃまの数字の分布
import { Game } from '../src/core/game.js';
import { bestMove } from '../src/core/advisor.js';
import * as B from '../src/core/battle.js';

const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
const args = Object.fromEntries(process.argv.slice(2).map((a) => a.split('=')));
const N = Number(args.n || 4), THINK = Number(args.think || 2500), BUDGET = Number(args.budget || 25), MISS = Number(args.miss || 0);
const MAXT = Number(args.maxt || 900000);
const SPEED = 3;                                   // 対戦の連鎖の再生の速さ（main.js の BATTLE_SPEED）

function battle(seed) {
  let t = 0;
  const pieceSeed = seed * 7919 + 17;          // 2 人とも同じ種 = 同じ順番の手駒（使った枠にすぐ補充）
  const sides = [0, 1].map((i) => {
    const random = rng(seed * 7 + i * 13 + 1);
    const game = new Game({ random, battle: { rates: { tight: B.BATTLE_TIGHT_RATE, allClear: B.BATTLE_ALL_CLEAR_RATE }, seed: pieceSeed } });
    const st = { i, game, random, busyUntil: 0, nextAt: 500 + i * 300, chains: {}, turns: 0, attacks: [], maxGarbage: 0, cause: null };
    st.side = new B.BattleSide({ game, now: () => t, random, idPrefix: 'p' + i, offsetPending: args.offset === '1', busy: () => t < st.busyUntil, hooks: {
      send: (a) => { st.attacks.push(a.n); sides[1 - i].side.receive(a); },
    } });
    return st;
  });
  const lose = (st, cause) => { st.cause = cause; return { t, loser: st.i, sides }; };
  while (t < MAXT) {
    for (const st of sides) {
      const g = st.game;
      const dr = st.side.tick();
      if (dr) st.busyUntil = Math.max(st.busyUntil, t) + B.dropPlayMs(dr.landed.length) / SPEED;   // おじゃまの落ちる動き（main.js の enqueueDrop と同じ見積もり。3 倍速）
      st.maxGarbage = Math.max(st.maxGarbage, g.board.garbage().length);
      if (dr && g.gameOver) return lose(st, `おじゃまが落ちて置けなくなった（盤面 ${g.board.totalBlocks()} 個・おじゃま ${g.board.garbage().length} 個）`);
      if (t < st.nextAt || t < st.busyUntil) continue;          // 連鎖（とおじゃまの落ちる動き）の再生が終わるまで置けない
      let m = bestMove(g.board, g.tray, { budgetMs: BUDGET });
      if (m && st.random() < MISS) {
        const opts = [];
        g.tray.forEach((p, slot) => { if (p) for (let oy = 0; oy < 8; oy++) for (let ox = 0; ox < 8; ox++) if (g.board.canPlace(p, ox, oy)) opts.push({ slot, ox, oy }); });
        m = opts[Math.floor(st.random() * opts.length)] || m;
      }
      if (!m) return lose(st, '置ける手が無い');
      const turn = g.placePiece(m.slot, m.ox, m.oy);
      st.turns++;
      st.chains[turn.steps.length] = (st.chains[turn.steps.length] || 0) + 1;
      const dur = B.playDuration(turn.steps) / SPEED;
      const readyIn = Math.max(0, st.busyUntil - t) + dur;
      st.busyUntil = Math.max(st.busyUntil, t) + dur;
      st.side.placed(turn, readyIn);
      st.nextAt = t + THINK * (0.6 + st.random() * 0.8);
      if (g.gameOver) return lose(st, `置いたあと詰んだ（盤面 ${g.board.totalBlocks()} 個・おじゃま ${g.board.garbage().length} 個・手駒 ${g.tray.map((p) => p?.type).join(",")}）`);
    }
    t += 50;
  }
  return { t, loser: -1, sides };
}

const durs = [], chains = {}, attacks = {};
for (let s = 1; s <= N; s++) {
  const r = battle(s);
  durs.push(Math.round(r.t / 1000));
  for (const st of r.sides) {
    for (const [k, v] of Object.entries(st.chains)) chains[k] = (chains[k] || 0) + v;
    for (const a of st.attacks) attacks[a] = (attacks[a] || 0) + 1;
  }
  const L = r.sides[r.loser];
  console.log(`${s}: ${Math.round(r.t / 1000)}秒  ${r.loser < 0 ? '決着せず' : `負け=${r.loser}  ${L.cause}`}  手数=${r.sides.map((x) => x.turns)}  盤面のおじゃまの最大=${r.sides.map((x) => x.maxGarbage)}`);
}
durs.sort((a, b) => a - b);
console.log('長さ（秒）', durs.join(' '), ' まん中', durs[Math.floor(durs.length / 2)]);
const total = Object.values(chains).reduce((a, b) => a + b, 0);
console.log('連鎖の数', Object.entries(chains).map(([k, v]) => `${k}:${(100 * v / total).toFixed(1)}%`).join(' '));
console.log('送ったおじゃまの数字', Object.entries(attacks).map(([k, v]) => `${k}:${v}`).join(' '));

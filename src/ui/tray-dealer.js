import { DealerCore } from '../core/dealer.js?v=202609261436';

/**
 * 手駒の決め方（と学習モードのおすすめの総当たり）を Web Worker（core/dealer-worker.js）で動かすための窓口。
 * Game の dealer に渡す。
 * 手駒を決める探索は時間で打ち切る作りで、1回に 100ms 近くかかることがある。メインスレッドで動かすと、
 * その間は置いたピースの表示も連鎖の再生も止まって見えるので、別スレッドへ出す（決め方と時間の上限は同じ）。
 *
 * Worker が使えない・読み込めない・答えが返ってこない場合は、同じ処理（DealerCore）をこのスレッドで行う。
 */
const WATCHDOG_MS = 6000;

export class TrayDealer {
  constructor(workerUrl) {
    this.nextId = 1;
    this.waiting = new Map();     // id -> { msg, resolve }
    try {
      this.worker = new Worker(workerUrl, { type: 'module' });
      this.worker.onmessage = (e) => this.onMessage(e.data);
      this.worker.onerror = (e) => { e.preventDefault?.(); this.fallback(); };
      this.worker.onmessageerror = () => this.fallback();
    } catch {
      this.worker = null;
    }
    if (!this.worker) this.local = new DealerCore(Math.random);
  }

  reset() {
    if (this.local) this.local.reset();
    else this.worker.postMessage({ type: 'reset' });
  }

  /** 手駒を決める（cells = 埋まっているマスの番号）→ { names, planTray, lastLineup } */
  deal(cells) { return this.ask({ type: 'deal', cells }); }
  /** 学習モードのおすすめの手（names = トレイの形の名前、使った枠は null）→ { slot, ox, oy, survive } | null */
  hint(cells, names) { return this.ask({ type: 'hint', cells, names }); }

  ask(msg) {
    return new Promise((resolve) => {
      const id = this.nextId++;
      const req = { id, msg, resolve };
      if (this.local) { this.runLocal(req); return; }
      this.waiting.set(id, req);
      this.worker.postMessage({ ...msg, id });
      this.arm();
    });
  }

  onMessage({ id, result, error }) {
    const req = this.waiting.get(id);
    if (!req) return;
    if (error) { console.error(error); this.fallback(); return; }
    this.waiting.delete(id);
    this.arm();
    req.resolve(result);
  }

  /** 答えが返ってこないまま長く待たされたら、このスレッドで決める */
  arm() {
    clearTimeout(this.timer);
    if (this.waiting.size) this.timer = setTimeout(() => this.fallback(), WATCHDOG_MS);
  }

  /** Worker をやめて、このスレッドで決める（まだ答えをもらっていない依頼も、こちらで決める） */
  fallback() {
    if (this.local) return;
    clearTimeout(this.timer);
    try { this.worker.terminate(); } catch {}
    this.worker = null;
    this.local = new DealerCore(Math.random);
    const pending = [...this.waiting.values()];
    this.waiting.clear();
    for (const req of pending) this.runLocal(req);
  }

  runLocal(req) {
    // その場で決めると、依頼した側（置いた直後の処理）の途中で答えが返ってしまうので、次のタスクで
    const { type, cells, names } = req.msg;
    setTimeout(() => req.resolve(type === 'deal' ? this.local.deal(cells) : this.local.hint(cells, names)), 0);
  }
}

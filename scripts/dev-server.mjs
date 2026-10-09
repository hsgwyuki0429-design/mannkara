// 手元で遊ぶ・確かめるためのサーバー: 静的ファイルと、functions/api/*.js（世界ランキング・オンライン対戦）を動かす。
// D1 の代わりに node:sqlite（メモリの中。止めると消える）を使う。
// 使い方: node scripts/dev-server.mjs [port]   → http://localhost:8787/
//         （同じ Wi-Fi のスマホから開くときは http://<この PC の IP>:8787/ 。オンライン対戦は 2 つのタブ・端末で試せる）
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const PORT = Number(process.argv[2] || process.env.PORT || 8787);
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.txt': 'text/plain' };

const raw = new DatabaseSync(':memory:');
/** D1 と同じ形（prepare → bind → run / all / first） */
const DB = {
  prepare(sql) {
    let args = [];
    const st = {
      bind: (...a) => { args = a.map((v) => (v === undefined ? null : v)); return st; },
      run: async () => raw.prepare(sql).run(...args),
      all: async () => ({ results: raw.prepare(sql).all(...args) }),
      first: async () => raw.prepare(sql).get(...args) ?? null,
    };
    return st;
  },
};
const env = { DB, ADMIN_KEY: process.env.ADMIN_KEY };
const routes = {};
for (const name of ['ranking', 'battle', 'admin']) routes['/api/' + name] = await import(join(ROOT, 'functions/api', name + '.js'));

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    const route = routes[url.pathname];
    if (route) {
      const body = req.method === 'GET' || req.method === 'HEAD' ? undefined : await new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
      const request = new Request(url, { method: req.method, headers: req.headers, body });
      const fn = route[`onRequest${req.method[0]}${req.method.slice(1).toLowerCase()}`];
      const out = fn ? await fn({ request, env }) : new Response('method', { status: 405 });
      res.writeHead(out.status, Object.fromEntries(out.headers));
      res.end(Buffer.from(await out.arrayBuffer()));
      return;
    }
    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path.endsWith('/')) path += 'index.html';
    const file = join(ROOT, path);
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) { res.writeHead(404).end('not found'); return; }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(await readFile(file));
  } catch (e) {
    console.error(e);
    res.writeHead(500).end(String(e));
  }
});
server.listen(PORT, () => console.log(`http://localhost:${PORT}/`));

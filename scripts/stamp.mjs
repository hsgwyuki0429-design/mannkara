// キャッシュ対策：index.html と src/ 以下の相対 import に ?v=<version> を付け直す。
// 使い方: node scripts/stamp.mjs [version]   （省略時は日時）
// ブラウザが古い CSS/JS と新しいファイルを混ぜて読むのを防ぐ。
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const version = process.argv[2] || new Date().toISOString().replace(/\D/g, '').slice(0, 12);
const files = ['index.html'];
(function walk(dir) {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p);
    else if (p.endsWith('.js')) files.push(p);
  }
})('src');
(function walkTest() { for (const f of readdirSync('test')) if (f.endsWith('.mjs')) files.push(join('test', f)); })();

// 相対パスの .js / .css 参照（'./x.js', "../core/x.js?v=old" など）
const re = /(["'])(\.{1,2}\/[^"'?]+\.(?:js|css))(?:\?v=[^"']*)?\1/g;
let changed = 0;
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  const out = src.replace(re, (_, q, path) => `${q}${path}?v=${version}${q}`);
  if (out !== src) { writeFileSync(f, out); changed++; }
}
console.log(`stamped v=${version} in ${changed} files`);

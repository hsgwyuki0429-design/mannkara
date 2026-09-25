/** 7色（ブロックと同じ色） */
export const RAINBOW = ['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple'];

const cache = new Map();
/** 色名（red など）→ styles.css の .c-<色> に書かれた色 { col, hi, lo, rim } */
export function colorOf(name) {
  let c = cache.get(name);
  if (!c) {
    const probe = document.createElement('div');
    probe.className = `c-${name}`;
    probe.style.display = 'none';
    document.body.appendChild(probe);
    const cs = getComputedStyle(probe);
    const v = (k, d) => cs.getPropertyValue(k).trim() || d;
    c = { col: v('--col', '#fff'), hi: v('--hi', '#fff'), lo: v('--lo', '#888'), rim: v('--rim', '#fff') };
    probe.remove();
    cache.set(name, c);
  }
  return c;
}

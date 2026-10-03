/** Rounded, seamless polyomino glass. Coordinates are in cells; SVG uses 100 units per cell. */
export const GLASS_COLORS = {
  red: '#f0a1b6', orange: '#e3d96b', yellow: '#d4ce68', green: '#6fd98a',
  cyan: '#73d88b', blue: '#9eaff3', purple: '#ad94ff', debug: '#ad94ff',
};
const GLASS_RIMS = { green: '#b8f8dd', cyan: '#b8f8df', yellow: '#fff2cb', orange: '#ffeed0', purple: '#e0c2ff' };
export const GLASS_BACKGROUND = '#5c43c2';
export const GLASS_HIGHLIGHT = '#6a50cf';
const key = (x, y) => `${x},${y}`;
const neighbors = [[1, 0], [0, 1], [-1, 0], [0, -1]];

/** Edge-adjacent cells of the same color form one piece. Diagonal contacts stay separate. */
export function glassGroups(cells) {
  const left = new Map(cells.map((c) => [key(c.x, c.y), c])), groups = [];
  while (left.size) {
    const first = left.values().next().value, group = [first];
    left.delete(key(first.x, first.y));
    for (let i = 0; i < group.length; i++) for (const [dx, dy] of neighbors) {
      const k = key(group[i].x + dx, group[i].y + dy), next = left.get(k);
      if (next && next.color === first.color) { left.delete(k); group.push(next); }
    }
    groups.push(group);
  }
  return groups;
}

/** Trace only exposed edges, keeping holes and disconnected islands as separate loops. */
export function outlineLoops(cells) {
  const occupied = new Set(cells.map((c) => key(c.x, c.y))), edges = new Map();
  const add = (x, y, dx, dy, dir) => {
    const k = key(x, y), edge = { x, y, dx, dy, dir };
    if (!edges.has(k)) edges.set(k, []);
    edges.get(k).push(edge);
  };
  for (const k of occupied) {
    const [x, y] = k.split(',').map(Number);
    if (!occupied.has(key(x, y - 1))) add(x, y, 1, 0, 0);
    if (!occupied.has(key(x + 1, y))) add(x + 1, y, 0, 1, 1);
    if (!occupied.has(key(x, y + 1))) add(x + 1, y + 1, -1, 0, 2);
    if (!occupied.has(key(x - 1, y))) add(x, y + 1, 0, -1, 3);
  }
  const loops = [];
  while (edges.size) {
    let edge = edges.values().next().value[0];
    const start = key(edge.x, edge.y), loop = [];
    do {
      loop.push({ x: edge.x, y: edge.y });
      const k = key(edge.x, edge.y), list = edges.get(k);
      list.splice(list.indexOf(edge), 1);
      if (!list.length) edges.delete(k);
      const end = key(edge.x + edge.dx, edge.y + edge.dy);
      if (end === start) break;
      // Prefer a right turn at diagonal contacts rather than crossing into another loop.
      const options = edges.get(end);
      edge = [1, 0, 3, 2].flatMap((turn) => options.filter((e) => (e.dir - edge.dir + 4) % 4 === turn))[0];
    } while (edge);
    loops.push(loop.filter((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
      return (p.x - a.x) * (b.y - p.y) !== (p.y - a.y) * (b.x - p.x);
    }));
  }
  return loops;
}

const num = (n) => Number(n.toFixed(3));
const point = (p) => `${num(p.x * 100)} ${num(p.y * 100)}`;
/** Inset the exterior (and expand holes), then round convex and concave corners alike. */
export function glassPath(cells, inset = 0.028, radius = 0.13) {
  return outlineLoops(cells).map((loop) => {
    const vertices = loop.map((p, i) => {
      const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
      const ax = Math.sign(p.x - a.x), ay = Math.sign(p.y - a.y), bx = Math.sign(b.x - p.x), by = Math.sign(b.y - p.y);
      return { x: p.x - (ay + by) * inset, y: p.y + (ax + bx) * inset };
    });
    const corners = vertices.map((p, i) => {
      const a = vertices[(i + vertices.length - 1) % vertices.length], b = vertices[(i + 1) % vertices.length];
      const ra = Math.min(radius, Math.hypot(p.x - a.x, p.y - a.y) / 2), rb = Math.min(radius, Math.hypot(b.x - p.x, b.y - p.y) / 2);
      return { p, a: { x: p.x + Math.sign(a.x - p.x) * ra, y: p.y + Math.sign(a.y - p.y) * ra },
        b: { x: p.x + Math.sign(b.x - p.x) * rb, y: p.y + Math.sign(b.y - p.y) * rb } };
    });
    return `M${point(corners[0].a)} ` + corners.map(({ p, a, b }) => `L${point(a)} Q${point(p)} ${point(b)}`).join(' ') + ' Z';
  }).join(' ');
}

let serial = 0;
/** A whole piece is one surface, so neighboring cells never acquire internal rims. */
export function glassElement(cells, color, cellSize, { plate = false } = {}) {
  const minX = Math.min(...cells.map((c) => c.x)), minY = Math.min(...cells.map((c) => c.y));
  const width = Math.max(...cells.map((c) => c.x)) - minX + 1, height = Math.max(...cells.map((c) => c.y)) - minY + 1;
  const path = glassPath(cells.map((c) => ({ x: c.x - minX, y: c.y - minY })), plate ? 0.003 : 0.028, plate ? 0.16 : 0.13);
  const id = `glass-${++serial}`, tint = plate ? '#b4aff8' : (GLASS_COLORS[color] || GLASS_COLORS.purple);
  const rim = plate ? '#e2cfff' : (GLASS_RIMS[color] || '#e0d7ff');
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', `0 0 ${width * 100} ${height * 100}`);
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('glass-surface');
  if (plate) el.classList.add('glass-plate');
  Object.assign(el.style, { left: minX * cellSize + 'px', top: minY * cellSize + 'px', width: width * cellSize + 'px', height: height * cellSize + 'px' });
  el.innerHTML = `<defs>
    <linearGradient id="${id}-fill" x1="1" y1="1" x2="0" y2="0">
      <stop stop-color="${tint}" stop-opacity="${plate ? '.12' : '.70'}"/>
      <stop offset=".48" stop-color="${tint}" stop-opacity="${plate ? '.025' : '.48'}"/>
      <stop offset="1" stop-color="${tint}" stop-opacity="${plate ? '.07' : '.64'}"/>
    </linearGradient>
    <linearGradient id="${id}-rim" x1="1" y1="1" x2="0" y2="0">
      <stop stop-color="#fff9ed" stop-opacity=".96"/><stop offset=".55" stop-color="${rim}" stop-opacity=".8"/><stop offset="1" stop-color="#f8eaff" stop-opacity=".9"/>
    </linearGradient>
    <filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3.8"/></filter>
    <clipPath id="${id}-clip"><path d="${path}" fill-rule="evenodd"/></clipPath>
  </defs>
  <path d="${path}" fill="url(#${id}-fill)" fill-rule="evenodd"/>
  <path d="${path}" fill="none" stroke="${rim}" stroke-width="5" opacity=".38" filter="url(#${id}-soft)"/>
  <g clip-path="url(#${id}-clip)">
    <path d="${path}" fill="none" stroke="${rim}" stroke-width="${plate ? 22 : 18}" opacity="${plate ? '.28' : '.44'}" filter="url(#${id}-soft)"/>
    <path d="${path}" fill="none" stroke="#fff9f5" stroke-width="5" opacity=".26" filter="url(#${id}-soft)"/>
  </g>
  <path d="${path}" fill="none" stroke="url(#${id}-rim)" stroke-width="${plate ? 1.8 : 2.2}"/>`;
  return el;
}

/** Rounded, seamless polyomino glass. Coordinates are in cells; SVG uses 100 units per cell. */
export const GLASS_COLORS = {
  red: '#f0a1b6', orange: '#d5c260', yellow: '#c6b761', green: '#64c185',
  cyan: '#61ba7e', blue: '#9eaff3', purple: '#a88cff', debug: '#a88cff',
};
const GLASS_RIMS = { green: '#b8f8dd', cyan: '#b8f8df', yellow: '#fff2cb', orange: '#ffeed0', purple: '#efd8ff' };
export const GLASS_BACKGROUND = '#5e4ac2';
export const GLASS_HIGHLIGHT = '#6953ca';
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
  const local = cells.map((c) => ({ x: c.x - minX, y: c.y - minY }));
  const inset = plate ? 0.003 : 0.028, radius = plate ? 0.16 : 0.13;
  const path = glassPath(local, inset, radius);
  const id = `glass-${++serial}`, tint = plate ? '#b4aff8' : (GLASS_COLORS[color] || GLASS_COLORS.purple);
  const rim = plate ? '#edddff' : (GLASS_RIMS[color] || '#e0d7ff');
  // Only the convex tips facing up on screen catch the small, sharp white reflection.
  const tips = outlineLoops(local).flatMap((loop) => loop.filter((p, i) => {
    const a = loop[(i + loop.length - 1) % loop.length], b = loop[(i + 1) % loop.length];
    return p.y > a.y && b.x < p.x;
  })).map((p) => `M${point({ x: p.x - inset, y: p.y - inset - radius })} Q${point({ x: p.x - inset, y: p.y - inset })} ${point({ x: p.x - inset - radius, y: p.y - inset })}`).join(' ');
  const el = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  el.setAttribute('viewBox', `0 0 ${width * 100} ${height * 100}`);
  el.setAttribute('aria-hidden', 'true');
  el.classList.add('glass-surface');
  if (plate) el.classList.add('glass-plate');
  Object.assign(el.style, { left: minX * cellSize + 'px', top: minY * cellSize + 'px', width: width * cellSize + 'px', height: height * cellSize + 'px' });
  // The reference has a fine bright rim, a colored inner glow strongest along the lower
  // edges, and isolated white reflections. Keep these separate instead of frosting the face.
  el.innerHTML = `<defs>
    <linearGradient id="${id}-fill" x1="1" y1="1" x2="0" y2="0">
      <stop stop-color="${tint}" stop-opacity="${plate ? '.10' : '.64'}"/>
      <stop offset=".48" stop-color="${tint}" stop-opacity="${plate ? '.035' : '.56'}"/>
      <stop offset="1" stop-color="${tint}" stop-opacity="${plate ? '.085' : '.65'}"/>
    </linearGradient>
    <linearGradient id="${id}-rim" x1="1" y1="1" x2="0" y2="0">
      <stop stop-color="#fffbed" stop-opacity=".94"/><stop offset=".35" stop-color="${rim}" stop-opacity=".88"/>
      <stop offset="1" stop-color="${rim}" stop-opacity="1"/>
    </linearGradient>
    <radialGradient id="${id}-reflection" cx=".82" cy=".72" r=".85">
      <stop stop-color="#fffbe8" stop-opacity="${plate ? '.035' : '.11'}"/>
      <stop offset=".45" stop-color="#e1fff9" stop-opacity=".025"/><stop offset="1" stop-color="#b9adf0" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="${id}-flash" cx=".56" cy="0" r=".15">
      <stop stop-color="#fffdf8" stop-opacity=".95"/><stop offset=".3" stop-color="#fffdf8" stop-opacity=".65"/><stop offset="1" stop-color="#fffdf8" stop-opacity="0"/>
    </radialGradient>
    <filter id="${id}-soft" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="3.5"/></filter>
    <filter id="${id}-broad" x="-30%" y="-30%" width="160%" height="160%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation="7"/></filter>
    <filter id="${id}-glint" x="-10%" y="-10%" width="120%" height="120%" color-interpolation-filters="sRGB"><feGaussianBlur stdDeviation=".45"/></filter>
    <clipPath id="${id}-clip"><path d="${path}" fill-rule="evenodd"/></clipPath>
  </defs>
  <path d="${path}" fill="url(#${id}-fill)" fill-rule="evenodd"/>
  <path d="${path}" fill="url(#${id}-reflection)" fill-rule="evenodd"/>
  <path d="${path}" fill="none" stroke="${rim}" stroke-width="3" opacity=".28" filter="url(#${id}-soft)"/>
  <g clip-path="url(#${id}-clip)">
    <path d="${path}" fill="none" stroke="${rim}" stroke-width="${plate ? 24 : 20}" opacity="${plate ? '.15' : '.16'}" filter="url(#${id}-broad)"/>
    <path d="${path}" fill="none" stroke="${rim}" stroke-width="${plate ? 20 : 13}" opacity="${plate ? '.36' : '.42'}" filter="url(#${id}-soft)"/>
    <path d="${path}" fill="none" stroke="${rim}" stroke-width="8" opacity="${plate ? '.32' : '.44'}" transform="translate(3 3)" filter="url(#${id}-soft)"/>
  </g>
  <path d="${path}" fill="none" stroke="url(#${id}-rim)" stroke-width="${plate ? 2.5 : 2.6}"/>
  <path d="${tips}" fill="none" stroke="#fffdf2" stroke-width="2.8" stroke-linecap="round" opacity="${plate ? '.5' : '.8'}" filter="url(#${id}-glint)"/>
  ${plate ? '' : `<path d="${path}" fill="none" stroke="url(#${id}-flash)" stroke-width="3.6" filter="url(#${id}-glint)"/>`}`;
  return el;
}

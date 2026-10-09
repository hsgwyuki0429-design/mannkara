import { SIZE, lineCells } from '../core/constants.js?v=202610090639';

/** 連鎖の残りでブロックが占める・通過するマスと、新しく置くマスが重なるか。 */
export function chainTouchesPlacement(steps, placed) {
  const cells = new Set(placed.map(({ x, r }) => r * SIZE + x));
  if (!cells.size) return false;
  const touches = (x, r) => cells.has(r * SIZE + x);
  for (const step of steps) {
    for (const { x, r } of lineCells(step.kind, step.n)) if (touches(x, r)) return true;
    for (const positions of [step.before, step.after]) {
      for (const { x, r } of positions.values()) if (touches(x, r)) return true;
    }
    // 通路から盤面へ入るブロックと、押されるブロックの通り道も含める。
    for (const [id, from] of step.before) {
      const to = step.after.get(id);
      if (!to || (from.x === to.x && from.r === to.r)) continue;
      if (from.x === to.x) {
        for (let r = Math.min(from.r, to.r); r <= Math.max(from.r, to.r); r++) if (touches(from.x, r)) return true;
      } else if (from.r === to.r) {
        for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) if (touches(x, from.r)) return true;
      }
    }
    for (const block of step.stack) {
      const to = step.after.get(block.id);
      if (!to) continue;
      if (step.kind === 'col') {
        for (let r = to.r; r < SIZE - to.x; r++) if (touches(to.x, r)) return true;
      } else {
        for (let x = to.x; x < SIZE - to.r; x++) if (touches(x, to.r)) return true;
      }
    }
  }
  return false;
}

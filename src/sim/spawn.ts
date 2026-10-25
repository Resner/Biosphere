import { plumesNear } from './hazards';
import { RULES } from './rules';
import type { Vec2, World } from './types';

const { searchStep, plumeClearance } = RULES.spawn;

/**
 * The point nearest to (x, y) that is clear of every toxic plume, found by walking square rings
 * outward; (x, y) itself when it is already clear.
 */
export function findClearSpot(world: World, x: number, y: number): Vec2 {
  const clear = (px: number, py: number): boolean =>
    px >= 0 &&
    py >= 0 &&
    px <= world.size &&
    py <= world.size &&
    plumesNear(world, px, py, plumeClearance).length === 0;
  if (clear(x, y)) return { x, y };
  // Walk each square ring's perimeter. A pond with no clear spot at all keeps the original point.
  const rings = Math.ceil(world.size / searchStep);
  for (let ring = 1; ring <= rings; ring++) {
    for (let i = -ring; i <= ring; i++) {
      const edge: [number, number][] = [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ];
      for (const [dx, dy] of edge) {
        const px = x + (dx as number) * searchStep;
        const py = y + (dy as number) * searchStep;
        if (clear(px, py)) return { x: px, y: py };
      }
    }
  }
  return { x, y };
}

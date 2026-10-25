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
  const rings = Math.ceil(world.size / searchStep);
  for (let ring = 1; ring <= rings; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
        const px = x + dx * searchStep;
        const py = y + dy * searchStep;
        if (clear(px, py)) return { x: px, y: py };
      }
    }
  }
  return { x, y };
}

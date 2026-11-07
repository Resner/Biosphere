import { plumesNear } from './hazards';
import { length } from './math';
import { RULES } from './rules';
import type { Vec2, World } from './types';

const { searchStep, searchRadius, plumeClearance, lookaheadTicks, lookaheadStride } = RULES.spawn;

/** The world as it will be at each lookahead stride, for `clearOfPlumes` (build once per search). */
export function plumeFutures(world: World): World[] {
  const future: World[] = [];
  for (let t = 0; t <= lookaheadTicks; t += lookaheadStride) {
    future.push({ ...world, tick: world.tick + t });
  }
  return future;
}

/**
 * Whether (x, y) is `plumeClearance` wu (plus `reach`) clear of every toxic plume now and for the
 * next 10 s of drift. `future` is `plumeFutures(world)`, which a search over many points builds once.
 */
export function clearOfPlumes(
  world: World,
  x: number,
  y: number,
  reach = 0,
  future: readonly World[] = plumeFutures(world),
): boolean {
  return future.every((w) => plumesNear(w, x, y, plumeClearance + reach).length === 0);
}

/**
 * The point nearest to (x, y), on the search lattice, that is clear of every toxic plume now and
 * for the next 10 s of drift; (x, y) itself when it is already clear. `reach` is how far the body's
 * farthest collider centre lies from the core (wu, `colliderReach`): the clearance is kept from
 * there. The search reaches `searchRadius` wu out; a world with no clear spot that near keeps the
 * original point.
 */
export function findClearSpot(world: World, x: number, y: number, reach = 0): Vec2 {
  const future = plumeFutures(world);
  const clear = (px: number, py: number): boolean =>
    px >= 0 &&
    py >= 0 &&
    px <= world.size &&
    py <= world.size &&
    clearOfPlumes(world, px, py, reach, future);
  if (clear(x, y)) return { x, y };
  // Walk square rings outward. A ring's points are at least ring * step away, so once a spot is
  // found only rings that could still hold a nearer one are scanned.
  const rings = Math.min(Math.ceil(world.size / searchStep), Math.floor(searchRadius / searchStep));
  let best: Vec2 | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let ring = 1; ring <= rings && ring * searchStep < bestDistance; ring++) {
    for (let i = -ring; i <= ring; i++) {
      const edge: [number, number][] = [
        [i, -ring],
        [i, ring],
        [-ring, i],
        [ring, i],
      ];
      for (const [dx, dy] of edge) {
        const distance = length(dx * searchStep, dy * searchStep);
        if (distance >= bestDistance) continue;
        const px = x + dx * searchStep;
        const py = y + dy * searchStep;
        if (clear(px, py)) {
          best = { x: px, y: py };
          bestDistance = distance;
        }
      }
    }
  }
  return best ?? { x, y };
}

import { describe, expect, it } from 'vitest';
import { depthAt } from '../src/sim/bathymetry';
import { plumesNear } from '../src/sim/hazards';
import { seedFromString } from '../src/sim/prng';
import { createWorld } from '../src/sim/world';
import { CALM_SEED, NEAR, STAGE } from './fight-test-kit';

describe('the calm pond seed', () => {
  // Hub tests stage fights at NEAR and, in the away tests, at `STAGE` and 900 wu south of it:
  // there the water must be too shallow for pressure, too deep for UV, and clear of plumes.
  const spots = [
    NEAR.a,
    NEAR.b,
    [STAGE.x, STAGE.y],
    [STAGE.x + 30, STAGE.y],
    [STAGE.x, STAGE.y + 900],
  ] as const;

  it('is mild water without a plume at every staging spot', () => {
    const world = createWorld({ seed: CALM_SEED });
    for (const [x, y] of spots) {
      const depth = depthAt(seedFromString(CALM_SEED), x, y, world.size);
      expect(depth, `depth at ${x},${y}`).toBeGreaterThan(0.3);
      expect(depth, `depth at ${x},${y}`).toBeLessThan(0.65);
      expect(plumesNear(world, x, y, 300), `plumes at ${x},${y}`).toEqual([]);
    }
  });
});

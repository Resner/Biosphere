import { describe, expect, it } from 'vitest';
import { plumesNear } from './hazards';
import { RULES } from './rules';
import { findClearSpot } from './spawn';
import { createWorld } from './world';

describe('findClearSpot', () => {
  it('keeps a point that is already clear', () => {
    const world = createWorld({ seed: 'clear', hazards: false });
    expect(findClearSpot(world, 1234, 4321)).toEqual({ x: 1234, y: 4321 });
  });

  it('moves a point out of a plume, close by', () => {
    const c = RULES.world.size / 2;
    let found = 0;
    for (let i = 0; i < 400 && found < 5; i++) {
      const world = createWorld({ seed: `spot-${i}` });
      if (plumesNear(world, c, c, 0).length === 0) continue;
      found++;
      const spot = findClearSpot(world, c, c);
      expect(plumesNear(world, spot.x, spot.y, RULES.spawn.plumeClearance)).toEqual([]);
      expect(Math.hypot(spot.x - c, spot.y - c)).toBeLessThan(
        2 * (RULES.hazards.plumeMaxRadius + RULES.spawn.plumeClearance) + 100,
      );
    }
    expect(found).toBeGreaterThan(0);
  });
});

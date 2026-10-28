import { describe, expect, it } from 'vitest';
import { zoneAt } from './bathymetry';
import { colliderReach, STARTER_PHYS } from './body';
import { plumesNear } from './hazards';
import { RULES } from './rules';
import { findClearSpot } from './spawn';
import { createWorld } from './world';

type TestWorld = ReturnType<typeof createWorld>;

/** The centre of the first plume of a world: a point that is certainly poisoned. */
const ventPoint = (world: TestWorld) => {
  const size = RULES.world.size;
  const plume = plumesNear(world, size / 2, size / 2, size)[0];
  if (plume === undefined) throw new Error('no plume');
  return { x: plume.x, y: plume.y };
};

describe('findClearSpot', () => {
  it('keeps a point that is already clear', () => {
    const world = createWorld({ seed: 'clear', hazards: false });
    expect(findClearSpot(world, 1234, 4321)).toEqual({ x: 1234, y: 4321 });
  });

  it('moves a point out of a plume, close by', () => {
    for (let i = 0; i < 5; i++) {
      const world = createWorld({ seed: `spot-${i}` });
      const at = ventPoint(world);
      const spot = findClearSpot(world, at.x, at.y);
      expect(plumesNear(world, spot.x, spot.y, RULES.spawn.plumeClearance)).toEqual([]);
      expect(Math.hypot(spot.x - at.x, spot.y - at.y)).toBeLessThan(
        2 * (RULES.hazards.plumeMaxRadius + RULES.spawn.plumeClearance) + 100,
      );
    }
  });
});

describe('findClearSpot, nearest and stable', () => {
  const { searchStep, plumeClearance } = RULES.spawn;
  const clearNow = (world: TestWorld, x: number, y: number) =>
    plumesNear(world, x, y, plumeClearance).length === 0;

  /** The nearest clear point of the search lattice around (x, y), by a full scan. */
  const bruteNearest = (world: ReturnType<typeof createWorld>, x: number, y: number) => {
    let best = Number.POSITIVE_INFINITY;
    const reach = 40;
    for (let i = -reach; i <= reach; i++) {
      for (let j = -reach; j <= reach; j++) {
        const px = x + i * searchStep;
        const py = y + j * searchStep;
        if (px < 0 || py < 0 || px > world.size || py > world.size) continue;
        if (!clearNow(world, px, py)) continue;
        best = Math.min(best, Math.hypot(i * searchStep, j * searchStep));
      }
    }
    return best;
  };

  const blockedWorlds = (count: number) => {
    const worlds: TestWorld[] = [];
    for (let i = 0; i < count; i++) worlds.push(createWorld({ seed: `near-${i}` }));
    return worlds;
  };

  it('returns the nearest clear point, not the first one in scan order', () => {
    const worlds = blockedWorlds(20);
    expect(worlds).toHaveLength(20);
    for (const world of worlds) {
      const at = ventPoint(world);
      // Judge by the instant a spot is chosen: the same worlds, at tick 0, with no drift check.
      const spot = findClearSpot(world, at.x, at.y);
      expect(clearNow(world, spot.x, spot.y)).toBe(true);
      const distance = Math.hypot(spot.x - at.x, spot.y - at.y);
      // Drift clearance can push the answer out, never closer than the instant-clear optimum.
      expect(distance).toBeGreaterThanOrEqual(bruteNearest(world, at.x, at.y) - 1e-9);
    }
  });

  it('matches the brute-force nearest when nothing drifts', () => {
    for (const world of blockedWorlds(20)) {
      const calm = { ...world, options: { ...world.options, currents: false } };
      const at = ventPoint(calm);
      const spot = findClearSpot(calm, at.x, at.y);
      expect(Math.hypot(spot.x - at.x, spot.y - at.y)).toBeCloseTo(
        bruteNearest(calm, at.x, at.y),
        6,
      );
    }
  });

  it('keeps its lookahead in the rules: 10 s, checked every second', () => {
    expect(RULES.spawn.lookaheadTicks).toBe(300);
    expect(RULES.spawn.lookaheadStride).toBe(30);
  });

  it('stays clear of every plume for the next 10 s of drift', () => {
    for (const world of blockedWorlds(20)) {
      const at = ventPoint(world);
      const spot = findClearSpot(world, at.x, at.y);
      const start = world.tick;
      for (let t = 0; t <= RULES.spawn.lookaheadTicks; t++) {
        world.tick = start + t;
        expect(plumesNear(world, spot.x, spot.y, plumeClearance)).toEqual([]);
      }
      world.tick = start;
    }
  });
});

describe('findClearSpot for a long body', () => {
  const { plumeClearance, lookaheadTicks, lookaheadStride } = RULES.spawn;
  // A body whose farthest collider centre is 2 radii out (edge at 2.5), at biomass 100 (radius 10).
  const reach = colliderReach(
    {
      ...STARTER_PHYS,
      colliders: [
        { x: 0, y: 0, r: 1 },
        { x: 2, y: 0, r: 0.5 },
      ],
    },
    100,
  );

  it('measures reach as the farthest collider centre in wu', () => {
    expect(reach).toBe(20);
    expect(colliderReach(STARTER_PHYS, 100)).toBe(0);
  });

  it('keeps the farthest collider centre clear of every plume for 10 s', () => {
    for (let i = 0; i < 20; i++) {
      const world = createWorld({ seed: `long-${i}` });
      const at = ventPoint(world);
      const spot = findClearSpot(world, at.x, at.y, reach);
      const start = world.tick;
      // 20 sample points on the circle the farthest collider centre can reach.
      for (let t = 0; t <= lookaheadTicks; t += lookaheadStride) {
        world.tick = start + t;
        for (let k = 0; k < 20; k++) {
          const a = (k / 20) * 2 * Math.PI;
          const px = spot.x + reach * Math.cos(a);
          const py = spot.y + reach * Math.sin(a);
          expect(plumesNear(world, px, py, plumeClearance)).toEqual([]);
        }
      }
      world.tick = start;
    }
  });
});

describe('the spawn ring', () => {
  const GOLDEN_ANGLE = 2.399963;
  const c = RULES.world.size / 2;

  it('stays in twilight and clear of plumes for all 24 slots on 20 seeds', () => {
    for (let i = 0; i < 20; i++) {
      const world = createWorld({ seed: `ring-${i}` });
      for (let slot = 0; slot < 24; slot++) {
        const radius = slot === 0 ? 0 : 300 + 40 * slot;
        const x = c + radius * Math.cos(slot * GOLDEN_ANGLE);
        const y = c + radius * Math.sin(slot * GOLDEN_ANGLE);
        expect(zoneAt(world.seed32, x, y)).toBe('twilight');
        expect(findClearSpot(world, x, y)).toEqual({ x, y });
      }
    }
  });
});

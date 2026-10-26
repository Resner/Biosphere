import { describe, expect, it } from 'vitest';
import { colliderReach, STARTER_PHYS } from './body';
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

describe('findClearSpot, nearest and stable', () => {
  const { searchStep, plumeClearance } = RULES.spawn;
  const c = RULES.world.size / 2;
  const clearNow = (world: ReturnType<typeof createWorld>, x: number, y: number) =>
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
    const worlds: ReturnType<typeof createWorld>[] = [];
    for (let i = 0; i < 2000 && worlds.length < count; i++) {
      const world = createWorld({ seed: `near-${i}` });
      if (!clearNow(world, c, c)) worlds.push(world);
    }
    return worlds;
  };

  it('returns the nearest clear point, not the first one in scan order', () => {
    const worlds = blockedWorlds(20);
    expect(worlds).toHaveLength(20);
    for (const world of worlds) {
      // Judge by the instant a spot is chosen: the same worlds, at tick 0, with no drift check.
      const spot = findClearSpot(world, c, c);
      expect(clearNow(world, spot.x, spot.y)).toBe(true);
      const distance = Math.hypot(spot.x - c, spot.y - c);
      // Drift clearance can push the answer out, never closer than the instant-clear optimum.
      expect(distance).toBeGreaterThanOrEqual(bruteNearest(world, c, c) - 1e-9);
    }
  });

  it('matches the brute-force nearest when nothing drifts', () => {
    for (const world of blockedWorlds(20)) {
      const calm = { ...world, options: { ...world.options, currents: false } };
      const spot = findClearSpot(calm, c, c);
      expect(Math.hypot(spot.x - c, spot.y - c)).toBeCloseTo(bruteNearest(calm, c, c), 6);
    }
  });

  it('keeps its lookahead in the rules: 10 s, checked every second', () => {
    expect(RULES.spawn.lookaheadTicks).toBe(300);
    expect(RULES.spawn.lookaheadStride).toBe(30);
  });

  it('stays clear of every plume for the next 10 s of drift', () => {
    for (const world of blockedWorlds(20)) {
      const spot = findClearSpot(world, c, c);
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
  const c = RULES.world.size / 2;
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
    let checked = 0;
    for (let i = 0; i < 2000 && checked < 20; i++) {
      const world = createWorld({ seed: `long-${i}` });
      if (plumesNear(world, c, c, plumeClearance).length === 0) continue;
      checked++;
      const spot = findClearSpot(world, c, c, reach);
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
    expect(checked).toBe(20);
  });
});

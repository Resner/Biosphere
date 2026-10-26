import { describe, expect, it } from 'vitest';
import { STARTER_PHYS } from './body';
import { applyHazards, plumesNear } from './hazards';
import { TAU } from './math';
import { DT, RULES, TICK_HZ } from './rules';
import { hashWorld } from './state-hash';
import { step } from './step';
import type { Plume, StepEvent, World } from './types';
import { createWorld, spawnCreature } from './world';

const allPlumes = (w: World): Plume[] => plumesNear(w, w.size / 2, w.size / 2, w.size);

const maxDrift =
  (RULES.hazards.driftFactor * 2 * RULES.currents.maxSpeed) /
  (TAU / (RULES.currents.timePeriodTicks / TICK_HZ));

describe('plumesNear', () => {
  it('is a pure function of the seed and tick', () => {
    const w = createWorld({ seed: 'haz' });
    const a = plumesNear(w, 4000, 4000, 600);
    expect(plumesNear(createWorld({ seed: 'haz' }), 4000, 4000, 600)).toEqual(a);
    expect(allPlumes(createWorld({ seed: 'haz2' }))).not.toEqual(allPlumes(w));
  });

  it('places about one plume per 9 food cells with radii of 60-160 wu', () => {
    const w = createWorld({ seed: 'haz', currents: false });
    const plumes = allPlumes(w);
    const cells = (w.size / RULES.world.cellSize) ** 2;
    expect(plumes.length).toBeGreaterThan((cells / 9) * 0.75);
    expect(plumes.length).toBeLessThan((cells / 9) * 1.25);
    for (const p of plumes) {
      expect(p.radius).toBeGreaterThanOrEqual(RULES.hazards.plumeMinRadius);
      expect(p.radius).toBeLessThanOrEqual(RULES.hazards.plumeMaxRadius);
    }
    expect(new Set(plumes.map((p) => p.id)).size).toBe(plumes.length);
  });

  it('finds every plume whose area reaches the query disc', () => {
    const w = createWorld({ seed: 'haz' });
    for (const tick of [0, 1500, 3000]) {
      w.tick = tick;
      const all = allPlumes(w);
      const near = plumesNear(w, 3100, 2900, 300);
      const expected = all.filter((p) => Math.hypot(p.x - 3100, p.y - 2900) <= 300 + p.radius);
      expect(near.map((p) => p.id).sort()).toEqual(expected.map((p) => p.id).sort());
    }
  });

  it('drifts with the currents, only by a bounded amount, and not at all without them', () => {
    const w = createWorld({ seed: 'haz' });
    const still = createWorld({ seed: 'haz', currents: false });
    const at0 = new Map(allPlumes(w).map((p) => [p.id, p]));
    let moved = 0;
    for (let tick = 0; tick < 7200; tick += 100) {
      w.tick = tick;
      still.tick = tick;
      for (const p of allPlumes(w)) {
        const p0 = at0.get(p.id);
        if (p0 === undefined) continue;
        moved = Math.max(moved, Math.hypot(p.x - p0.x, p.y - p0.y));
      }
    }
    expect(moved).toBeGreaterThan(20);
    expect(moved).toBeLessThanOrEqual(maxDrift);
    expect(allPlumes(still)).toEqual(allPlumes(createWorld({ seed: 'haz', currents: false })));
  });

  it('has none when hazards are off', () => {
    expect(allPlumes(createWorld({ seed: 'haz', hazards: false }))).toEqual([]);
  });
});

describe('toxin', () => {
  const inPlume = (): [World, string] => {
    const world = createWorld({ seed: 'haz', currents: false });
    const plume = allPlumes(world)[3] as Plume;
    const c = spawnCreature(world, { id: 'a', x: plume.x, y: plume.y });
    // At the growth threshold: more energy would grow the creature, and growth adds health.
    c.energy = 150;
    return [world, c.id];
  };

  it('kills a starter with energy to spare in a plume at tick 200', () => {
    const [world] = inPlume();
    const events: StepEvent[] = [];
    const c = world.creatures[0];
    while (c?.alive && world.tick < 1000) events.push(...step(world, {}));
    expect(world.tick).toBeGreaterThanOrEqual(199);
    expect(world.tick).toBeLessThanOrEqual(201);
    expect(c?.cause).toBe('toxin');
    expect(events).toContainEqual({ type: 'death', creature: 'a', cause: 'toxin' });
  });

  it('hurts once per tick however many plumes overlap, and not outside them', () => {
    const [world] = inPlume();
    const c = world.creatures[0];
    if (!c) throw new Error('no creature');
    const events = applyHazards(world, c);
    expect(events).toEqual([{ type: 'damage', creature: 'a', amount: 0.5, cause: 'toxin' }]);
    c.x = -1000;
    expect(applyHazards(world, c)).toEqual([]);
  });
});

describe('extra plumes', () => {
  it('poison a creature inside them, even with hazards off', () => {
    const world = createWorld({ seed: 'haz', hazards: false });
    const c = spawnCreature(world, { id: 'a', x: 3000, y: 3000 });
    expect(applyHazards(world, c)).toEqual([]);
    world.extraPlumes = [{ id: 'debug0', x: 3010, y: 3000, radius: 40 }];
    expect(plumesNear(world, 3000, 3000, 0)).toEqual(world.extraPlumes);
    expect(applyHazards(world, c)).toHaveLength(1);
    c.x = 3100;
    expect(applyHazards(world, c)).toEqual([]);
  });

  it('are part of the state hash, and an empty list is not', () => {
    const world = createWorld({ seed: 'haz' });
    const plain = hashWorld(world);
    world.extraPlumes = [];
    expect(hashWorld(world)).toBe(plain);
    world.extraPlumes = [{ id: 'debug0', x: 1, y: 2, radius: 3 }];
    expect(hashWorld(world)).not.toBe(plain);
  });
});

describe('toxin exposure through the colliders', () => {
  const TAIL = [
    { x: 0, y: 0, r: 1 },
    { x: -1.9, y: 0, r: 0.6 },
  ];

  /** A creature of radius 10 heading `heading` with a tail, and a plume over only the tail's centre. */
  const tailed = (heading: number) => {
    const world = createWorld({ seed: 'tail', currents: false, hazards: false });
    const c = spawnCreature(world, {
      id: 'a',
      x: 3000,
      y: 3000,
      biomass: 100,
      phys: { ...STARTER_PHYS, colliders: TAIL },
    });
    c.heading = heading;
    // The tail circle's centre sits 19 wu behind the core centre.
    world.extraPlumes = [{ id: 'd0', x: 3000 - 19, y: 3000, radius: 6 }];
    return { world, c };
  };

  it('is the share of collider area whose centre lies in a plume', () => {
    const { world, c } = tailed(0);
    const events = applyHazards(world, c);
    expect(events).toHaveLength(1);
    const amount = (events[0] as { amount: number }).amount;
    expect(amount).toBeCloseTo(((RULES.damage.toxin * 0.36) / 1.36) * DT, 6);
  });

  it('depends on which way the creature faces', () => {
    const { world, c } = tailed(Math.PI);
    expect(applyHazards(world, c)).toEqual([]);
  });

  it('does not stack overlapping plumes and keeps the starter at all or nothing', () => {
    const { world, c } = tailed(0);
    world.extraPlumes.push({ id: 'd1', x: 3000 - 19, y: 3001, radius: 6 });
    const events = applyHazards(world, c);
    expect((events[0] as { amount: number }).amount).toBeCloseTo(((15 * 0.36) / 1.36) * DT, 6);
    const plain = spawnCreature(world, { id: 'b', x: 3000, y: 3000 });
    world.extraPlumes = [{ id: 'd2', x: 3000, y: 3000, radius: 1 }];
    expect(applyHazards(world, plain)).toEqual([
      { type: 'damage', creature: 'b', amount: RULES.damage.toxin * DT, cause: 'toxin' },
    ]);
  });
});

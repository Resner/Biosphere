import { describe, expect, it } from 'vitest';
import { depthAt, zoneAt } from './bathymetry';
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

  it('raises plumes from vents in the deep and the abyss, about one per 9 cells there', () => {
    const w = createWorld({ seed: 'haz', currents: false });
    const plumes = allPlumes(w);
    const cell = RULES.world.cellSize;
    const side = w.size / cell;
    let eligible = 0;
    for (let cy = 0; cy < side; cy++) {
      for (let cx = 0; cx < side; cx++) {
        const x = (cx + 0.5) * cell;
        const y = (cy + 0.5) * cell;
        const far = Math.hypot(x - w.size / 2, y - w.size / 2) >= RULES.hazards.ventMinDistance;
        if (far && depthAt(w.seed32, x, y) >= RULES.bathymetry.zones.twilight) eligible++;
      }
    }
    expect(plumes.length).toBeGreaterThan((eligible / 9) * 0.6);
    expect(plumes.length).toBeLessThan((eligible / 9) * 1.4);
    for (const p of plumes) {
      expect(p.radius).toBeGreaterThanOrEqual(RULES.hazards.plumeMinRadius);
      expect(p.radius).toBeLessThanOrEqual(RULES.hazards.plumeMaxRadius);
      expect(Math.hypot(p.x - w.size / 2, p.y - w.size / 2)).toBeGreaterThanOrEqual(
        RULES.hazards.ventMinDistance,
      );
    }
    expect(new Set(plumes.map((p) => p.id)).size).toBe(plumes.length);
  });

  it('keeps at least 80% of the plumes in the deep or the abyss, drift included', () => {
    for (const seed of ['haz', 'haz2', 'haz3']) {
      const w = createWorld({ seed });
      for (const tick of [0, 900, 1800]) {
        w.tick = tick;
        const plumes = allPlumes(w);
        const down = plumes.filter((p) => {
          const zone = zoneAt(w.seed32, p.x, p.y);
          return zone === 'deep' || zone === 'abyss';
        });
        expect(down.length / plumes.length).toBeGreaterThanOrEqual(0.8);
      }
    }
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
    // A plume in the upper deep: no pressure there, so toxin is the only damage.
    const plume = allPlumes(world).find((p) => {
      const depth = depthAt(world.seed32, p.x, p.y);
      return depth > 0.58 && depth < 0.66;
    }) as Plume;
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

describe('UV and pressure', () => {
  /** A point whose depth lies in [lo, hi], found on a coarse scan. */
  const spotWithDepth = (world: World, lo: number, hi: number): { x: number; y: number } => {
    for (let y = 100; y < world.size; y += 100) {
      for (let x = 100; x < world.size; x += 100) {
        const depth = depthAt(world.seed32, x, y);
        if (depth >= lo && depth <= hi) return { x, y };
      }
    }
    throw new Error('no such depth');
  };
  const tolerant = (uv: number, pressure: number) => ({
    ...STARTER_PHYS,
    uvTolerance: uv,
    pressureTolerance: pressure,
  });
  const at = (phys = STARTER_PHYS, lo: number, hi: number, options = {}) => {
    const world = createWorld({ seed: 'zones', currents: false, ...options });
    const spot = spotWithDepth(world, lo, hi);
    const c = spawnCreature(world, { id: 'a', ...spot, phys });
    return { world, c };
  };

  it('burns 2 hp/s × (1 − tolerance) in the shallows, and nothing in twilight', () => {
    const { world, c } = at(tolerant(0, 1), 0.1, 0.15);
    expect(applyHazards(world, c)).toEqual([
      { type: 'damage', creature: 'a', amount: 2 * DT, cause: 'uv' },
    ]);
    const half = at(tolerant(0.5, 1), 0.1, 0.15);
    expect(applyHazards(half.world, half.c)[0]).toMatchObject({ cause: 'uv', amount: DT });
    const twilight = at(tolerant(0, 0), 0.3, 0.5);
    expect(applyHazards(twilight.world, twilight.c)).toEqual([]);
  });

  it('ramps UV in over a band below the edge of the shallows', () => {
    const { world, c } = at(tolerant(0, 1), 0.24, 0.245);
    const [event] = applyHazards(world, c);
    expect(event?.type === 'damage' && event.amount).toBeGreaterThan(0);
    expect(event?.type === 'damage' && event.amount).toBeLessThan(0.5 * 2 * DT);
  });

  it('crushes 3 hp/s × (1 − tolerance) in the abyss, ramping in from depth 0.7', () => {
    const abyss = at(tolerant(1, 0), 0.85, 0.95);
    expect(applyHazards(abyss.world, abyss.c)).toEqual([
      { type: 'damage', creature: 'a', amount: 3 * DT, cause: 'pressure' },
    ]);
    const lower = at(tolerant(1, 0), 0.74, 0.76);
    const [event] = applyHazards(lower.world, lower.c);
    expect(event?.type === 'damage' && event.amount).toBeGreaterThan(0);
    expect(event?.type === 'damage' && event.amount).toBeLessThan(3 * DT);
    const upper = at(tolerant(1, 0), 0.6, 0.68);
    expect(applyHazards(upper.world, upper.c)).toEqual([]);
  });

  it('takes no damage with full tolerance, or with hazards off', () => {
    const safe = at(tolerant(1, 1), 0.85, 0.95);
    expect(applyHazards(safe.world, safe.c)).toEqual([]);
    const off = at(tolerant(0, 0), 0.1, 0.15, { hazards: false });
    expect(applyHazards(off.world, off.c)).toEqual([]);
  });

  it('names the cause on death', () => {
    const { world, c } = at(tolerant(0, 1), 0.1, 0.15);
    c.energy = 150;
    const events: StepEvent[] = [];
    while (c.alive && world.tick < 3000) events.push(...step(world, {}));
    expect(c.cause).toBe('uv');
    expect(events).toContainEqual({ type: 'death', creature: 'a', cause: 'uv' });
  });

  it('covers the tolerances in the state hash', () => {
    const a = at(tolerant(0.2, 0.3), 0.3, 0.5);
    const b = at(tolerant(0.2, 0.4), 0.3, 0.5);
    expect(hashWorld(a.world)).not.toBe(hashWorld(b.world));
  });
});

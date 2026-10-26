import { describe, expect, it } from 'vitest';
import { type PhysStats, STARTER_PHYS } from './body';
import { IDLE, type Input } from './input';
import { applyMetabolism } from './metabolism';
import { RULES } from './rules';
import { hashWorld } from './state-hash';
import { step } from './step';
import type { CreatureState, StepEvent, World } from './types';
import { createWorld, spawnCreature } from './world';

const setup = (biomass = 100): [World, CreatureState] => {
  const world = createWorld({ seed: 'meta', currents: false, hazards: false });
  return [world, spawnCreature(world, { id: 'a', x: 4096, y: 4096, biomass })];
};

const run = (world: World, c: CreatureState, ticks: number, input: Input): StepEvent[] => {
  const events: StepEvent[] = [];
  for (let i = 0; i < ticks; i++) {
    events.push(...applyMetabolism(world, c, input));
    world.tick++;
  }
  return events;
};

describe('applyMetabolism', () => {
  it('drains 0.8 energy/s when idle', () => {
    const [world, c] = setup();
    const start = c.energy;
    run(world, c, 300, IDLE);
    expect(start - c.energy).toBeGreaterThan(8 * 0.99);
    expect(start - c.energy).toBeLessThan(8 * 1.01);
  });

  it('drains 1.4 energy/s at full throttle', () => {
    const [world, c] = setup();
    const start = c.energy;
    run(world, c, 300, { steer: 0, throttle: 15, dash: false });
    expect(start - c.energy).toBeGreaterThan(14 * 0.99);
    expect(start - c.energy).toBeLessThan(14 * 1.01);
  });

  it('grows 1.2 biomass/s above 75% energy and pays 3 energy per biomass', () => {
    const [world, c] = setup();
    c.energy = 160;
    const events = run(world, c, 30, IDLE);
    expect(c.biomass - 100).toBeGreaterThan(1.2 * 0.97);
    expect(c.biomass - 100).toBeLessThan(1.2 * 1.03);
    expect(160 - c.energy).toBeCloseTo(0.8 * 1.0 + 3 * (c.biomass - 100), 1);
    expect(events.every((e) => e.type === 'grow')).toBe(true);
  });

  it('does not grow at or below 75% energy', () => {
    const [world, c] = setup();
    c.energy = 150;
    run(world, c, 30, IDLE);
    expect(c.biomass).toBe(100);
  });

  it('raises maximum health with the radius and stops growing at 400', () => {
    const [world, c] = setup();
    c.energy = 200;
    run(world, c, 30, IDLE);
    expect(c.health).toBeCloseTo(RULES.creature.healthPerRadius * Math.sqrt(c.biomass), 9);
    const [w2, big] = setup(399.99);
    big.energy = 800;
    run(w2, big, 90, IDLE);
    expect(big.biomass).toBe(STARTER_PHYS.maxBiomass);
  });

  it('announces a grow event when the whole biomass changes', () => {
    const [world, c] = setup();
    c.energy = 200;
    const events = run(world, c, 90, IDLE);
    const grows = events.filter((e) => e.type === 'grow');
    expect(grows.length).toBeGreaterThan(0);
    expect(grows.length).toBeLessThan(5);
  });

  it('starves a creature with no energy at 8 hp/s', () => {
    const [world, c] = setup();
    c.energy = 0;
    const events = run(world, c, 30, IDLE);
    expect(c.energy).toBe(0);
    expect(c.health).toBeCloseTo(100 - 8, 6);
    expect(events.every((e) => e.type === 'damage' && e.cause === 'starved')).toBe(true);
  });

  it('does nothing for a dead creature', () => {
    const [world, c] = setup();
    c.alive = false;
    const before = structuredClone(c);
    expect(run(world, c, 10, { steer: 0, throttle: 15, dash: false })).toEqual([]);
    expect(c).toEqual(before);
  });
});

describe('step: death', () => {
  it('starves a starter at 0 energy at tick 375', () => {
    const [world, c] = setup();
    c.energy = 0;
    const events: StepEvent[] = [];
    while (c.alive && world.tick < 1000) events.push(...step(world, {}));
    expect(world.tick).toBeGreaterThanOrEqual(374);
    expect(world.tick).toBeLessThanOrEqual(376);
    expect(c.cause).toBe('starved');
    expect(c.health).toBe(0);
    expect(events.filter((e) => e.type === 'death')).toEqual([
      { type: 'death', creature: 'a', cause: 'starved' },
    ]);
  });

  it('ignores input and emits nothing once dead', () => {
    const [world, c] = setup();
    c.energy = 0;
    while (c.alive) step(world, {});
    const hash = hashWorld(world);
    const tick = world.tick;
    const events = step(world, { a: { steer: 64, throttle: 15, dash: true } });
    expect(events).toEqual([]);
    world.tick = tick;
    expect(hashWorld(world)).toBe(hash);
  });
});

describe('applyMetabolism with a body', () => {
  const withPhys = (phys: Partial<PhysStats>, biomass = 100): [World, CreatureState] => {
    const world = createWorld({ seed: 'meta', currents: false, hazards: false });
    return [
      world,
      spawnCreature(world, {
        id: 'a',
        x: 4096,
        y: 4096,
        biomass,
        phys: { ...STARTER_PHYS, ...phys },
      }),
    ];
  };

  it('drains the basal rate times the basal multiplier', () => {
    const drain = (basal: number): number => {
      const [world, c] = withPhys({ basal });
      const start = c.energy;
      run(world, c, 300, IDLE);
      return start - c.energy;
    };
    expect(drain(1.5) / drain(1)).toBeCloseTo(1.5, 9);
  });

  it('multiplies the growth rate while energy is above 75%', () => {
    const grown = (growth: number): number => {
      const [world, c] = withPhys({ growth, maxBiomass: 4000 });
      c.energy = 200;
      run(world, c, 1, IDLE);
      return c.biomass - 100;
    };
    expect(grown(2) / grown(1)).toBeCloseTo(2, 6);
  });

  it('stops growing at the genetic maximum without paying energy there', () => {
    for (const maxBiomass of [150, 900]) {
      const [world, c] = withPhys({ maxBiomass }, 100);
      for (let i = 0; i < 30 * 600; i++) {
        c.energy = 2 * c.biomass; // held full
        run(world, c, 1, IDLE);
        if (c.biomass >= maxBiomass - 1e-9) break;
      }
      expect(Math.abs(c.biomass - maxBiomass)).toBeLessThan(1);
      c.energy = 2 * c.biomass;
      const before = c.energy;
      const events = run(world, c, 1, IDLE);
      expect(events.filter((e) => e.type === 'grow')).toEqual([]);
      expect(before - c.energy).toBeLessThan(0.1 * 2); // basal drain only
    }
  });
});

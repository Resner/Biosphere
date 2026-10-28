import { describe, expect, it } from 'vitest';
import { STARTER_PHYS } from './body';
import { RULES, RULES_VERSION } from './rules';
import { hashWorld } from './state-hash';
import type { CreatureState, DeathCause, World } from './types';
import { createWorld, spawnCreature } from './world';

const deepFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
};

describe('RULES', () => {
  it('is deep-frozen', () => {
    expect(RULES_VERSION).toBe(6);
    expect(deepFrozen(RULES)).toBe(true);
  });

  it('holds the DESIGN.md starter values', () => {
    expect(RULES.starter.biomass).toBe(100);
    expect(RULES.starter.energyFraction).toBe(0.6);
    expect(RULES.movement.drag).toBe(2.2);
    expect(RULES.world.size).toBe(8192);
  });
});

describe('createWorld and spawnCreature', () => {
  it('starts empty at tick 0 with the default size and options', () => {
    const world = createWorld({ seed: 'pond-1' });
    expect(world).toMatchObject({
      rules: RULES_VERSION,
      seed: 'pond-1',
      tick: 0,
      size: 8192,
      creatures: [],
      consumed: {},
      options: { currents: true, hazards: true },
    });
    expect(world.seed32).toHaveLength(4);
  });

  it('spawns with the starter defaults', () => {
    const world = createWorld({ seed: 'pond-1' });
    const c = spawnCreature(world, { id: 'a', x: 10, y: 20 });
    expect(c).toEqual({
      id: 'a',
      x: 10,
      y: 20,
      vx: 0,
      vy: 0,
      heading: 0,
      biomass: 100,
      energy: 120,
      health: 100,
      dashReadyTick: 0,
      alive: true,
      elder: false,
      cause: null,
      bornTick: 0,
      phys: STARTER_PHYS,
    });
    expect(world.creatures).toEqual([c]);
  });

  it('scales energy and health with a custom biomass', () => {
    const world = createWorld({ seed: 's' });
    const c = spawnCreature(world, { id: 'a', x: 0, y: 0, biomass: 400 });
    expect(c.energy).toBe(480);
    expect(c.health).toBe(200);
  });

  it('rejects a duplicate id', () => {
    const world = createWorld({ seed: 's' });
    spawnCreature(world, { id: 'a', x: 0, y: 0 });
    expect(() => spawnCreature(world, { id: 'a', x: 1, y: 1 })).toThrow();
  });
});

describe('hashWorld', () => {
  const build = (order: string[]): World => {
    const world = createWorld({ seed: 'pond-1' });
    for (const id of order) spawnCreature(world, { id, x: id === 'b' ? 5 : 9, y: 3 });
    return world;
  };

  it('is stable for a seed and differs between seeds', () => {
    const world = createWorld({ seed: 'pond-1' });
    expect(hashWorld(world)).toBe(hashWorld(world));
    expect(hashWorld(world)).toMatch(/^[0-9a-f]{16}$/);
    expect(hashWorld(createWorld({ seed: 'pond-2' }))).not.toBe(hashWorld(world));
  });

  it('keeps creatures sorted by id regardless of spawn order', () => {
    const ab = build(['a', 'b']);
    const ba = build(['b', 'a']);
    expect(ba.creatures.map((c) => c.id)).toEqual(['a', 'b']);
    expect(hashWorld(ab)).toBe(hashWorld(ba));
  });

  it('changes when any creature field changes', () => {
    const base = build(['a', 'b']);
    const baseHash = hashWorld(base);
    const mutations: Partial<CreatureState>[] = [
      { id: 'z' },
      { x: 9 + 1e-9 },
      { y: 3 + 1e-9 },
      { vx: 1e-9 },
      { vy: 1e-9 },
      { heading: 1e-9 },
      { biomass: 101 },
      { energy: 121 },
      { health: 99 },
      { dashReadyTick: 1 },
      { alive: false },
      { elder: true },
      { cause: 'toxin' satisfies DeathCause },
      { bornTick: 1 },
      { phys: { ...STARTER_PHYS, thrust: 1.1 } },
    ];
    const covered = new Set(['id', ...mutations.flatMap((m) => Object.keys(m))]);
    expect([...covered].sort()).toEqual(Object.keys(base.creatures[0] as CreatureState).sort());
    for (const m of mutations) {
      const world = structuredClone(base);
      Object.assign(world.creatures[0] as CreatureState, m);
      expect(hashWorld(world), JSON.stringify(m)).not.toBe(baseHash);
    }
  });

  it('changes when world fields change', () => {
    const base = build(['a']);
    const baseHash = hashWorld(base);
    // seed32 derives from seed; creatures are covered by the test above.
    const covered = [
      'rules',
      'tick',
      'size',
      'consumed',
      'options',
      'extraPlumes',
      'seed',
      'seed32',
      'creatures',
    ];
    expect(covered.sort()).toEqual(Object.keys(base).sort());
    const variants: ((w: World) => void)[] = [
      (w) => {
        w.tick = 1;
      },
      (w) => {
        w.size = 4096;
      },
      (w) => {
        w.consumed.c0_0_s0 = { k: 1, until: 700 };
      },
      (w) => {
        w.options.currents = false;
      },
      (w) => {
        w.options.hazards = false;
      },
      (w) => {
        w.extraPlumes.push({ id: 'debug0', x: 1, y: 2, radius: 3 });
      },
      (w) => {
        w.rules = RULES_VERSION + 1;
      },
    ];
    for (const mutate of variants) {
      const world = structuredClone(base);
      mutate(world);
      expect(hashWorld(world)).not.toBe(baseHash);
    }
  });

  it('does not depend on consumed insertion order', () => {
    const one = createWorld({ seed: 's' });
    one.consumed.x = { k: 1, until: 1 };
    one.consumed.y = { k: 1, until: 2 };
    const two = createWorld({ seed: 's' });
    two.consumed.y = { k: 1, until: 2 };
    two.consumed.x = { k: 1, until: 1 };
    expect(hashWorld(one)).toBe(hashWorld(two));
  });

  it('survives structuredClone', () => {
    const world = build(['a', 'b']);
    world.consumed.f1 = { k: 1, until: 40 };
    const clone = structuredClone(world);
    expect(clone).toEqual(world);
    expect(hashWorld(clone)).toBe(hashWorld(world));
  });

  it('refuses a non-finite state', () => {
    const world = build(['a']);
    (world.creatures[0] as CreatureState).x = Number.NaN;
    expect(() => hashWorld(world)).toThrow();
  });
});

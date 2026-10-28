import { describe, expect, it } from 'vitest';
import { type PhysStats, STARTER_PHYS, sanitizePhys } from './body';
import { RULES } from './rules';
import { hashWorld } from './state-hash';
import { createWorld, spawnCreature } from './world';

const deepFrozen = (value: unknown): boolean => {
  if (typeof value !== 'object' || value === null) return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
};

describe('STARTER_PHYS', () => {
  it('reproduces the M1 cell', () => {
    expect(STARTER_PHYS).toMatchObject({
      maxBiomass: 400,
      thrust: 1,
      drag: 1,
      turn: 1,
      basal: 1,
      growth: 1,
    });
    expect(STARTER_PHYS.colliders).toEqual([{ x: 0, y: 0, r: 1 }]);
  });

  it('is frozen, and spawnCreature copies it', () => {
    expect(deepFrozen(STARTER_PHYS)).toBe(true);
    const world = createWorld({ seed: 'b' });
    const c = spawnCreature(world, { id: 'a', x: 1, y: 1 });
    expect(c.phys).toEqual(STARTER_PHYS);
    expect(c.phys).not.toBe(STARTER_PHYS);
    expect(Object.isFrozen(c.phys)).toBe(false);
  });
});

describe('sanitizePhys', () => {
  const custom: PhysStats = {
    ...STARTER_PHYS,
    thrust: 1.4,
    colliders: [
      { x: 0, y: 0, r: 1 },
      { x: -1.8, y: 0.5, r: 0.5 },
    ],
  };

  it('keeps a valid body as it is', () => {
    expect(sanitizePhys(custom)).toEqual(custom);
  });

  it('clamps every multiplier and the maximum biomass into range', () => {
    const wild = sanitizePhys({
      ...STARTER_PHYS,
      maxBiomass: 1e9,
      thrust: 100,
      drag: 0,
      turn: -3,
      basal: Number.NaN,
      growth: Number.POSITIVE_INFINITY,
    });
    for (const key of ['thrust', 'drag', 'turn', 'basal', 'growth'] as const) {
      expect(wild[key]).toBeGreaterThanOrEqual(0.1);
      expect(wild[key]).toBeLessThanOrEqual(4);
    }
    expect(wild.maxBiomass).toBeLessThanOrEqual(RULES.body.maxBiomassCeiling);
    expect(wild.maxBiomass).toBeGreaterThanOrEqual(RULES.body.maxBiomassFloor);
    expect(wild.drag).toBe(0.1);
    expect(wild.basal).toBe(1);
  });

  it('forces the core first and 1 to 12 colliders', () => {
    const none = sanitizePhys({ ...STARTER_PHYS, colliders: [] });
    expect(none.colliders).toEqual([{ x: 0, y: 0, r: 1 }]);
    const moved = sanitizePhys({ ...STARTER_PHYS, colliders: [{ x: 3, y: 3, r: 7 }] });
    expect(moved.colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
    const many = sanitizePhys({
      ...STARTER_PHYS,
      colliders: Array.from({ length: 30 }, (_, i) => ({ x: -i, y: 0, r: 0.5 })),
    });
    expect(many.colliders).toHaveLength(12);
    expect(many.colliders[0]).toEqual({ x: 0, y: 0, r: 1 });
  });

  it('clamps collider reach and size and the mouth', () => {
    const p = sanitizePhys({
      ...STARTER_PHYS,
      colliders: [
        { x: 0, y: 0, r: 1 },
        { x: -50, y: 50, r: 99 },
      ],
      mouth: { offset: 9, radius: -1, arc: 99, type: 7, digestion: 0 },
    });
    const far = p.colliders[1] as { x: number; y: number; r: number };
    expect(Math.hypot(far.x, far.y) + far.r).toBeLessThanOrEqual(RULES.body.maxReach + 1e-9);
    expect(far.r).toBeLessThanOrEqual(RULES.body.maxColliderRadius);
    expect(p.mouth.type).toBe(1);
    expect(p.mouth.arc).toBeLessThanOrEqual(Math.PI);
    expect(p.mouth.radius).toBeGreaterThan(0);
    expect(p.mouth.digestion).toBeGreaterThan(0);
  });

  it('is idempotent and does not mutate its input', () => {
    const wild = { ...STARTER_PHYS, thrust: 99, colliders: [] };
    const once = sanitizePhys(wild);
    const far = sanitizePhys({
      ...STARTER_PHYS,
      colliders: [
        { x: 0, y: 0, r: 1 },
        { x: -13.7, y: 8.1, r: 0.9 },
        { x: 3.3, y: -40, r: 1.2 },
      ],
    });
    expect(sanitizePhys(far)).toEqual(far);
    expect(sanitizePhys(once)).toEqual(once);
    expect(wild.colliders).toEqual([]);
  });

  it('is applied by spawnCreature', () => {
    const world = createWorld({ seed: 'b' });
    const c = spawnCreature(world, { id: 'a', x: 1, y: 1, phys: { ...STARTER_PHYS, thrust: 99 } });
    expect(c.phys.thrust).toBe(4);
  });
});

describe('the state hash and phys', () => {
  const hashWith = (edit: (p: PhysStats) => void): string => {
    const world = createWorld({ seed: 'h' });
    const c = spawnCreature(world, { id: 'a', x: 1, y: 1 });
    edit(c.phys);
    return hashWorld(world);
  };
  const base = hashWith(() => {});

  it('covers every phys field', () => {
    const edits: ((p: PhysStats) => void)[] = [
      (p) => {
        p.maxBiomass = 401;
      },
      (p) => {
        p.thrust = 1.1;
      },
      (p) => {
        p.drag = 1.1;
      },
      (p) => {
        p.turn = 1.1;
      },
      (p) => {
        p.basal = 1.1;
      },
      (p) => {
        p.growth = 1.1;
      },
      (p) => {
        p.mouth.offset = 0.1;
      },
      (p) => {
        p.mouth.radius = 0.9;
      },
      (p) => {
        p.mouth.arc = 1;
      },
      (p) => {
        p.mouth.type = 0.1;
      },
      (p) => {
        p.mouth.digestion = 0.9;
      },
      (p) => {
        p.colliders.push({ x: -1, y: 0, r: 0.5 });
      },
      (p) => {
        (p.colliders[0] as { r: number }).r = 1.5;
      },
    ];
    for (const edit of edits) expect(hashWith(edit)).not.toBe(base);
  });

  it('rejects NaN and Infinity inside phys', () => {
    expect(() =>
      hashWith((p) => {
        p.thrust = Number.NaN;
      }),
    ).toThrow();
    expect(() =>
      hashWith((p) => {
        p.mouth.arc = Number.POSITIVE_INFINITY;
      }),
    ).toThrow();
    expect(() =>
      hashWith((p) => {
        p.colliders[0] = { x: 0, y: Number.NaN, r: 1 };
      }),
    ).toThrow();
  });
});

describe('tolerances', () => {
  it('are clamped to 0-1, with the starter value for junk', () => {
    expect(sanitizePhys({ ...STARTER_PHYS, uvTolerance: 7, pressureTolerance: -2 })).toMatchObject({
      uvTolerance: 1,
      pressureTolerance: 0,
    });
    const junk = sanitizePhys({
      ...STARTER_PHYS,
      uvTolerance: Number.NaN,
      pressureTolerance: Number.POSITIVE_INFINITY,
    });
    expect(junk.uvTolerance).toBe(STARTER_PHYS.uvTolerance);
    expect(junk.pressureTolerance).toBe(STARTER_PHYS.pressureTolerance);
  });
});

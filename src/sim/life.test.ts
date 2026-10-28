import { describe, expect, it } from 'vitest';
import { IDLE, type Input } from './input';
import { accrue, applyLife, type LifeStage, lifeStage, lifespanMs } from './life';
import { mateCost } from './mating';
import { applyMetabolism } from './metabolism';
import { applyMovement } from './physics';
import { RULES } from './rules';
import { hashWorld } from './state-hash';
import { step } from './step';
import { maxHealth } from './vitals';
import { createWorld, spawnCreature } from './world';

describe('lifespanMs', () => {
  it('is 75 minutes times the lifespan trait', () => {
    expect(lifespanMs(1)).toBe(4_500_000);
    expect(lifespanMs(0.6)).toBe(2_700_000);
    expect(lifespanMs(1.6)).toBe(7_200_000);
  });
});

describe('lifeStage', () => {
  const span = 4_500_000;
  const max = 1000;
  const stage = (active: number, biomass = max, lifespan = span): LifeStage =>
    lifeStage(active, lifespan, biomass, max);

  it('is young before 7 minutes when 10% of the lifespan is less, whatever the biomass', () => {
    const short = 2_700_000; // 10% = 4.5 min
    expect(stage(419_999, max, short)).toBe('young');
    expect(stage(420_000, max, short)).toBe('mature');
  });

  it('is young below 60% of the maximum biomass, mature at exactly 60%', () => {
    expect(stage(1_000_000, 599.9)).toBe('young');
    expect(stage(1_000_000, 600)).toBe('mature');
    expect(stage(449_999, 600)).toBe('young'); // 10% of 75 min is 7.5 min
  });

  it('needs 10% of the lifespan when that is more than 7 minutes', () => {
    const long = 7_200_000; // 10% = 12 min
    expect(stage(719_999, max, long)).toBe('young');
    expect(stage(720_000, max, long)).toBe('mature');
  });

  it('is old from 85% of the lifespan, and old beats mature and young', () => {
    expect(stage(3_824_999)).toBe('mature');
    expect(stage(3_825_000)).toBe('old');
    expect(stage(4_500_000)).toBe('old');
    expect(stage(3_825_000, 1)).toBe('old');
    const short = 2_700_000; // 10% = 4.5 min, so 7 min decides; old starts at 38.25 min
    expect(stage(2_295_000, 1, short)).toBe('old');
  });
});

describe('accrue', () => {
  it('credits the claimed ticks when real time allows', () => {
    expect(accrue(0, 900, 30_000)).toBe(30_000);
  });

  it('caps at the wall time plus two seconds', () => {
    expect(accrue(0, 900, 10_000)).toBe(12_000);
  });

  it('credits nothing for zero ticks, a rewound count or negative wall time', () => {
    expect(accrue(100, 100, 30_000)).toBe(0);
    expect(accrue(0, 0, 30_000)).toBe(0);
    expect(accrue(900, 100, 30_000)).toBe(0);
    expect(accrue(0, 900, -1)).toBe(0);
  });

  it('credits nothing for NaN input', () => {
    expect(accrue(0, Number.NaN, 1000)).toBe(0);
    expect(accrue(Number.NaN, 900, 1000)).toBe(0);
    expect(accrue(0, 900, Number.NaN)).toBe(0);
  });

  it('counts only the new ticks since the last report', () => {
    expect(accrue(900, 1800, 60_000)).toBe(30_000);
  });
});

function elderPair() {
  const world = createWorld({ seed: 'life', currents: false, hazards: false });
  const young = spawnCreature(world, { id: 'a', x: 4096, y: 4096 });
  const old = spawnCreature(world, { id: 'b', x: 4096, y: 4096 });
  old.elder = true;
  return { world, young, old };
}

describe('elder creatures', () => {
  it('start out young', () => {
    const world = createWorld({ seed: 'life' });
    expect(spawnCreature(world, { id: 'a', x: 1, y: 1 }).elder).toBe(false);
  });

  it('swim at 0.8 times the top speed', () => {
    const { world, young, old } = elderPair();
    const input: Input = { steer: 0, throttle: 15, dash: false };
    for (let i = 0; i < 300; i++) {
      young.x = old.x = 4096;
      applyMovement(world, young, input);
      applyMovement(world, old, input);
    }
    expect(old.vx / young.vx).toBeGreaterThan(0.8 * 0.99);
    expect(old.vx / young.vx).toBeLessThan(0.8 * 1.01);
  });

  it('drain 1.2 times the basal energy of an idle young one', () => {
    const { world, young, old } = elderPair();
    const start = young.energy;
    for (let i = 0; i < 300; i++) {
      applyMetabolism(world, young, IDLE);
      applyMetabolism(world, old, IDLE);
    }
    expect((start - old.energy) / (start - young.energy)).toBeGreaterThan(1.2 * 0.99);
    expect((start - old.energy) / (start - young.energy)).toBeLessThan(1.2 * 1.01);
  });

  it('keep their body stats', () => {
    const { world, young, old } = elderPair();
    for (let i = 0; i < 30; i++) step(world, {});
    expect(old.phys).toEqual(young.phys);
  });
});

describe('applyLife', () => {
  it('elder sets the flag and emits nothing', () => {
    const { world } = elderPair();
    const a = world.creatures[0];
    expect(a && applyLife(world, a.id, 'elder')).toEqual([]);
    expect(a?.elder).toBe(true);
  });

  it('expire kills with the cause old-age and emits one death', () => {
    const { world, young } = elderPair();
    expect(applyLife(world, young.id, 'expire')).toEqual([
      { type: 'death', creature: young.id, cause: 'old-age' },
    ]);
    expect(young).toMatchObject({ alive: false, health: 0, cause: 'old-age' });
    expect(applyLife(world, young.id, 'expire')).toEqual([]);
  });

  it('leaves the first cause of death alone and ignores unknown creatures', () => {
    const { world, young } = elderPair();
    young.alive = false;
    young.cause = 'starved';
    expect(applyLife(world, young.id, 'expire')).toEqual([]);
    expect(young.cause).toBe('starved');
    expect(applyLife(world, 'nobody', 'expire')).toEqual([]);
  });

  it('is covered by the state hash', () => {
    const { world, young } = elderPair();
    const before = hashWorld(world);
    young.elder = true;
    expect(hashWorld(world)).not.toBe(before);
  });
});

describe('lifeStage with matureAtMs', () => {
  const span = 4_500_000;
  it('uses the given maturity time instead of the M4 rule', () => {
    expect(lifeStage(100_000, span, 1000, 1000, 100_000)).toBe('mature');
    expect(lifeStage(99_999, span, 1000, 1000, 100_000)).toBe('young');
    expect(lifeStage(3_825_000, span, 1000, 1000, 100_000)).toBe('old');
  });

  it('keeps the maturity biomass share', () => {
    expect(lifeStage(100_000, span, 599, 1000, 100_000)).toBe('young');
  });
});

describe('applyLife mate', () => {
  it('pays the cost, shrinks the radius, clamps health and emits nothing', () => {
    const { world, young } = elderPair();
    young.biomass = 500;
    young.energy = 800;
    young.health = maxHealth(500);
    const cost = mateCost(500, 800);
    expect(applyLife(world, young.id, 'mate')).toEqual([]);
    expect(young.biomass).toBe(cost.biomass);
    expect(young.energy).toBe(cost.energy);
    expect(young.health).toBe(maxHealth(cost.biomass));
    expect(young.health).toBeLessThan(maxHealth(500));
    expect(young.alive).toBe(true);
  });

  it('keeps health that is already below the new maximum', () => {
    const { world, young } = elderPair();
    young.health = 5;
    applyLife(world, young.id, 'mate');
    expect(young.health).toBe(5);
  });

  it('ignores the dead and unknown creatures', () => {
    const { world, young } = elderPair();
    young.alive = false;
    const before = young.biomass;
    expect(applyLife(world, young.id, 'mate')).toEqual([]);
    expect(young.biomass).toBe(before);
    expect(applyLife(world, 'nobody', 'mate')).toEqual([]);
  });
});

describe('RULES.life', () => {
  it('holds the frozen numbers', () => {
    expect(RULES.life).toEqual({
      lifespanBaseMs: 4_500_000,
      elderAt: 0.85,
      elderThrust: 0.8,
      elderBasal: 1.2,
      matureMinMs: 420_000,
      matureMinShare: 0.1,
      matureBiomassShare: 0.6,
      accrueSlackMs: 2000,
    });
  });
});

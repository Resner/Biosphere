import { describe, expect, it } from 'vitest';
import {
  drive,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../../tests/encounter-fixture';
import { STARTER_COMBAT, STARTER_PHYS } from '../body';
import { DT, RULES } from '../rules';
import { sizeTier } from '../size';
import { maxEnergy, maxHealth } from '../vitals';
import { createEncounter, results, stepFrame } from './encounter';
import { spread, strikePower } from './strike';
import type { Encounter, EncounterEvent, FighterStart, Stance } from './types';

const E = RULES.encounter;
const R = Math.sqrt(RULES.starter.biomass);
const T0 = 1000;
const at = (enc: Encounter, slot: number) => enc.fighters[slot] as Encounter['fighters'][number];
type Hit = Extract<EncounterEvent, { type: 'hit' }>;
const isStrike = (h: Hit): boolean => h.kind === 'strike';
const hitsOf = (events: EncounterEvent[]): Hit[] =>
  events.filter((e): e is Hit => e.type === 'hit');

/** A pond with no currents and no hazards, so that a test sees only the encounter's own rules. */
const calm = (enc: Encounter) => {
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
};

/** The hunter (slot 0, "a") faces a still target (slot 1, "b") 1.2 hunter radii from its edge. */
function duel(
  opts: {
    hunter?: Partial<FighterStart>;
    target?: Partial<FighterStart>;
    gap?: number;
    id?: string;
  } = {},
): Encounter {
  const hunter = { ...hunterFighter('a', 3000, 3000), ...opts.hunter };
  const target = { ...starterFighter('b', 0, 3000, Math.PI), ...opts.target };
  const ra = Math.sqrt(hunter.biomass);
  const rb = Math.sqrt(target.biomass);
  target.x = 3000 + (opts.gap ?? 1.2) * ra + rb;
  return calm(createEncounter(startOf(opts.id ?? 'duel', [hunter, target])));
}

/** Steps `frames` frames with each frame's inputs by slot; returns every hit. */
function run(
  enc: Encounter,
  frames: number,
  inputs: (frame: number) => (number | null)[] = () => [IDLE_CODE, IDLE_CODE],
): Hit[] {
  const out: Hit[] = [];
  for (let f = 1; f <= frames; f++) out.push(...hitsOf(stepFrame(enc, inputs(f))));
  return out;
}

const expectedStrike = (enc: Encounter, tick: number, attacker = 0, armour = 1): number =>
  E.damage.perRadius *
  Math.sqrt(at(enc, attacker).body.biomass) *
  strikePower(at(enc, attacker)) *
  spread(enc, tick, attacker) *
  armour;

describe('strikes', () => {
  it('wind up for 8 ticks, hit for the formula, and wait 24 ticks before the next windup', () => {
    const enc = duel();
    const hits = run(enc, 3).filter((h) => h.kind === 'strike');
    const first = hits[0] as Hit;
    expect(first.tick).toBe(T0 + E.strike.windupTicks);
    expect(first).toMatchObject({ slot: 1, by: 0, blocked: false });
    expect(first.amount).toBeCloseTo(expectedStrike(enc, first.tick), 9);
    expect(at(enc, 1).body.health).toBeCloseTo(maxHealth(RULES.starter.biomass) - first.amount, 9);
    const second = run(enc, 20).find(isStrike) as Hit;
    expect(second.tick - first.tick).toBe(E.strike.windupTicks + E.strike.recoverTicks);
    expect(strikePower(at(enc, 0))).toBeCloseTo(E.damage.powerBase + E.damage.powerWeapon * 0.5, 9);
  });

  it('miss when the target leaves 1.1 x the reach during the windup, and the cooldown still runs', () => {
    const enc = duel();
    stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    expect(at(enc, 0).fx.windupEnd).toBe(T0 + E.strike.windupTicks);
    at(enc, 1).body.x += 200;
    const hits = run(enc, 4);
    expect(hits).toEqual([]);
    expect(at(enc, 1).body.health).toBe(maxHealth(RULES.starter.biomass));
    expect(at(enc, 0).fx.windupEnd).toBe(-1);
    expect(at(enc, 0).fx.readyTick).toBe(T0 + E.strike.windupTicks + E.strike.recoverTicks);
  });

  it('let two starters in contact nip each other by 0.3 x scale x r x (1 +- 0.1)', () => {
    const enc = calm(
      createEncounter(
        startOf('nip', [
          starterFighter('a', 3000, 3000),
          starterFighter('b', 3000 + 2 * R - 1, 3000, Math.PI),
        ]),
      ),
    );
    const hits = run(enc, 3).filter((h) => h.kind === 'strike');
    expect(hits.map((h) => [h.slot, h.by]).sort()).toEqual([
      [0, 1],
      [1, 0],
    ]);
    const base = E.damage.powerBase * E.damage.perRadius * R;
    for (const h of hits) {
      expect(h.amount).toBeGreaterThanOrEqual(base * (1 - E.damage.spread) - 1e-9);
      expect(h.amount).toBeLessThanOrEqual(base * (1 + E.damage.spread) + 1e-9);
      expect(h.amount).toBeCloseTo(base * spread(enc, h.tick, h.by), 9);
    }
  });

  it('deal twice the damage from four times the biomass', () => {
    const small = duel({ id: 'size' });
    const big = duel({
      id: 'size',
      hunter: hunterFighter('a', 3000, 3000, 0, 4 * RULES.starter.biomass),
    });
    const hit = (enc: Encounter) => run(enc, 3).find(isStrike) as Hit;
    expect(hit(big).amount).toBeCloseTo(2 * hit(small).amount, 9);
  });

  it('are cut 30% by armour 0.5, and 25.5% more precisely by an aggressive stance on the target', () => {
    const plain = duel({ id: 'arm' });
    const armoured = (stance: Stance) => {
      const enc = duel({
        id: 'arm',
        target: { combat: { ...STARTER_COMBAT, armour: 0.5 } },
      });
      return run(enc, 3, () => [IDLE_CODE, drive(0, 0, { stance })]).find(
        (h) => h.kind === 'strike',
      ) as Hit;
    };
    const full = run(plain, 3).find(isStrike) as Hit;
    expect(armoured('balanced').amount / full.amount).toBeCloseTo(0.7, 9);
    expect(armoured('aggressive').amount / full.amount).toBeCloseTo(1 - 0.6 * 0.5 * 0.85, 9);
  });
});

describe('targets', () => {
  it('fall back to the nearest opponent when the input is missing or names no one', () => {
    const start = [
      hunterFighter('a', 3000, 3000),
      starterFighter('b', 3300, 3000, Math.PI),
      starterFighter('c', 3000 + 1.2 * R + R, 3000, Math.PI),
    ];
    const aim = (code: number | null): number => {
      const enc = calm(createEncounter(startOf('aim', start)));
      stepFrame(enc, [code, IDLE_CODE, IDLE_CODE]);
      return at(enc, 0).fx.windupTarget;
    };
    expect(aim(null)).toBe(2);
    expect(aim(drive(0, 0))).toBe(2);
    expect(aim(drive(0, 0, { target: 0 }))).toBe(2);
  });
});

describe('stance', () => {
  it('lets an evasive fighter reach 1.2 x the balanced top speed', () => {
    const speed = (stance: Stance) => {
      const enc = calm(createEncounter(startOf('top', [starterFighter('a', 1000, 3000)])));
      for (let f = 0; f < 40; f++) stepFrame(enc, [drive(0, 15, { stance })]);
      const b = at(enc, 0).body;
      return Math.hypot(b.vx, b.vy);
    };
    const ratio = speed('evasive') / speed('balanced');
    expect(ratio).toBeGreaterThan(1.2 * 0.98);
    expect(ratio).toBeLessThan(1.2 * 1.02);
  });

  it('scales the damage dealt: x0.7 evasive, x1.25 aggressive', () => {
    const dealt = (stance: Stance) =>
      run(duel({ id: 'dealt' }), 3, () => [drive(0, 0, { stance }), IDLE_CODE]).find(
        (h) => h.kind === 'strike',
      ) as Hit;
    const base = dealt('balanced').amount;
    expect(dealt('evasive').amount / base).toBeCloseTo(0.7, 9);
    expect(dealt('aggressive').amount / base).toBeCloseTo(1.25, 9);
  });
});

describe('brace', () => {
  const braced = (frame: number, extra: Partial<FighterStart> = {}) => {
    const enc = duel({ id: 'brace', target: extra });
    const hit = run(enc, 3, (f) => [IDLE_CODE, drive(0, 0, { brace: f === frame })]).find(
      (h) => h.kind === 'strike',
    ) as Hit;
    return { enc, hit };
  };

  it('blocks 80% of a strike landing 1 to 8 ticks after it, and staggers the striker for 9 ticks', () => {
    const unbraced = run(duel({ id: 'brace' }), 3).find(isStrike) as Hit;
    for (const frame of [1, 2, 3]) {
      const { enc, hit } = braced(frame);
      expect(hit.blocked).toBe(true);
      expect(hit.amount).toBeCloseTo(unbraced.amount * (1 - E.brace.block), 9);
      expect(at(enc, 0).fx.staggerUntil).toBe(hit.tick + E.brace.staggerTicks);
    }
    const { enc } = braced(1);
    // The striker may not start a windup for 9 ticks, and starts none before its cooldown ends.
    expect(at(enc, 0).fx.windupEnd).toBe(-1);
  });

  it('does not block a strike landing 9 ticks after it', () => {
    const enc = duel({ id: 'late' });
    at(enc, 0).fx.windupEnd = T0 + E.brace.windowTicks + 1;
    at(enc, 0).fx.windupTarget = 1;
    const hits = run(enc, 4, (f) => [IDLE_CODE, drive(0, 0, { brace: f === 1 })]);
    expect(hits.find((h) => h.kind === 'strike')).toMatchObject({ tick: T0 + 9, blocked: false });
  });

  it('does nothing and costs nothing a second time within the cooldown, or without the energy', () => {
    const once = duel({ id: 'twice' });
    const twice = duel({ id: 'twice' });
    run(once, 8, (f) => [IDLE_CODE, drive(0, 0, { brace: f === 1 })]);
    run(twice, 8, (f) => [IDLE_CODE, drive(0, 0, { brace: f === 1 || f === 5 })]);
    expect(at(twice, 1).body.energy).toBe(at(once, 1).body.energy);
    expect(at(twice, 1).fx.braceReady).toBe(at(once, 1).fx.braceReady);
    expect(at(twice, 1).fx.braceReady).toBe(T0 + E.brace.cooldownTicks);

    const cost = E.brace.energyPerBiomass * RULES.starter.biomass;
    const dry = duel({ id: 'dry', target: { energy: cost - 0.5 } });
    const hits = run(dry, 3, (f) => [IDLE_CODE, drive(0, 0, { brace: f === 1 })]);
    expect(hits.find((h) => h.kind === 'strike')?.blocked).toBe(false);
    expect(at(dry, 1).fx.braceReady).toBe(0);
  });

  it('costs 0.05 x biomass in energy', () => {
    const idle = duel({ id: 'cost' });
    const bracing = duel({ id: 'cost' });
    run(idle, 1);
    run(bracing, 1, () => [IDLE_CODE, drive(0, 0, { brace: true })]);
    expect(at(idle, 1).body.energy - at(bracing, 1).body.energy).toBeCloseTo(
      E.brace.energyPerBiomass * RULES.starter.biomass,
      9,
    );
  });
});

describe('rams', () => {
  /** Two starters pressed together; `a` is given `speed` east at the start of a tick. */
  const pair = (id: string, extra: Partial<FighterStart> = {}) =>
    calm(
      createEncounter(
        startOf(id, [
          starterFighter('a', 3000, 3000),
          { ...starterFighter('b', 3000 + 2 * R - 0.5, 3000, Math.PI), ...extra },
        ]),
      ),
    );
  const rams = (hits: Hit[]) => hits.filter((h) => h.kind === 'ram');
  const afterDrag = (v: number) => v * (1 - RULES.movement.drag * DT);

  it('hurts the rammed body by the formula above 60 wu/s and not below it', () => {
    const fast = pair('ram');
    at(fast, 0).body.vx = 100;
    const [hit] = rams(run(fast, 1));
    const closing = afterDrag(100);
    const expected =
      E.ram.perRadius * R * Math.min(1, (closing - E.ram.minSpeed) / E.ram.speedSpan);
    expect(hit).toMatchObject({ slot: 1, by: 0, kind: 'ram' });
    expect(hit?.amount).toBeCloseTo(expected, 9);

    const slow = pair('ram');
    at(slow, 0).body.vx = 50;
    expect(rams(run(slow, 1))).toEqual([]);
  });

  it('takes the faster-closing fighter as the rammer, and cannot repeat within 24 ticks', () => {
    const enc = pair('ram-b');
    at(enc, 1).body.vx = -100;
    const first = rams(run(enc, 1));
    expect(first.map((h) => [h.slot, h.by])).toEqual([[0, 1]]);
    at(enc, 1).body.vx = -100;
    expect(rams(run(enc, 2))).toEqual([]);
    // 24 ticks after the first ram it can ram again.
    run(enc, 6);
    at(enc, 1).body.vx = -100;
    expect(rams(run(enc, 1)).length).toBe(1);
  });

  it('is blocked by a brace, which staggers the rammer and cancels its windup', () => {
    const enc = pair('ram-c');
    at(enc, 0).body.vx = 100;
    const hits = run(enc, 1, () => [IDLE_CODE, drive(0, 0, { brace: true })]);
    const hit = rams(hits)[0] as Hit;
    expect(hit.blocked).toBe(true);
    expect(at(enc, 0).fx.staggerUntil).toBe(T0 + E.brace.staggerTicks);
    expect(at(enc, 0).fx.windupEnd).toBe(-1);
    const free = pair('ram-c');
    at(free, 0).body.vx = 100;
    expect(hit.amount).toBeCloseTo((rams(run(free, 1))[0] as Hit).amount * (1 - E.brace.block), 9);
  });

  it('is weighed by mass share and cut by armour', () => {
    const heavy = pair('ram-m', { combat: { ...STARTER_COMBAT, mass: 3 } });
    const light = pair('ram-m', { combat: { ...STARTER_COMBAT, mass: 1 } });
    at(heavy, 1).body.vx = -100;
    at(light, 1).body.vx = -100;
    const h = rams(run(heavy, 1))[0] as Hit;
    const l = rams(run(light, 1))[0] as Hit;
    // The rammer (b) is heavier in `heavy`: share 3/4 against 1/2.
    expect(h.amount / l.amount).toBeCloseTo(1.5, 9);

    const plated = pair('ram-m', { combat: { ...STARTER_COMBAT, armour: 0.5 } });
    at(plated, 0).body.vx = 100;
    const plain = pair('ram-m');
    at(plain, 0).body.vx = 100;
    expect(
      (rams(run(plated, 1))[0] as Hit).amount / (rams(run(plain, 1))[0] as Hit).amount,
    ).toBeCloseTo(0.7, 9);
  });
});

describe('spines', () => {
  it('return 40% of a strike to the striker, as damage from the target', () => {
    const enc = duel({ id: 'spines', target: { combat: { ...STARTER_COMBAT, spines: 1 } } });
    const hits = run(enc, 3);
    const strike = hits.find(isStrike) as Hit;
    const back = hits.find((h) => h.kind === 'spines') as Hit;
    expect(back).toMatchObject({ slot: 0, by: 1 });
    expect(back.amount).toBeCloseTo(E.spineReturn * strike.amount, 9);
    expect(at(enc, 0).body.health).toBeCloseTo(maxHealth(RULES.starter.biomass) - back.amount, 9);
  });

  it('return nothing from a fully blocked hit and are not returned in turn', () => {
    const enc = duel({ id: 'spines-b', target: { combat: { ...STARTER_COMBAT, spines: 1 } } });
    const hits = run(enc, 3, (f) => [IDLE_CODE, drive(0, 0, { brace: f === 1 })]);
    const strike = hits.find(isStrike) as Hit;
    const back = hits.find((h) => h.kind === 'spines') as Hit;
    expect(back.amount).toBeCloseTo(E.spineReturn * strike.amount, 9);
    expect(hits.filter((h) => h.kind === 'spines').length).toBe(1);
  });
});

describe('kills', () => {
  const kill = (
    victim: Partial<FighterStart>,
    hunter: Partial<FighterStart> = {},
    id = 'kill',
  ): Encounter => {
    const enc = duel({ id, hunter, target: { health: 1, ...victim } });
    run(enc, 3);
    return enc;
  };

  it('name the killer, end the fight and carry the victim biomass', () => {
    const enc = kill({});
    expect(results(enc)[1]).toMatchObject({
      outcome: 'killed',
      cause: 'killed',
      by: 0,
      biomass: RULES.starter.biomass,
    });
    expect(results(enc)[0]?.outcome).toBe('stood');
    expect(enc.over).toBe(true);
    expect(at(enc, 1).body.alive).toBe(false);
    expect(at(enc, 1).body.health).toBe(0);
  });

  it('grow the killer by 0.4 x the victim biomass, and its health with the radius', () => {
    const enc = kill({});
    const b = at(enc, 0).body;
    const gain = E.reward.share * RULES.starter.biomass;
    expect(b.biomass).toBeCloseTo(RULES.starter.biomass + gain, 9);
    expect(b.health).toBeCloseTo(
      maxHealth(RULES.starter.biomass) +
        RULES.creature.healthPerRadius * (Math.sqrt(b.biomass) - R),
      9,
    );
  });

  it('halve the reward for a smaller victim and raise it by half for a bigger one', () => {
    const bigPhys = { ...STARTER_PHYS, maxBiomass: 5000 };
    const small = kill({}, { biomass: 2000, energy: 0, phys: bigPhys });
    expect(sizeTier(2000)).toBe(1);
    expect(at(small, 0).body.biomass).toBeCloseTo(
      2000 + E.reward.share * RULES.starter.biomass * E.reward.smallerTier,
      9,
    );

    expect(at(small, 0).reward).toBeCloseTo(
      E.reward.share * RULES.starter.biomass * E.reward.smallerTier,
      9,
    );
    expect(at(small, 1).reward).toBe(0);

    const victim = { biomass: 1100, health: 1 };
    const big = kill(victim, { energy: 0, phys: bigPhys });
    expect(at(big, 0).body.biomass).toBeCloseTo(
      RULES.starter.biomass + E.reward.share * 1100 * E.reward.biggerTier,
      9,
    );
  });

  it('turn the overflow past the maximum biomass into energy at 3 per unit', () => {
    const phys = { ...STARTER_PHYS, maxBiomass: RULES.starter.biomass + 1 };
    const enc = kill({}, { phys, energy: 0 });
    const b = at(enc, 0).body;
    expect(b.biomass).toBeCloseTo(RULES.starter.biomass + 1, 9);
    const overflow = E.reward.share * RULES.starter.biomass - 1;
    // The tally the authority records counts the whole reward, the overflow included.
    expect(at(enc, 0).reward).toBeCloseTo(E.reward.share * RULES.starter.biomass, 9);
    expect(b.energy).toBeGreaterThan(0);
    expect(b.energy).toBeLessThanOrEqual(maxEnergy(b.biomass));
    expect(b.energy).toBeCloseTo(
      Math.min(maxEnergy(b.biomass), overflow * E.reward.energyPerBiomass),
      1,
    );
  });

  it('name a killer by spines when the striker dies of its own blow', () => {
    const enc = duel({
      id: 'spiked',
      hunter: { health: 0.5 },
      target: { combat: { ...STARTER_COMBAT, spines: 1 } },
    });
    run(enc, 3);
    expect(results(enc)[0]).toMatchObject({ outcome: 'killed', by: 1 });
    expect(results(enc)[1]?.outcome).toBe('stood');
  });
});

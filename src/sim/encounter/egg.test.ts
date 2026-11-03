import { describe, expect, it } from 'vitest';
import { drive, IDLE_CODE, starterFighter, startOf } from '../../../tests/encounter-fixture';
import { STARTER_COMBAT } from '../body';
import { RULES } from '../rules';
import { maxHealth } from '../vitals';
import { EGG_CODE, eggRest } from './egg';
import { createEncounter, hashEncounter, results, stepFrame } from './encounter';
import { spread } from './strike';
import type { Encounter, EncounterEvent, Fighter, FighterStart } from './types';

const E = RULES.encounter;
const R = Math.sqrt(RULES.starter.biomass);
const at = (enc: Encounter, slot: number) => enc.fighters[slot] as Encounter['fighters'][number];
type Hit = Extract<EncounterEvent, { type: 'hit' }>;
const eggHits = (events: EncounterEvent[]): Hit[] =>
  events.filter((e): e is Hit => e.type === 'hit' && e.egg);

const calm = (enc: Encounter) => {
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
};

/**
 * The attacker (slot 0, "a") sits west of the carrier (slot 1, "b"), both facing east, so that the
 * carrier's egg trails between them, `gap` radii of the attacker from the egg's edge.
 */
function chase(
  opts: { attacker?: Partial<FighterStart>; carrier?: Partial<FighterStart>; gap?: number } = {},
): Encounter {
  const attacker = { ...starterFighter('a', 3000, 3000), ...opts.attacker };
  const carrier = { ...starterFighter('b', 0, 3000), egg: true, ...opts.carrier };
  const rb = Math.sqrt(carrier.biomass);
  const ra = Math.sqrt(attacker.biomass);
  carrier.x = 3000 + (opts.gap ?? 0.5) * ra + (1 + E.egg.gap + 2 * E.egg.radius) * rb;
  return calm(createEncounter(startOf('egg', [attacker, carrier])));
}

/** Steps `frames` frames; the attacker aims at the carrier's egg unless `target` says otherwise. */
function run(
  enc: Encounter,
  frames: number,
  inputs: (frame: number) => (number | null)[] = () => [
    drive(0, 0, { target: EGG_CODE + 1 }),
    IDLE_CODE,
  ],
): EncounterEvent[] {
  const out: EncounterEvent[] = [];
  for (let f = 1; f <= frames; f++) out.push(...stepFrame(enc, inputs(f)));
  return out;
}

describe('the egg in the fight', () => {
  it('rests straight behind a still carrier and has a quarter of its health', () => {
    const enc = chase({ gap: 3 });
    const egg = at(enc, 1).eggBody;
    expect(egg).not.toBeNull();
    const b = at(enc, 1).body;
    expect(egg?.x).toBeCloseTo(b.x - eggRest(at(enc, 1)), 9);
    expect(egg?.y).toBeCloseTo(b.y, 9);
    expect(egg?.radius).toBeCloseTo(E.egg.radius * R, 9);
    expect(egg?.health).toBeCloseTo(E.egg.healthShare * maxHealth(RULES.starter.biomass), 9);
    expect(eggRest(at(enc, 1))).toBeCloseTo(R * (1 + E.egg.gap + E.egg.radius), 9);
    run(enc, 10, () => [IDLE_CODE, IDLE_CODE]);
    expect(at(enc, 1).eggBody?.x).toBeCloseTo(b.x - eggRest(at(enc, 1)), 6);
  });

  it('is only carried by a fighter whose start has an egg', () => {
    expect(at(chase({ carrier: { egg: false } }), 1).eggBody).toBeNull();
  });

  it('stays within 1.5 x its rest distance of a carrier swimming at full speed', () => {
    const enc = chase({ gap: 40 });
    const carrier = at(enc, 1);
    let widest = 0;
    for (let f = 0; f < 40; f++) {
      stepFrame(enc, [IDLE_CODE, drive(0, 15)]);
      const egg = carrier.eggBody as NonNullable<typeof carrier.eggBody>;
      widest = Math.max(widest, Math.hypot(carrier.body.x - egg.x, carrier.body.y - egg.y));
    }
    expect(Math.hypot(carrier.body.vx, carrier.body.vy)).toBeGreaterThan(0);
    expect(widest).toBeLessThanOrEqual(1.5 * eggRest(carrier));
  });
});

describe('striking the egg', () => {
  it("breaks after ceil(egg health / nip) of an equal starter's nips and feeds the eater", () => {
    const enc = chase();
    const carrier = at(enc, 1);
    const health = (carrier.eggBody as NonNullable<typeof carrier.eggBody>).health;
    const before = at(enc, 0).body.biomass;
    const hits: Hit[] = [];
    let eaten: EncounterEvent[] = [];
    for (let f = 0; f < 120 && eaten.length === 0; f++) {
      const out = run(enc, 1);
      hits.push(...eggHits(out));
      eaten = out.filter((e) => e.type === 'egg');
    }
    const nip = E.damage.powerBase * E.damage.perRadius * R;
    expect(hits.every((h) => h.slot === 1 && h.by === 0 && h.kind === 'strike')).toBe(true);
    // At the pinned variation each nip is nip x spread(tick); the egg breaks on the first hit that
    // brings the total to its health, within one hit of the nominal ceil(health / nip).
    let total = 0;
    let needed = 0;
    for (const h of hits) {
      expect(h.amount).toBeCloseTo(nip * spread(enc, h.tick, 0), 9);
      total += h.amount;
      if (total < health) needed++;
    }
    expect(hits.length).toBe(needed + 1);
    expect(Math.abs(hits.length - Math.ceil(health / nip))).toBeLessThanOrEqual(1);
    expect(eaten).toEqual([{ type: 'egg', slot: 1, by: 0 }]);
    expect(carrier.body.health).toBe(maxHealth(RULES.starter.biomass));
    expect(at(enc, 0).body.biomass - before).toBeCloseTo(E.egg.eatShare * RULES.starter.biomass, 9);
    expect(carrier.eggBody?.by).toBe(0);
  });

  it('is blocked 80% by the carrier’s brace, which staggers the striker', () => {
    const plain = chase();
    const first = eggHits(run(plain, 3))[0] as Hit;
    const braced = chase();
    const out = eggHits(
      run(braced, 3, () => [drive(0, 0, { target: EGG_CODE + 1 }), drive(0, 0, { brace: true })]),
    );
    const hit = out[0] as Hit;
    expect(hit.blocked).toBe(true);
    expect(hit.amount).toBeCloseTo(first.amount * (1 - E.brace.block), 9);
    expect(at(braced, 0).fx.staggerUntil).toBe(hit.tick + E.brace.staggerTicks);
  });

  it('never involves spines: a spined carrier does not hurt the egg’s striker', () => {
    const enc = chase({ carrier: { combat: { ...STARTER_COMBAT, spines: 1 } } });
    run(enc, 3);
    expect(at(enc, 0).body.health).toBe(maxHealth(RULES.starter.biomass));
  });

  it('is ignored by the code of an absent egg or an own egg: the nearest opponent is aimed at', () => {
    const noEgg = chase({ carrier: { egg: false }, gap: 0.5 });
    at(noEgg, 1).body.x = at(noEgg, 0).body.x + 2 * R - 1;
    run(noEgg, 1);
    expect(at(noEgg, 0).fx.windupTarget).toBe(1);
    const own = chase({ attacker: { egg: true } });
    run(own, 1, () => [drive(0, 0, { target: EGG_CODE }), IDLE_CODE]);
    expect(at(own, 0).fx.windupTarget).not.toBe(EGG_CODE);
  });

  it('falls back to the nearest opponent once the egg is eaten', () => {
    const enc = chase();
    run(enc, 120);
    expect(at(enc, 1).eggBody?.by).toBe(0);
    at(enc, 1).body.x = at(enc, 0).body.x + 2 * R - 1;
    at(enc, 0).fx.windupEnd = -1;
    at(enc, 0).fx.readyTick = 0;
    run(enc, 1);
    expect(at(enc, 0).fx.windupTarget).toBe(1);
  });
});

describe('the egg at the end of the fight', () => {
  /** The hunter kills the carrier (3 hp) at once and eats its egg with it. */
  it('is eaten by the killer with its carrier, and both rewards are paid', () => {
    const enc = chase({ carrier: { health: 1 }, gap: 0.5 });
    at(enc, 1).body.x = at(enc, 0).body.x + 2 * R - 1;
    const before = at(enc, 0).body.biomass;
    run(enc, 3, () => [drive(0, 0, { target: 1 }), IDLE_CODE]);
    const [a, b] = results(enc);
    expect(b).toMatchObject({ outcome: 'killed', by: 0, egg: 'eaten', eggBy: 0 });
    expect(a?.egg).toBe('none');
    const gain = at(enc, 0).body.biomass - before;
    expect(gain).toBeCloseTo((E.reward.share + E.egg.eatShare) * RULES.starter.biomass, 9);
  });

  it('is kept when the carrier stands at the timeout', () => {
    const enc = chase({ gap: 10 });
    run(enc, E.timeoutFrames, () => [IDLE_CODE, IDLE_CODE]);
    expect(results(enc)[1]).toMatchObject({ outcome: 'stood', egg: 'kept', eggBy: null });
  });

  it('is kept when the carrier escapes', () => {
    const enc = chase({ gap: 10 });
    for (let f = 0; f < 80 && !enc.over; f++) stepFrame(enc, [IDLE_CODE, drive(0, 15)]);
    expect(results(enc)[1]).toMatchObject({ outcome: 'escaped', egg: 'kept', eggBy: null });
  });

  it('is kept when the carrier dies of a hazard', () => {
    const enc = chase({ carrier: { health: 0 }, gap: 10 });
    enc.world.options.hazards = true;
    at(enc, 1).body.energy = 0;
    for (let f = 0; f < 200 && at(enc, 1).status === 'in'; f++)
      stepFrame(enc, [IDLE_CODE, IDLE_CODE]);
    expect(results(enc)[1]).toMatchObject({ outcome: 'died', egg: 'kept', eggBy: null });
  });

  it('hashes the egg, so a different egg state is a different fight', () => {
    const a = chase();
    const b = chase();
    expect(hashEncounter(a)).toBe(hashEncounter(b));
    (at(b, 1).eggBody as NonNullable<Fighter['eggBody']>).health -= 1;
    expect(hashEncounter(a)).not.toBe(hashEncounter(b));
  });
});

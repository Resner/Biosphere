import { describe, expect, it } from 'vitest';
import {
  CALM,
  hunterFighter,
  IDLE_CODE,
  starterFighter,
  startOf,
} from '../../../tests/encounter-fixture';
import { heavyTest } from '../../../tests/heavy';
import { STARTER_COMBAT } from '../body';
import { createRng, seedFromString } from '../prng';
import { RULES } from '../rules';
import { maxEnergy, maxHealth } from '../vitals';
import { autopilot } from './autopilot';
import { TARGET_PREFS } from './behaviour';
import { encodeFrameInput } from './codec';
import { EGG_CODE } from './egg';
import { createEncounter, hashEncounter, stepFrame } from './encounter';
import { strikeDistance } from './reach';
import type {
  Behaviour,
  Encounter,
  EncounterEvent,
  Fighter,
  FighterStart,
  TargetPref,
} from './types';

const E = RULES.encounter;
const B = RULES.starter.biomass;
const at = (enc: Encounter, slot: number) => enc.fighters[slot] as Encounter['fighters'][number];
const calm = (enc: Encounter) => {
  enc.world.options.currents = false;
  enc.world.options.hazards = false;
  return enc;
};
const gene = (over: Partial<Behaviour>): Behaviour => ({ ...CALM, ...over });

describe('autopilot', () => {
  heavyTest('never throws and stays deterministic over 1,000 random encounter states', () => {
    const rng = createRng(seedFromString('autopilot-states'), 'states');
    for (let n = 0; n < 1000; n++) {
      const count = rng.int(1, 4);
      const fighters: FighterStart[] = [];
      for (let k = 0; k < count; k++) {
        const biomass = rng.range(B * 0.5, B * 4);
        const base = starterFighter(
          `f${k}`,
          rng.range(3000, 3300),
          rng.range(3000, 3300),
          0,
          biomass,
        );
        fighters.push({
          ...base,
          heading: rng.range(-3.2, 3.2),
          health: rng.range(0.01, 1) * maxHealth(biomass),
          energy: rng.range(0, 1) * maxEnergy(biomass),
          egg: rng.next() < 0.4,
          combat: {
            ...STARTER_COMBAT,
            reach: rng.range(0.5, 2),
            arc: rng.range(0, 2),
            power: rng.next(),
          },
          behaviour: gene({
            aggression: rng.next(),
            caution: rng.next(),
            curiosity: rng.next(),
            reflex: rng.next(),
            targetPref: TARGET_PREFS[rng.int(0, 3)] as TargetPref,
          }),
        });
      }
      const enc = createEncounter(startOf(`rand-${n}`, fighters));
      for (const f of enc.fighters) {
        f.fx.windupEnd = rng.next() < 0.5 ? -1 : enc.world.tick + rng.int(0, 10);
        f.fx.windupTarget = rng.int(0, 7);
        f.fx.braceReady = rng.int(0, enc.world.tick + 80);
        f.body.dashReadyTick = rng.int(0, enc.world.tick + 80);
        if (rng.next() < 0.15) f.status = 'killed';
        if (f.eggBody !== null && rng.next() < 0.3) f.eggBody.by = rng.int(0, 3);
      }
      const copy = structuredClone(enc);
      for (const f of enc.fighters) {
        const input = autopilot(enc, f.slot);
        expect(() => encodeFrameInput(input)).not.toThrow();
        expect(autopilot(copy, f.slot)).toEqual(input);
        expect(autopilot(enc, f.slot)).toEqual(input);
      }
      expect(hashEncounter(enc)).toBe(hashEncounter(copy));
    }
  });

  it('flies a frame of nulls exactly as its own encoded inputs', () => {
    const start = startOf('autopilot-null', [
      hunterFighter('a', 3000, 3000),
      { ...starterFighter('b', 3090, 3000, Math.PI), egg: true },
      starterFighter('c', 3000, 3120, -Math.PI / 2),
    ]);
    const viaNull = createEncounter(start);
    const viaCodes = createEncounter(start);
    for (let f = 0; f < 60; f++) {
      const codes = viaCodes.fighters.map((x) =>
        x.status === 'in' ? encodeFrameInput(autopilot(viaCodes, x.slot)) : null,
      );
      stepFrame(viaNull, [null, null, null]);
      stepFrame(viaCodes, codes);
      expect(hashEncounter(viaNull)).toBe(hashEncounter(viaCodes));
    }
  });

  it('strikes an idle target in range within 40 frames at aggression 1', () => {
    const enc = calm(
      createEncounter(
        startOf('autopilot-strike', [
          { ...hunterFighter('a', 3000, 3000), behaviour: gene({ aggression: 1 }) },
          starterFighter('b', 3080, 3000, Math.PI),
        ]),
      ),
    );
    let struck = -1;
    for (let f = 1; f <= 40 && struck < 0; f++) {
      const events: EncounterEvent[] = stepFrame(enc, [null, IDLE_CODE]);
      if (events.some((e) => e.type === 'hit' && e.kind === 'strike' && e.by === 0)) struck = f;
    }
    expect(struck).toBeGreaterThan(0);
  });

  describe('fleeing', () => {
    const fleeing = (reflex: number) =>
      calm(
        createEncounter(
          startOf('autopilot-flee', [
            {
              ...starterFighter('a', 3000, 3000),
              health: 0.3 * maxHealth(B),
              behaviour: gene({ caution: 1, reflex }),
            },
            hunterFighter('b', 3030, 3000, Math.PI),
          ]),
        ),
      );

    it('moves away in evasive stance at caution 1 and 30% health', () => {
      const enc = fleeing(0);
      expect(autopilot(enc, 0)).toMatchObject({ stance: 'evasive', throttle: 15, dash: false });
      const before = strikeDistance(at(enc, 0).body, at(enc, 1).body);
      for (let f = 0; f < 10; f++) stepFrame(enc, [null, IDLE_CODE]);
      expect(strikeDistance(at(enc, 0).body, at(enc, 1).body)).toBeGreaterThan(before);
    });

    it('dashes while fleeing at reflex 1 but not at reflex 0', () => {
      expect(autopilot(fleeing(1), 0).dash).toBe(true);
      expect(autopilot(fleeing(0), 0).dash).toBe(false);
    });

    it('flees a body over 1.5 x its biomass only at caution above 0.5', () => {
      const big = (caution: number) =>
        autopilot(
          createEncounter(
            startOf('autopilot-big', [
              { ...starterFighter('a', 3000, 3000), behaviour: gene({ caution }) },
              starterFighter('b', 3060, 3000, Math.PI, B * 1.6),
            ]),
          ),
          0,
        );
      expect(big(0.8).stance).toBe('evasive');
      expect(big(0.8).throttle).toBe(15);
      expect(big(0.4).target).toBe(1);
      expect(big(0.8).steer).not.toBe(big(0.4).steer);
    });
  });

  describe('bracing', () => {
    const windup = (reflex: number, target: number, left = 5) => {
      const enc = createEncounter(
        startOf('autopilot-brace', [
          { ...starterFighter('a', 3000, 3000), egg: true, behaviour: gene({ reflex }) },
          hunterFighter('b', 3030, 3000, Math.PI),
        ]),
      );
      at(enc, 1).fx.windupEnd = enc.world.tick + left;
      at(enc, 1).fx.windupTarget = target;
      return enc;
    };

    it('braces at reflex 1 against a windup aimed at it or its egg, never at reflex 0', () => {
      expect(autopilot(windup(1, 0), 0).brace).toBe(true);
      expect(autopilot(windup(1, EGG_CODE), 0).brace).toBe(true);
      expect(autopilot(windup(0, 0), 0).brace).toBe(false);
    });

    it('waits for the last 6 ticks, an aim at it, a ready brace and the energy', () => {
      expect(autopilot(windup(1, 0, 7), 0).brace).toBe(false);
      expect(autopilot(windup(1, 1), 0).brace).toBe(false);
      const eaten = windup(1, EGG_CODE);
      (at(eaten, 0).eggBody as NonNullable<Fighter['eggBody']>).by = 1;
      expect(autopilot(eaten, 0).brace).toBe(false);
      const cooling = windup(1, 0);
      at(cooling, 0).fx.braceReady = cooling.world.tick + 1;
      expect(autopilot(cooling, 0).brace).toBe(false);
      const spent = windup(1, 0);
      at(spent, 0).body.energy = 0;
      expect(autopilot(spent, 0).brace).toBe(false);
    });
  });

  describe('target preference', () => {
    // a (slot 0) at the origin; b (1) is close and armed, c (2) is big and far, d (3) is hurt,
    // closest and carries an egg that is weaker than d itself.
    const pick = (targetPref: TargetPref): number => {
      const enc = createEncounter(
        startOf('autopilot-prefs', [
          { ...starterFighter('a', 3000, 3000), behaviour: gene({ targetPref, aggression: 0.5 }) },
          {
            ...starterFighter('b', 3070, 3000, Math.PI),
            combat: { ...STARTER_COMBAT, power: 1 },
          },
          starterFighter('c', 3000, 3400, -Math.PI / 2, B * 2),
          {
            ...starterFighter('d', 2950, 3000),
            egg: true,
            health: 0.4 * maxHealth(B),
          },
        ]),
      );
      return autopilot(enc, 0).target;
    };

    it('picks the expected target for each preference', () => {
      expect(pick('nearest')).toBe(3);
      expect(pick('weakest')).toBe(EGG_CODE + 3);
      expect(pick('largest')).toBe(2);
      expect(pick('strongest')).toBe(1);
    });

    it('gives ties to the lower slot, then the body', () => {
      const enc = createEncounter(
        startOf('autopilot-ties', [
          { ...starterFighter('a', 3000, 3000), behaviour: gene({ targetPref: 'largest' }) },
          starterFighter('b', 3060, 3000, Math.PI),
          starterFighter('c', 3000, 3060, -Math.PI / 2),
        ]),
      );
      expect(autopilot(enc, 0).target).toBe(1);
    });
  });

  it('circles by curiosity and closes in at full throttle from beyond 0.8 x the reach', () => {
    const steer = (curiosity: number) =>
      autopilot(
        createEncounter(
          startOf('autopilot-circle', [
            { ...starterFighter('a', 3000, 3000), behaviour: gene({ curiosity }) },
            starterFighter('b', 3300, 3000, Math.PI),
          ]),
        ),
        0,
      );
    expect(steer(0.5).steer).toBe(0);
    expect(steer(1).steer).toBeGreaterThan(0);
    expect(steer(1).steer).toBeLessThan(128);
    expect(steer(0).steer).toBeGreaterThan(128);
    expect(steer(0.5).throttle).toBe(15);
  });

  it('idles without opponents and never dashes in unless aggressive', () => {
    const alone = createEncounter(startOf('autopilot-alone', [starterFighter('a', 3000, 3000)]));
    expect(autopilot(alone, 0)).toMatchObject({ throttle: 0, dash: false, brace: false });
    const gap = (aggression: number) =>
      autopilot(
        createEncounter(
          startOf('autopilot-dash', [
            { ...hunterFighter('a', 3000, 3000), behaviour: gene({ aggression }) },
            starterFighter('b', 3030, 3000, Math.PI),
          ]),
        ),
        0,
      );
    // The target sits between 1 x and 2 x the reach away.
    expect(gap(0.5).dash).toBe(true);
    expect(gap(0.4).dash).toBe(false);
  });

  it('runs an all-autopilot duel to a verdict', () => {
    const enc = createEncounter(
      startOf('autopilot-duel', [
        { ...hunterFighter('a', 3000, 3000), behaviour: gene({ aggression: 0.9 }) },
        {
          ...hunterFighter('b', 3200, 3000, Math.PI),
          behaviour: gene({ aggression: 0.7, caution: 0.2 }),
        },
      ]),
    );
    for (let f = 0; f < E.timeoutFrames && !enc.over; f++) stepFrame(enc, [null, null]);
    expect(enc.over).toBe(true);
    expect(enc.fighters.some((f) => f.status === 'killed')).toBe(true);
  });
});

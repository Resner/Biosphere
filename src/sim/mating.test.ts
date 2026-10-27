import { describe, expect, it } from 'vitest';
import {
  cooldownMs,
  hatchling,
  type MateRefusal,
  type MateView,
  mateCost,
  ownRefusal,
  pairRefusal,
} from './mating';
import { RULES } from './rules';

const GOOD: MateView = {
  creature: 'c1',
  owner: 'p1',
  active: true,
  activeMs: 1_000_000,
  matureAtMs: 900_000,
  cooldownUntilMs: 0,
  biomass: 500,
  energy: 600,
  hasPending: false,
  inFlight: false,
  locked: false,
};
const view = (over: Partial<MateView> = {}): MateView => ({ ...GOOD, ...over });

describe('RULES.mating', () => {
  it('holds the frozen numbers', () => {
    expect(RULES.mating).toEqual({
      costEnergy: 0.3,
      costBiomass: 0.15,
      minEnergyShare: 0.5,
      cooldownMs: 360_000,
      repeatWindowMs: 86_400_000,
      repeatMaxDoublings: 5,
      acceptShownMs: 15_000,
      signWindowMs: 20_000,
      tierSpread: 1,
      reachBodies: 3,
      hatchlingMinBiomass: 80,
      hatchlingShare: 0.1,
      hatchlingEnergyShare: 0.6,
      restoreMinMs: 120_000,
    });
  });
});

describe('mateCost', () => {
  it('leaves 85% of the biomass and 70% of the energy', () => {
    expect(mateCost(500, 800)).toEqual({ biomass: 425, energy: 560 });
  });
});

describe('cooldownMs', () => {
  it('starts at 6 minutes and doubles per earlier mating, up to five doublings', () => {
    expect(cooldownMs(0)).toBe(360_000);
    expect(cooldownMs(1)).toBe(720_000);
    expect(cooldownMs(2)).toBe(1_440_000);
    expect(cooldownMs(5)).toBe(11_520_000);
    expect(cooldownMs(6)).toBe(11_520_000);
    expect(cooldownMs(40)).toBe(11_520_000);
  });
});

describe('ownRefusal', () => {
  it('accepts a mature, rested creature', () => {
    expect(ownRefusal(view())).toBeNull();
  });

  it('names each reason when it is the only failing check', () => {
    const cases: [MateRefusal, Partial<MateView>][] = [
      ['not-active', { active: false }],
      ['locked', { locked: true }],
      ['in-flight', { inFlight: true }],
      ['pending', { hasPending: true }],
      ['not-mature', { activeMs: 899_999 }],
      ['cooldown', { cooldownUntilMs: 1_000_001 }],
      ['low-energy', { energy: 499 }],
    ];
    for (const [reason, over] of cases) expect(ownRefusal(view(over)), reason).toBe(reason);
  });

  it('pins the boundaries at exactly each limit', () => {
    expect(ownRefusal(view({ activeMs: 900_000 }))).toBeNull();
    expect(ownRefusal(view({ cooldownUntilMs: 1_000_000 }))).toBeNull();
    expect(ownRefusal(view({ energy: 500 }))).toBeNull();
  });

  it('reports the first failing check in the documented order', () => {
    // Each step fixes the check that was just reported, so the next one shows.
    const steps: [MateRefusal | null, Partial<MateView>][] = [
      ['not-active', { active: true }],
      ['locked', { locked: false }],
      ['in-flight', { inFlight: false }],
      ['pending', { hasPending: false }],
      ['not-mature', { activeMs: 1_000_000 }],
      ['cooldown', { cooldownUntilMs: 0 }],
      ['low-energy', { energy: 600 }],
      [null, {}],
    ];
    let v = view({
      active: false,
      locked: true,
      inFlight: true,
      hasPending: true,
      activeMs: 0,
      cooldownUntilMs: 9e9,
      energy: 0,
    });
    for (const [reason, fix] of steps) {
      expect(ownRefusal(v)).toBe(reason);
      v = { ...v, ...fix };
    }
  });
});

describe('pairRefusal', () => {
  it('refuses the same owner', () => {
    expect(pairRefusal(view(), view({ creature: 'c2' }))).toBe('self');
  });

  it('allows neighbouring size tiers and refuses two apart, whichever way round', () => {
    const rows: [number, number, MateRefusal | null][] = [
      [1000, 1100, null], // T0 and T1
      [500, 20_000, 'tier'], // T0 and T2
      [20_000, 500, 'tier'],
      // The tier edges at 1,024 and 16,384 biomass.
      [1023, 16_383, null],
      [1023, 16_384, 'tier'],
      [1024, 16_384, null],
      [1023, 1024, null],
    ];
    for (const [a, b, expected] of rows)
      expect(
        pairRefusal(view({ biomass: a }), view({ owner: 'p2', biomass: b })),
        `${a} ${b}`,
      ).toBe(expected);
  });
});

describe('hatchling', () => {
  it('is 80 biomass or a tenth of the maximum, with 60% of the maximum energy', () => {
    expect(hatchling(300)).toEqual({ biomass: 80, energy: 96 });
    expect(hatchling(800)).toEqual({ biomass: 80, energy: 96 });
    expect(hatchling(1000)).toEqual({ biomass: 100, energy: 120 });
    expect(hatchling(2_457_600)).toEqual({ biomass: 245_760, energy: 294_912 });
  });
});

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
  maxEnergy: 1000,
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
    const everything = view({
      active: false,
      locked: true,
      inFlight: true,
      hasPending: true,
      activeMs: 0,
      cooldownUntilMs: 9e9,
      energy: 0,
    });
    const order: MateRefusal[] = [
      'not-active',
      'locked',
      'in-flight',
      'pending',
      'not-mature',
      'cooldown',
      'low-energy',
    ];
    const over: Partial<MateView> = { ...everything };
    const fixes: Partial<MateView>[] = [
      { active: true },
      { locked: false },
      { inFlight: false },
      { hasPending: false },
      { activeMs: 1_000_000 },
      { cooldownUntilMs: 0 },
    ];
    for (let i = 0; i < order.length; i++) {
      expect(ownRefusal(view(over))).toBe(order[i]);
      Object.assign(over, fixes[i]);
    }
    expect(ownRefusal(view({ ...over, energy: 600 }))).toBeNull();
  });
});

describe('pairRefusal', () => {
  it('refuses the same owner', () => {
    expect(pairRefusal(view(), view({ creature: 'c2' }))).toBe('self');
  });

  it('allows neighbouring size tiers and refuses two apart', () => {
    const at = (biomass: number) => view({ owner: 'p2', biomass });
    expect(pairRefusal(view({ biomass: 1000 }), at(1100))).toBeNull(); // T0 and T1
    expect(pairRefusal(view({ biomass: 500 }), at(20_000))).toBe('tier'); // T0 vs T2
    expect(pairRefusal(at(20_000), view({ biomass: 500 }))).toBe('tier');
  });

  it('pins the tier boundaries at 1,024 and 16,384 biomass', () => {
    const at = (biomass: number) => view({ owner: 'p2', biomass });
    expect(pairRefusal(view({ biomass: 1023 }), at(16_383))).toBeNull();
    expect(pairRefusal(view({ biomass: 1023 }), at(16_384))).toBe('tier');
    expect(pairRefusal(view({ biomass: 1024 }), at(16_384))).toBeNull();
    expect(pairRefusal(view({ biomass: 1023 }), at(1024))).toBeNull();
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

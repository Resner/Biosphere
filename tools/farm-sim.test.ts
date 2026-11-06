import { describe, expect, it } from 'vitest';
import { RULES } from '../src/sim/rules';
import { heavyTest } from '../tests/heavy';
import {
  dutyShare,
  FARM_SIZES,
  farmReport,
  gatesOf,
  HONEST_GAIN_PER_MIN,
  HONEST_WITNESSES,
  type KillLog,
  type LifeLog,
  type Measure,
  MIN,
  overheadMs,
} from './farm-sim';
import { forageGainPerMinute } from './pacing-report';

const life = (startedAt: number, waited = 0): LifeLog => ({
  startedAt,
  matureAtMs: 8 * MIN,
  readyAfterMs: 8 * MIN + waited,
  matedAtMs: 8 * MIN + waited,
  children: 1,
});
const kill = (victim: number, worth: number, playMs = 30 * MIN, size = 300): KillLog => ({
  victim,
  atMs: 40 * MIN,
  victimPlayMs: playMs,
  worth,
  victimBiomass: size,
  reward: 0.4 * size * worth,
  carrion: 0.4 * size * worth,
});
const honest: Measure = {
  name: 'honest',
  bots: 1,
  hours: 1,
  gen3AtMs: 27 * MIN,
  lives: [life(0, 10_000), life(8 * MIN), life(16 * MIN, 20_000)],
  kills: [],
  children: 6,
  rare: 0,
  rarityBits: 12,
  maxSizeAtMs: 5 * MIN,
  eligibility: null,
};
const farm: Measure = {
  ...honest,
  name: 'farm-4',
  bots: 4,
  hours: 3,
  gen3AtMs: 25 * MIN,
  lives: [life(0, 10_000), life(8 * MIN, 10_000), life(16 * MIN, 10_000)],
  kills: [kill(0, 1), kill(1, 1), kill(0, 0.5), kill(4, 0.5, 10 * MIN, 280)],
  eligibility: { before: 0, after: 4 },
};
const failing = (m: Measure) =>
  gatesOf(m, honest)
    .filter((g) => !g.ok)
    .map((g) => g.n);

describe('the gates', () => {
  it('hold for a farm that is held by the rules', () => {
    expect(failing(farm)).toEqual([]);
  });

  it('1: fail for a lineage faster than its creatures’ time gates, or than 3 × the maturity minimum', () => {
    expect(failing({ ...farm, gen3AtMs: 20 * MIN })).toEqual([1]);
    expect(failing({ ...farm, gen3AtMs: null })).toEqual([1]);
    const quick = { ...farm, lives: farm.lives.map((l) => ({ ...l, matureAtMs: 5 * MIN })) };
    expect(failing({ ...quick, gen3AtMs: 3 * RULES.life.matureMinMs - 1 })).toEqual([1]);
    // A lineage that matured under the rulebook's minimum fails even when its time looks gated.
    const young = { ...farm, lives: farm.lives.map((l) => ({ ...l, matureAtMs: MIN })) };
    expect(failing({ ...young, gen3AtMs: 30 * MIN })).toEqual([1]);
  });

  it('1: fail when the farmer waits for growth far less than the honest pair does', () => {
    const slow = { ...honest, lives: honest.lives.map((l) => life(l.startedAt, 5 * MIN)) };
    expect(overheadMs(slow)).toBe(5 * MIN);
    expect(
      gatesOf(farm, slow)
        .filter((g) => !g.ok)
        .map((g) => g.n),
    ).toEqual([1]);
  });

  it('2: fail for a creature with a second child inside its cooldown', () => {
    const quick = { ...farm, lives: [{ ...life(0), children: 2 }, ...farm.lives.slice(1)] };
    expect(failing(quick)).toEqual([2]);
  });

  it('3: fail for a kill paying more than its victim held, or a bot killed for more than 2 full kills', () => {
    const rich = { ...farm.kills[0], reward: 400 } as KillLog;
    expect(failing({ ...farm, kills: [rich, ...farm.kills.slice(1)] })).toEqual([3]);
    const eaten = [kill(0, 1), kill(0, 1), kill(0, 1)];
    expect(failing({ ...farm, kills: [...eaten, ...farm.kills.slice(-1)] })).toEqual([3]);
  });

  it('3: keeps the floor aside: kills past the halvings’ cap pay 2^-6 each', () => {
    const tail = Array.from({ length: 30 }, (_, i) => kill(0, 0.5 ** Math.min(i, 6)));
    expect(failing({ ...farm, kills: [...tail, kill(4, 0.5, 10 * MIN)] })).toEqual([]);
  });

  it('4: fail when a young bot pays more than half, or nothing young was killed', () => {
    expect(failing({ ...farm, kills: [...farm.kills.slice(0, 3), kill(4, 1, 10 * MIN)] })).toEqual([
      4,
    ]);
    expect(failing({ ...farm, kills: farm.kills.slice(0, 3) })).toEqual([4]);
  });

  it('5: fail when a bot is eligible before 20 minutes, or none after', () => {
    expect(failing({ ...farm, eligibility: { before: 1, after: 4 } })).toEqual([5]);
    expect(failing({ ...farm, eligibility: { before: 0, after: 0 } })).toEqual([5]);
    expect(failing({ ...farm, eligibility: null })).toEqual([5]);
  });
});

describe('the duty share', () => {
  it('stays within N ÷ (N + H) + 0.1 over 200 events for 1, 4 and 16 bots', () => {
    for (const n of FARM_SIZES) {
      expect(dutyShare(n)).toBeLessThanOrEqual(n / (n + HONEST_WITNESSES) + 0.1);
    }
  });

  it('grows with the bots, and is the same for the same draw', () => {
    expect(dutyShare(16)).toBeGreaterThan(dutyShare(1));
    expect(dutyShare(4)).toBe(dutyShare(4));
  });
});

describe('the report', () => {
  it('names every gate of every farm and the extras without a gate', () => {
    const text = farmReport([honest, farm]);
    expect(text).toContain('1. No time shortcut');
    expect(text).toContain('5. Sybil witnesses get their share');
    expect(text.match(/\| met \|/g)).toHaveLength(5);
    expect(text).toContain('What farming buys');
  });
});

describe('the honest pace', () => {
  heavyTest('is the pacing bot’s measured growth', () => {
    expect(Math.abs(forageGainPerMinute(12) - HONEST_GAIN_PER_MIN)).toBeLessThan(3);
  });
});

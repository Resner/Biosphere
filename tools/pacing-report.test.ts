import { describe, expect, it } from 'vitest';
import { cooldownMs } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import { heavyTest } from '../tests/heavy';
import { pacingReport, parseArgs, simulateLife, TIER_PACE_RANGE, tierRows } from './pacing-report';

describe('pacing simulation', () => {
  heavyTest('replays the same life for the same seed', () => {
    const a = simulateLife('smoke-0', 4 * 60_000);
    const b = simulateLife('smoke-0', 4 * 60_000);
    expect(b).toEqual(a);
  });

  heavyTest('records when a bot doubles and reaches 60% of its adult size', () => {
    const life = simulateLife('smoke-1', 30 * 60_000);
    expect(life.doubledAtMs).not.toBeNull();
    // Maturity needs 60% of the maximum biomass, so it never comes before it.
    if (life.matureAtMs !== null)
      expect(life.matureAtMs).toBeGreaterThanOrEqual(life.sixtyAtMs ?? 0);
  });

  heavyTest('only counts matings after maturity and the cooldown', () => {
    const life = simulateLife('smoke-1', 30 * 60_000);
    if (life.matureAtMs !== null)
      expect(life.firstEligibleMs).toBeGreaterThanOrEqual(life.matureAtMs);
    let last = life.firstEligibleMs ?? Number.POSITIVE_INFINITY;
    for (const at of life.matingsMs) {
      expect(at).toBeGreaterThanOrEqual(last);
      last = at + RULES.mating.cooldownMs;
    }
  });

  it('prints every section, with the doubling from the rules', () => {
    const text = pacingReport({ creatures: 2, minutes: 15, tiers: false });
    for (const heading of [
      '# Pacing report',
      '## Targets',
      '## Repeated matings',
      'Biomass doubles (median, p10, p90)',
      '60% of adult size (median, p10, p90)',
      'Median biomass doubling within 4 min',
      'Median 60% of adult size within 10 min',
      'Median hatch to first eligibility between 7 and 10 min',
    ]) {
      expect(text, heading).toContain(heading);
    }
    expect(text).toContain(`| 4th | ${cooldownMs(3) / RULES.mating.cooldownMs}× |`);
  }, 60_000);

  heavyTest('prints the tier table and keeps every tier within 0.5–2× the T0 bot', () => {
    const rows = tierRows(6, 8 * 60_000);
    expect(rows.map((r) => [r.tier, r.start])).toEqual([
      [0, 100],
      [1, 1024],
      [2, 16_384],
      [3, 262_144],
    ]);
    for (const row of rows.slice(1)) {
      expect(row.grew, `T${row.tier} bots that grew by half`).toBeGreaterThanOrEqual(5);
      expect(row.ratio, `T${row.tier} against T0`).toBeGreaterThanOrEqual(TIER_PACE_RANGE[0]);
      expect(row.ratio, `T${row.tier} against T0`).toBeLessThanOrEqual(TIER_PACE_RANGE[1]);
    }
    const text = pacingReport({ creatures: 1, minutes: 3, tiers: true });
    for (const heading of [
      '# Pacing by tier',
      '| Tier | Start biomass | Grew by half | Median (min) | × the T0 bot | Within the range |',
      '| T0 |',
      '| T1 |',
      '| T2 |',
      '| T3 |',
      'Target: tiers 1 to 3 within 0.5–2 × the T0 bot.',
    ]) {
      expect(text, heading).toContain(heading);
    }
  });

  it('rejects bad options', () => {
    expect(() => parseArgs(['--creatures', '0'])).toThrow(/Bad option/);
    expect(parseArgs(['--minutes', '5']).minutes).toBe(5);
    expect(parseArgs([]).tiers).toBe(false);
    expect(parseArgs(['--tiers', '--creatures', '3'])).toMatchObject({ tiers: true, creatures: 3 });
    expect(parseArgs(['--creatures', '3', '--tiers']).tiers).toBe(true);
  });
});

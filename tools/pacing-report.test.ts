import { describe, expect, it } from 'vitest';
import { cooldownMs } from '../src/sim/mating';
import { RULES } from '../src/sim/rules';
import { pacingReport, parseArgs, simulateLife } from './pacing-report';

describe('pacing simulation', () => {
  it('replays the same life for the same seed', () => {
    const a = simulateLife('smoke-0', 4 * 60_000);
    const b = simulateLife('smoke-0', 4 * 60_000);
    expect(b).toEqual(a);
  }, 60_000);

  it('records when a bot doubles and reaches 60% of its adult size', () => {
    const life = simulateLife('smoke-1', 30 * 60_000);
    expect(life.doubledAtMs).not.toBeNull();
    // Maturity needs 60% of the maximum biomass, so it never comes before it.
    if (life.matureAtMs !== null)
      expect(life.matureAtMs).toBeGreaterThanOrEqual(life.sixtyAtMs ?? 0);
  }, 60_000);

  it('only counts matings after maturity and the cooldown', () => {
    const life = simulateLife('smoke-1', 30 * 60_000);
    if (life.matureAtMs !== null)
      expect(life.firstEligibleMs).toBeGreaterThanOrEqual(life.matureAtMs);
    let last = life.firstEligibleMs ?? Number.POSITIVE_INFINITY;
    for (const at of life.matingsMs) {
      expect(at).toBeGreaterThanOrEqual(last);
      last = at + RULES.mating.cooldownMs;
    }
  }, 60_000);

  it('prints every section, with the doubling from the rules', () => {
    const text = pacingReport({ creatures: 2, minutes: 15 });
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

  it('rejects bad options', () => {
    expect(() => parseArgs(['--creatures', '0'])).toThrow(/Bad option/);
    expect(parseArgs(['--minutes', '5']).minutes).toBe(5);
  });
});

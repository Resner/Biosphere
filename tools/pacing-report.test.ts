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
    for (const heading of ['# Pacing report', '## Targets', '## Repeated matings']) {
      expect(text, heading).toContain(heading);
    }
    expect(text).toContain(`| 4th | ${cooldownMs(3) / RULES.mating.cooldownMs}× |`);
  }, 60_000);

  it('rejects bad options', () => {
    expect(() => parseArgs(['--creatures', '0'])).toThrow(/Bad option/);
    expect(parseArgs(['--minutes', '5']).minutes).toBe(5);
  });
});

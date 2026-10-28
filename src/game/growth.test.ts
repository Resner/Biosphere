import { describe, expect, it } from 'vitest';
import { GrowthWatch, growthText } from './growth';

const MIN = 60_000;

describe('growthText', () => {
  const base = { maxBiomass: 500, matureAtMs: 8 * MIN, stage: 'young' as const };

  it('names the share of the adult size in whole percent', () => {
    expect(growthText({ ...base, biomass: 100, activeMs: MIN })).toBe('Size 20% of adult');
    expect(growthText({ ...base, biomass: 310, activeMs: 3 * MIN + 50_000 })).toMatch(
      /^Size 62% of adult/,
    );
  });

  it('waits to name a time until the size is enough', () => {
    expect(growthText({ ...base, biomass: 299, activeMs: MIN })).not.toMatch(/Mature in/);
    expect(growthText({ ...base, biomass: 300, activeMs: 3 * MIN + 50_000 })).toBe(
      'Size 60% of adult · Mature in 4:10',
    );
  });

  it('rounds the wait up so a zero never shows while the wait is on', () => {
    expect(growthText({ ...base, biomass: 400, activeMs: 8 * MIN - 1 })).toMatch(/Mature in 0:01$/);
  });

  it('says nothing about maturity once mature, when old, or when no clock is known', () => {
    expect(growthText({ ...base, biomass: 400, activeMs: 9 * MIN, stage: 'mature' })).toBe(
      'Size 80% of adult',
    );
    expect(growthText({ ...base, biomass: 400, activeMs: 70 * MIN, stage: 'old' })).toBe(
      'Size 80% of adult',
    );
    expect(growthText({ ...base, biomass: 400, activeMs: MIN, matureAtMs: 0 })).toBe(
      'Size 80% of adult',
    );
  });

  it('does not lose a percent to float error', () => {
    expect(growthText({ ...base, maxBiomass: 100, biomass: 58, activeMs: 0, matureAtMs: 0 })).toBe(
      'Size 58% of adult',
    );
  });

  it('caps at the adult size and survives a zero maximum', () => {
    expect(growthText({ ...base, biomass: 900, activeMs: 9 * MIN, stage: 'mature' })).toBe(
      'Size 100% of adult',
    );
    expect(growthText({ ...base, maxBiomass: 0, biomass: 10, activeMs: 0, matureAtMs: 0 })).toBe(
      'Size 100% of adult',
    );
  });
});

describe('GrowthWatch', () => {
  it('stays quiet on the first reading of a life', () => {
    const watch = new GrowthWatch();
    expect(watch.update(250, 1000)).toBeNull();
  });

  it('cues each time size passes another tenth of the adult size', () => {
    const watch = new GrowthWatch();
    watch.update(100, 1000);
    expect(watch.update(150, 1000)).toBeNull();
    expect(watch.update(200, 1000)).toBe('step');
    expect(watch.update(250, 1000)).toBeNull();
    expect(watch.update(300, 1000)).toBe('step');
  });

  it('gives one cue for a jump over several tenths', () => {
    const watch = new GrowthWatch();
    watch.update(100, 1000);
    expect(watch.update(450, 1000)).toBe('step');
    expect(watch.update(455, 1000)).toBeNull();
  });

  it('does not cue again for size lost and regained', () => {
    const watch = new GrowthWatch();
    watch.update(100, 2000);
    expect(watch.update(300, 2000)).toBe('step');
    expect(watch.update(250, 2000)).toBeNull();
    expect(watch.update(299, 2000)).toBeNull();
    expect(watch.update(400, 2000)).toBe('step');
  });

  it('plays the bigger cue when the size tier changes', () => {
    const watch = new GrowthWatch();
    watch.update(1000, 5000);
    expect(watch.update(1023, 5000)).toBeNull();
    expect(watch.update(1024, 5000)).toBe('tier');
  });

  it('starts over after a reset', () => {
    const watch = new GrowthWatch();
    watch.update(100, 1000);
    watch.update(300, 1000);
    watch.reset();
    expect(watch.update(100, 1000)).toBeNull();
    expect(watch.update(200, 1000)).toBe('step');
  });
});

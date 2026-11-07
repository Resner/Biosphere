import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from './prng';
import { linkTiers, sizeTier, viewHalfHeight } from './size';

// M11 T1: the pure size shapes the link classes and the camera share (ADR 0062).

describe('linkTiers', () => {
  it('links comparable and adjacent sizes either way round, and not two tiers apart', () => {
    expect(linkTiers(20, 100)).toBe(true);
    expect(linkTiers(100, 20)).toBe(true);
    expect(linkTiers(20, 200)).toBe(false);
    expect(linkTiers(200, 20)).toBe(false);
  });

  it('reads tiers 0 and 2 through the margin', () => {
    expect(linkTiers(30, 135)).toBe(true);
    expect(linkTiers(135, 30)).toBe(true);
  });

  it('is symmetric and a superset of tiers within one, over random pairs', () => {
    const rng = createRng(seedFromString('size-tiers'), 'pairs');
    for (let i = 0; i < 10_000; i++) {
      const a = 1 + rng.next() * 3000;
      const b = 1 + rng.next() * 3000;
      expect(linkTiers(a, b)).toBe(linkTiers(b, a));
      if (Math.abs(sizeTier(a * a) - sizeTier(b * b)) <= 1) {
        expect(linkTiers(a, b), `${a} ${b}`).toBe(true);
      }
    }
  });
});

describe('viewHalfHeight', () => {
  it('follows ADR 0029: 9 · R^0.9 · (r ÷ R)^0.6, with a radius past the adult’s counting as the adult’s', () => {
    expect(viewHalfHeight(10, 20)).toBeCloseTo(88.0, 1);
    expect(viewHalfHeight(20, 20)).toBeCloseTo(133.4, 1);
    expect(viewHalfHeight(40, 20)).toBeCloseTo(viewHalfHeight(40, 40), 9);
    expect(viewHalfHeight(0, 20)).toBe(0);
  });
});

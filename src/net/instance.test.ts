import { describe, expect, it } from 'vitest';
import { createRng, seedFromString } from '../sim/prng';
import { CROWD_AT, CROWD_EVERY_MS, INSTANCE_MAX, sameWater } from './instance';
import { INSTANCE_WIRE_MAX } from './protocol';

// Crowd instances (M12 T1, ADR 0064): the open water (0) shares water with every instance, and
// two instances share it only with themselves.

describe('sameWater', () => {
  it('puts the open water with every instance, either way round', () => {
    for (let n = 0; n <= INSTANCE_WIRE_MAX; n++) {
      if (!sameWater(0, n) || !sameWater(n, 0)) throw new Error(`open water and ${n}`);
    }
  });

  it('puts an instance with itself and apart from any other', () => {
    expect(sameWater(3, 3)).toBe(true);
    expect(sameWater(3, 4)).toBe(false);
    expect(sameWater(INSTANCE_WIRE_MAX, 1)).toBe(false);
  });

  it('is symmetric over 10,000 random pairs', () => {
    const rng = createRng(seedFromString('same-water'), 'pairs');
    let apart = 0;
    for (let i = 0; i < 10_000; i++) {
      // Mostly small numbers, so equal pairs and the open water come up often.
      const draw = () => (rng.int(0, 3) === 0 ? rng.int(0, INSTANCE_WIRE_MAX) : rng.int(0, 4));
      const [a, b] = [draw(), draw()];
      expect(sameWater(a, b)).toBe(sameWater(b, a));
      if (!sameWater(a, b)) apart++;
    }
    expect(apart).toBeGreaterThan(0);
  });
});

describe('the constants', () => {
  it('are the shared shapes of the spec', () => {
    expect(CROWD_AT).toBe(24);
    expect(CROWD_EVERY_MS).toBe(10_000);
    expect(INSTANCE_MAX).toBe(16);
  });
});

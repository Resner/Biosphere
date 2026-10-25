import { describe, expect, it } from 'vitest';
import { Hasher, hash64 } from './hash';
import { createRng, hashU32, seedFromBytes, seedFromString } from './prng';

const utf8 = (s: string) => new TextEncoder().encode(s);

describe('createRng', () => {
  it('first five values for (biosphere, food) are frozen', () => {
    const r = createRng(seedFromString('biosphere'), 'food');
    const got = Array.from({ length: 5 }, () => r.nextU32());
    expect(got).toEqual([3294806479, 2553321992, 3105765955, 2858107475, 134325343]);
  });

  it('a different purpose gives a different stream', () => {
    const seed = seedFromString('biosphere');
    expect(createRng(seed, 'hazard').nextU32()).not.toBe(createRng(seed, 'food').nextU32());
  });

  it('the same (seed, purpose) repeats', () => {
    const a = createRng(seedFromString('x'), 'p');
    const b = createRng(seedFromString('x'), 'p');
    for (let i = 0; i < 100; i++) expect(a.nextU32()).toBe(b.nextU32());
  });

  it('int(0, 9) fills each bucket to 10,000 +- 3% over 100,000 draws', () => {
    const r = createRng(seedFromString('biosphere'), 'buckets');
    const counts = new Array<number>(10).fill(0);
    for (let i = 0; i < 100_000; i++) {
      const k = r.int(0, 9);
      counts[k] = (counts[k] ?? 0) + 1;
    }
    for (const c of counts) {
      expect(c).toBeGreaterThanOrEqual(9_700);
      expect(c).toBeLessThanOrEqual(10_300);
    }
  });

  it('next() is in [0, 1) and range/int respect their bounds', () => {
    const r = createRng(seedFromString('bounds'), 'p');
    for (let i = 0; i < 10_000; i++) {
      const u = r.next();
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
      const v = r.range(-3, 5);
      expect(v).toBeGreaterThanOrEqual(-3);
      expect(v).toBeLessThan(5);
      const k = r.int(2, 4);
      expect([2, 3, 4]).toContain(k);
    }
  });

  it('seeds from strings and bytes are stable and distinct', () => {
    expect(seedFromString('a')).toEqual(seedFromBytes(utf8('a')));
    expect(seedFromString('a')).not.toEqual(seedFromString('b'));
    expect(seedFromString('a')).toHaveLength(4);
  });
});

describe('hashU32', () => {
  it('is frozen and sensitive to every argument', () => {
    expect(hashU32(1, 2, 3)).toBe(3832742900);
    const base = hashU32(1, 2, 3);
    expect(hashU32(2, 2, 3)).not.toBe(base);
    expect(hashU32(1, 3, 3)).not.toBe(base);
    expect(hashU32(1, 2, 4)).not.toBe(base);
    expect(hashU32(1, 2)).not.toBe(base);
  });
});

describe('hash64 and Hasher', () => {
  it('hash64 of "biosphere" is frozen, 16 hex digits, and flips with one bit', () => {
    const bytes = utf8('biosphere');
    expect(hash64(bytes)).toBe('09d9fa5c007490e1');
    const flipped = bytes.slice();
    flipped[0] = (flipped[0] ?? 0) ^ 1;
    expect(hash64(flipped)).not.toBe(hash64(bytes));
    expect(hash64(bytes)).toMatch(/^[0-9a-f]{16}$/);
  });

  it('distinguishes field boundaries and kinds', () => {
    const a = new Hasher().str('ab').str('c').digest();
    const b = new Hasher().str('a').str('bc').digest();
    expect(a).not.toBe(b);
    expect(new Hasher().u32(1).digest()).not.toBe(new Hasher().i32(1).str('').digest());
  });

  it('rejects non-finite numbers', () => {
    expect(() => new Hasher().f64(Number.NaN)).toThrow();
    expect(() => new Hasher().f64(Number.POSITIVE_INFINITY)).toThrow();
  });

  it('f64 sees 1e-9 differences and distinguishes -0 handling consistently', () => {
    expect(new Hasher().f64(1).digest()).not.toBe(new Hasher().f64(1 + 1e-9).digest());
  });
});

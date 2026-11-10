import { describe, expect, it } from 'vitest';
import { sampled } from './interrupt-kit';

describe('sampled', () => {
  const ids = Array.from({ length: 100 }, (_, i) => i);

  it('keeps everything when the list is no longer than the count', () => {
    expect(sampled(ids, 100, 3)).toEqual(ids);
    expect(sampled(ids, 500, 3)).toEqual(ids);
  });

  it('takes about the count, spread evenly', () => {
    const part = sampled(ids, 40, 0);
    expect(part.length).toBeLessThanOrEqual(40);
    expect(part.length).toBeGreaterThanOrEqual(30);
    expect(part.slice(0, 3)).toEqual([0, 3, 6]);
  });

  it('takes a different part for each offset, and every creature in some read', () => {
    const seen = new Set<number>();
    for (let offset = 0; offset < 3; offset++)
      for (const id of sampled(ids, 40, offset)) seen.add(id);
    expect(seen.size).toBe(100);
    expect(sampled(ids, 40, 1)).not.toEqual(sampled(ids, 40, 0));
  });

  it('takes none for a count of zero, and tolerates a negative offset', () => {
    expect(sampled(ids, 0, 1)).toEqual([]);
    expect(sampled(ids, 40, -1).length).toBeGreaterThan(0);
  });
});

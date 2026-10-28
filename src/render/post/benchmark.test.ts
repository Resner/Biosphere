import { describe, expect, it } from 'vitest';
import { BENCH, Benchmark, percentile, pickPreset } from './benchmark';

const constant = (ms: number, n = 120): number[] => Array.from({ length: n }, () => ms);

describe('percentile', () => {
  it('is the nearest rank', () => {
    const values = [5, 1, 4, 2, 3, 6, 8, 7, 10, 9];
    expect(percentile(values, 0.75)).toBe(8);
    expect(percentile(values, 0.9)).toBe(9);
    expect(percentile(values, 1)).toBe(10);
    expect(percentile(values, 0)).toBe(1);
    expect(percentile([7], 0.5)).toBe(7);
  });

  it('reads only the first `count` values and leaves its input alone', () => {
    const values = [3, 1, 2, 100, 100];
    expect(percentile(values, 1, 3)).toBe(3);
    expect(values).toEqual([3, 1, 2, 100, 100]);
  });

  it('is NaN with nothing to rank', () => {
    expect(percentile([], 0.5)).toBeNaN();
  });
});

describe('pickPreset', () => {
  it('maps the 75th percentile: up to 11 ms high, up to 20 ms medium, otherwise low', () => {
    expect(pickPreset(constant(8))).toBe('high');
    expect(pickPreset(constant(11))).toBe('high');
    expect(pickPreset(constant(11.01))).toBe('medium');
    expect(pickPreset(constant(15))).toBe('medium');
    expect(pickPreset(constant(20))).toBe('medium');
    expect(pickPreset(constant(20.01))).toBe('low');
    expect(pickPreset(constant(30))).toBe('low');
  });

  it('takes the 75th percentile, not the mean or the worst frame', () => {
    // 75% of frames at 8 ms and a quarter at 40 ms: the mean is 16 ms, the 75th percentile 8 ms.
    const mostlyFast = [...constant(8, 75), ...constant(40, 25)];
    expect(pickPreset(mostlyFast)).toBe('high');
    // One frame more at 40 ms tips the 75th percentile over.
    const slower = [...constant(8, 74), ...constant(40, 26)];
    expect(pickPreset(slower)).toBe('low');
  });

  it('keeps medium without any frame', () => {
    expect(pickPreset([])).toBe('medium');
  });
});

describe('Benchmark', () => {
  // Feeds frames of `ms` from `start` until the benchmark answers; returns the answer and the time.
  const run = (bench: Benchmark, ms: (i: number) => number, start = 0) => {
    let now = start;
    for (let i = 0; i < 10_000; i++) {
      const frame = ms(i);
      now += frame;
      const result = bench.sample(frame, now);
      if (result) return { result, now };
    }
    return null;
  };

  it('answers after the warm-up and 2 s of frames', () => {
    const bench = new Benchmark();
    bench.start(1000);
    expect(bench.running).toBe(true);
    const out = run(bench, () => 10, 1000);
    expect(out?.result).toBe('high');
    expect(out?.now).toBeGreaterThanOrEqual(1000 + BENCH.warmupMs + BENCH.durationMs);
    expect(out?.now).toBeLessThan(1000 + BENCH.warmupMs + BENCH.durationMs + 20);
    expect(bench.running).toBe(false);
  });

  it('ignores the warm-up frames, where shaders compile', () => {
    const bench = new Benchmark();
    bench.start(0);
    // 400 ms of 100 ms frames, then fast ones: only the fast ones count.
    const out = run(bench, (i) => (i < 4 ? 100 : 15));
    expect(out?.result).toBe('medium');
  });

  it('answers nothing unless started, and nothing after a cancel', () => {
    const bench = new Benchmark();
    expect(bench.sample(10, 5000)).toBeNull();
    bench.start(0);
    bench.cancel();
    expect(bench.running).toBe(false);
    expect(run(bench, () => 10)).toBeNull();
  });

  it('starts afresh on each start', () => {
    const bench = new Benchmark();
    bench.start(0);
    for (let t = 30; t < 1500; t += 30) bench.sample(30, t);
    bench.start(2000);
    expect(run(bench, () => 9, 2000)?.result).toBe('high');
  });
});

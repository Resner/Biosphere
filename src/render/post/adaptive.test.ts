import { describe, expect, it } from 'vitest';
import { ADAPTIVE, AdaptiveScale } from './adaptive';

/** Drives an `AdaptiveScale` with frame times on a clock that the frames themselves advance. */
function driver(start = 0) {
  const adaptive = new AdaptiveScale();
  adaptive.reset(start);
  let now = start;
  const steps: { at: number; scale: number }[] = [];
  return {
    adaptive,
    steps,
    get now() {
      return now;
    },
    /** Feeds frames of `ms(i)` for `forMs` of wall time. */
    feed(ms: number | ((i: number) => number), forMs: number) {
      const end = now + forMs;
      for (let i = 0; now < end; i++) {
        const frame = typeof ms === 'number' ? ms : ms(i);
        now += frame;
        const before = adaptive.scale;
        const after = adaptive.sample(frame, now);
        if (after !== before) steps.push({ at: now, scale: after });
      }
      return adaptive.scale;
    },
  };
}

describe('ADAPTIVE', () => {
  it('pins the thresholds of the spec', () => {
    expect(ADAPTIVE).toEqual({
      min: 0.6,
      max: 1,
      step: 0.1,
      windowMs: 2000,
      budgetMs: 16.7,
      down: 1.25,
      up: 0.8,
      upAfterMs: 5000,
    });
  });
});

describe('AdaptiveScale', () => {
  it('starts at full resolution', () => {
    expect(new AdaptiveScale().scale).toBe(1);
  });

  it('holds at 1 while frames fit the budget', () => {
    const d = driver();
    expect(d.feed(16.7, 30_000)).toBe(1);
    expect(d.steps).toEqual([]);
  });

  it('steps down by 0.1 when the 90th percentile over 2 s exceeds 1.25 x 16.7 ms', () => {
    const d = driver();
    d.feed(21, 2100);
    expect(d.adaptive.scale).toBe(0.9);
    expect(d.steps).toHaveLength(1);
    expect(d.steps[0]?.at).toBeGreaterThanOrEqual(2000);
  });

  it('does not step down at exactly the threshold', () => {
    const d = driver();
    expect(d.feed(1.25 * 16.7, 10_000)).toBe(1);
  });

  it('steps down on the 90th percentile, not on rare spikes', () => {
    const d = driver();
    // One frame in 20 is slow: the 90th percentile stays fast.
    expect(d.feed((i) => (i % 20 === 0 ? 50 : 14), 10_000)).toBe(1);
    // One in 5 is slow: it is not.
    expect(d.feed((i) => (i % 5 === 0 ? 50 : 14), 2500)).toBe(0.9);
  });

  it('never goes below 0.6, one step per 2 s', () => {
    const d = driver();
    expect(d.feed(40, 30_000)).toBe(0.6);
    expect(d.steps.map((s) => s.scale)).toEqual([0.9, 0.8, 0.7, 0.6]);
    for (let i = 1; i < d.steps.length; i++)
      expect((d.steps[i]?.at ?? 0) - (d.steps[i - 1]?.at ?? 0)).toBeGreaterThanOrEqual(2000);
  });

  it('steps back up only after 5 s below 0.8 x 16.7 ms, and never above 1', () => {
    const d = driver();
    d.feed(40, 4100);
    expect(d.adaptive.scale).toBe(0.8);
    const down = d.steps.at(-1);
    d.feed(10, 6000);
    expect(d.adaptive.scale).toBe(0.8);
    d.feed(10, 2000);
    expect(d.adaptive.scale).toBe(0.9);
    const up = d.steps.at(-1);
    // A fresh window fills for 2 s after the step down, then stays fast for 5 s.
    expect((up?.at ?? 0) - (down?.at ?? 0)).toBeGreaterThanOrEqual(
      ADAPTIVE.windowMs + ADAPTIVE.upAfterMs,
    );
    expect(d.feed(10, 60_000)).toBe(1);
  });

  it('does not step up between the two thresholds', () => {
    const d = driver();
    d.feed(40, 2100);
    expect(d.adaptive.scale).toBe(0.9);
    // 15 ms is within budget but not below 0.8 x 16.7 = 13.36 ms.
    expect(d.feed(15, 60_000)).toBe(0.9);
  });

  it('a slow spell restarts the 5 s count', () => {
    const d = driver();
    d.feed(40, 2100);
    // 4 s fast, then 0.6 s within budget but not fast: the window is never fast for 5 s in a row.
    for (let i = 0; i < 10; i++) {
      d.feed(10, 4000);
      d.feed(18, 600);
    }
    expect(d.adaptive.scale).toBe(0.9);
    expect(d.steps).toHaveLength(1);
  });

  it('never oscillates under alternating loads', () => {
    for (const [slowMs, fastMs] of [
      [200, 200],
      [1000, 1000],
      [2000, 2000],
      [3000, 3000],
      [2500, 4900],
    ] as const) {
      const d = driver();
      for (let i = 0; i < 20; i++) {
        d.feed(30, slowMs);
        d.feed(8, fastMs);
      }
      // Every change of direction is at least the up delay apart; most loads only ever step down.
      let ups = 0;
      for (let i = 1; i < d.steps.length; i++) {
        const prev = d.steps[i - 1];
        const step = d.steps[i];
        if (!prev || !step) continue;
        expect(step.at - prev.at).toBeGreaterThanOrEqual(ADAPTIVE.windowMs);
        if (step.scale > prev.scale) {
          ups++;
          expect(step.at - prev.at).toBeGreaterThanOrEqual(ADAPTIVE.windowMs + ADAPTIVE.upAfterMs);
        }
      }
      expect(ups, `${slowMs}/${fastMs}`).toBe(0);
    }
  });

  it('alternate frames slow and fast settle at the bottom and stay', () => {
    const d = driver();
    expect(d.feed((i) => (i % 2 ? 8 : 30), 60_000)).toBe(0.6);
    expect(d.steps).toHaveLength(4);
  });

  it('reset clears the window and sets the scale', () => {
    const d = driver();
    d.feed(40, 2100);
    expect(d.adaptive.scale).toBe(0.9);
    d.adaptive.reset(d.now, 1);
    expect(d.adaptive.scale).toBe(1);
    // A fresh window: no step until 2 s of new frames.
    d.feed(40, 1900);
    expect(d.adaptive.scale).toBe(1);
    d.feed(40, 200);
    expect(d.adaptive.scale).toBe(0.9);
    d.adaptive.reset(d.now);
    expect(d.adaptive.scale).toBe(0.9);
  });

  it('keeps exact tenths', () => {
    const d = driver();
    d.feed(40, 30_000);
    d.feed(5, 120_000);
    expect(d.steps.map((s) => s.scale)).toEqual([0.9, 0.8, 0.7, 0.6, 0.7, 0.8, 0.9, 1]);
  });
});

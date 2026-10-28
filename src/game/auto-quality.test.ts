import { describe, expect, it } from 'vitest';
import type { PresetName } from '../render/presets';
import { AutoQuality, type AutoQualityOptions } from './auto-quality';
import { loadBench, saveBench } from './settings';

const memory = () => {
  const data = new Map<string, string>();
  return {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, v),
  };
};

/** An `AutoQuality` with the app around it reduced to a preset, a screen and a setting. */
function harness(options: Partial<AutoQualityOptions> = {}) {
  const store = options.store === undefined ? memory() : options.store;
  const detections: PresetName[] = [];
  const scales: number[] = [];
  const world = { title: true, auto: true, now: 0, preset: 'medium' as PresetName };
  const auto = new AutoQuality({
    store,
    gpu: 'GPU A',
    measure: true,
    ...options,
    onDetect: (preset) => {
      detections.push(preset);
      if (world.auto) world.preset = preset;
    },
    onScale: (scale) => scales.push(scale),
  });
  if (world.auto) world.preset = auto.detected;
  const feed = (ms: number, forMs: number) => {
    const end = world.now + forMs;
    while (world.now < end) {
      world.now += ms;
      auto.frame(ms, world.now, world.title, world.auto, world.preset);
    }
  };
  return { auto, store, world, detections, scales, feed };
}

describe('AutoQuality', () => {
  it('benchmarks behind the title screen and applies and stores the result', () => {
    const h = harness();
    expect(h.auto.status).toBe('pending');
    expect(h.auto.detected).toBe('medium');
    h.feed(8, 100);
    expect(h.auto.status).toBe('running');
    h.feed(8, 3000);
    expect(h.auto.status).toBe('measured');
    expect(h.detections).toEqual(['high']);
    expect(h.auto.detected).toBe('high');
    expect(loadBench(h.store, 'GPU A')).toBe('high');
  });

  it('uses a stored result for this GPU without benchmarking', () => {
    const store = memory();
    saveBench(store, 'GPU A', 'low');
    const h = harness({ store });
    expect(h.auto.status).toBe('stored');
    expect(h.auto.detected).toBe('low');
    h.feed(8, 5000);
    expect(h.detections).toEqual([]);
    expect(h.auto.detected).toBe('low');
  });

  it('benchmarks again on another GPU', () => {
    const store = memory();
    saveBench(store, 'GPU B', 'low');
    const h = harness({ store });
    expect(h.auto.status).toBe('pending');
    h.feed(30, 3000);
    expect(h.detections).toEqual(['low']);
    expect(loadBench(store, 'GPU B')).toBe('low');
  });

  it('never benchmarks during play, and gives up a run when the player hatches', () => {
    const h = harness();
    h.world.title = false;
    h.feed(8, 5000);
    expect(h.auto.status).toBe('pending');
    h.world.title = true;
    h.feed(8, 1000);
    expect(h.auto.status).toBe('running');
    h.world.title = false;
    h.feed(8, 5000);
    expect(h.auto.status).toBe('pending');
    expect(h.detections).toEqual([]);
    // Back on the title it starts over.
    h.world.title = true;
    h.feed(30, 3000);
    expect(h.detections).toEqual(['low']);
  });

  it('only benchmarks for the auto setting', () => {
    const h = harness();
    h.world.auto = false;
    h.world.preset = 'low';
    h.feed(8, 5000);
    expect(h.auto.status).toBe('pending');
    expect(h.detections).toEqual([]);
  });

  it('a long gap (a hidden tab) restarts the benchmark', () => {
    const h = harness();
    h.feed(8, 1500);
    h.world.now += 5000;
    h.auto.frame(5000, h.world.now, true, true, h.world.preset);
    expect(h.auto.status).toBe('pending');
    h.feed(8, 1000);
    expect(h.auto.status).toBe('running');
    expect(h.detections).toEqual([]);
  });

  it('without measuring (tests, ?quality=) skips the benchmark and pins the scale at 1', () => {
    const h = harness({ measure: false });
    expect(h.auto.status).toBe('skipped');
    expect(h.auto.detected).toBe('medium');
    h.feed(40, 20_000);
    expect(h.detections).toEqual([]);
    expect(h.scales).toEqual([]);
    expect(h.auto.scale).toBe(1);
  });

  it('without measuring still takes a stored result', () => {
    const store = memory();
    saveBench(store, 'GPU A', 'high');
    const h = harness({ store, measure: false });
    expect(h.auto.status).toBe('stored');
    expect(h.auto.detected).toBe('high');
  });

  it('steps the render scale after the benchmark, never during it', () => {
    const h = harness();
    // 25 ms frames: the benchmark picks low, then low is still over budget.
    h.feed(25, 2400);
    expect(h.auto.status).toBe('running');
    expect(h.scales).toEqual([]);
    h.feed(25, 1000);
    expect(h.detections).toEqual(['low']);
    h.feed(25, 2100);
    expect(h.scales).toEqual([0.9]);
    expect(h.auto.scale).toBe(0.9);
  });

  it('a preset change starts the scale over at 1', () => {
    const store = memory();
    saveBench(store, 'GPU A', 'medium');
    const h = harness({ store });
    h.feed(30, 4100);
    expect(h.auto.scale).toBe(0.8);
    h.world.preset = 'low';
    h.feed(30, 100);
    expect(h.auto.scale).toBe(1);
    expect(h.scales).toEqual([0.9, 0.8, 1]);
  });

  describe('setBench', () => {
    it('replaces frame times and re-runs the benchmark at once', () => {
      for (const [ms, preset] of [
        [8, 'high'],
        [15, 'medium'],
        [30, 'low'],
      ] as const) {
        const h = harness({ measure: false });
        h.auto.setBench(ms, h.world.now);
        expect(h.auto.status).toBe('measured');
        expect(h.detections).toEqual([preset]);
        expect(loadBench(h.store, 'GPU A')).toBe(preset);
      }
    });

    it('drives the render scale even where measuring is off', () => {
      const h = harness({ measure: false });
      h.world.auto = false;
      h.auto.setBench(30, h.world.now);
      // Real frames are fast; the forced budget is not.
      h.feed(5, 2100);
      expect(h.auto.scale).toBe(0.9);
      h.auto.setBench(8, h.world.now);
      h.feed(5, 7100);
      expect(h.auto.scale).toBe(1);
      expect(h.scales).toEqual([0.9, 1]);
    });
  });
});

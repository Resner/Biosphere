import { describe, expect, it } from 'vitest';
import {
  SWARM_CLOUDS,
  SWARM_FADE_S,
  SWARM_MOTES,
  type SwarmCloud,
  SwarmLayer,
  type SwarmPoint,
} from './swarms';

// M11 T17: a giant draws the small players its directory reports as faint drifting clouds of motes.

const STILL = { x: 0, y: 0 };
const POINTS: SwarmPoint[] = [
  [131_000, 131_000],
  [131_400, 130_800],
  [130_500, 131_600],
];

const frame = (
  layer: SwarmLayer,
  swarm: readonly SwarmPoint[],
  time: number,
  flow: { x: number; y: number } = STILL,
): SwarmCloud[] => {
  layer.update(swarm, time, flow, 14.8, 0.2);
  return layer.clouds();
};

describe('SwarmLayer', () => {
  it('draws three swarm points as three clouds of 5 to 9 motes each, fading in over a second', () => {
    const layer = new SwarmLayer();
    expect(frame(layer, [], 0)).toEqual([]);
    expect(layer.count()).toBe(0);
    const first = frame(layer, POINTS, 1);
    expect(layer.count()).toBe(3);
    for (const c of first) expect(c.alpha).toBe(0);
    const half = frame(layer, POINTS, 1 + SWARM_FADE_S / 2);
    for (const c of half) expect(c.alpha).toBeCloseTo(0.5, 6);
    const shown = frame(layer, POINTS, 1 + SWARM_FADE_S);
    expect(shown.map((c) => [c.x, c.y])).toEqual(POINTS);
    for (const c of shown) {
      expect(c.alpha).toBe(1);
      expect(c.motes).toBeGreaterThanOrEqual(SWARM_MOTES.min);
      expect(c.motes).toBeLessThanOrEqual(SWARM_MOTES.max);
    }
    expect(layer.motes()).toBe(shown.reduce((n, c) => n + c.motes, 0));
    layer.dispose();
  });

  it('fades a point gone from the next `near` out over a second', () => {
    const layer = new SwarmLayer();
    frame(layer, POINTS, 0);
    frame(layer, POINTS, 2);
    // The next answer: a new list without the second point.
    const next: SwarmPoint[] = [POINTS[0] as SwarmPoint, POINTS[2] as SwarmPoint];
    frame(layer, next, 3);
    expect(layer.count()).toBe(3);
    const fading = frame(layer, next, 3 + SWARM_FADE_S / 2);
    const gone = fading.find((c) => c.x === POINTS[1]?.[0]);
    expect(gone?.alpha).toBeCloseTo(0.5, 6);
    for (const c of fading.filter((c) => c !== gone)) expect(c.alpha).toBe(1);
    frame(layer, next, 3 + SWARM_FADE_S + 0.01);
    expect(layer.count()).toBe(2);
    layer.dispose();
  });

  it('seeds each cloud by its position, and keeps it when its player moves a little', () => {
    const a = new SwarmLayer();
    const b = new SwarmLayer();
    const one = frame(a, POINTS, 0);
    const two = frame(b, [...POINTS].reverse(), 0);
    for (const c of one) {
      expect(two.find((d) => d.x === c.x && d.y === c.y)?.seed).toBe(c.seed);
    }
    frame(a, POINTS, 2);
    const moved: SwarmPoint[] = POINTS.map(([x, y]) => [x + 120, y - 40]);
    const after = frame(a, moved, 2.01);
    expect(a.count()).toBe(3);
    expect(after.map((c) => c.seed)).toEqual(one.map((c) => c.seed));
    for (const c of after) expect(c.alpha).toBe(1);
    // It glides to the new place over a second rather than jumping there.
    const there = frame(a, moved, 2.01 + SWARM_FADE_S);
    expect(there.map((c) => [c.x, c.y])).toEqual(moved);
    a.dispose();
    b.dispose();
  });

  it('drifts each cloud with the current from where it was reported', () => {
    const layer = new SwarmLayer();
    frame(layer, POINTS, 0, { x: 10, y: 5 });
    const drifted = frame(layer, POINTS, 1, { x: 70, y: -15 });
    expect(drifted.map((c) => [c.x, c.y])).toEqual(POINTS.map(([x, y]) => [x + 60, y - 20]));
    layer.dispose();
  });

  it('draws at most 64 clouds', () => {
    const layer = new SwarmLayer();
    const many: SwarmPoint[] = Array.from({ length: 80 }, (_, i) => [100_000 + i * 50, 100_000]);
    frame(layer, many, 0);
    expect(layer.count()).toBe(SWARM_CLOUDS);
    expect(layer.motes()).toBeLessThanOrEqual(SWARM_CLOUDS * SWARM_MOTES.max);
    layer.dispose();
  });
});

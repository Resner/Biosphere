import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { DepthWindow } from '../render/depth-window';
import { wrapTo } from '../render/origin';
import { seedFromString } from '../sim/prng';
import {
  CHART_TEXELS,
  CHART_VIEWS,
  DepthChart,
  MAP_BUILD_BUDGET,
  MAP_SMOOTH_WU,
  MAP_TEXELS,
  mapChart,
  minimapChart,
} from './depth-chart';
import { mapPixels } from './map-relief';

const SIZE = 262_144;
const seed = seedFromString('depth-chart');
const MID = SIZE / 2;

/** A settled window's texels unrolled, south row first, as `mapPixels` takes them. */
function unrolled(views: number, n: number, x: number, y: number, half: number): Uint8Array {
  const w = new DepthWindow(views, n);
  w.settle(seed, SIZE, x, y, half);
  const grid = new Uint8Array(n * n);
  for (let j = 0; j < n; j++)
    for (let i = 0; i < n; i++)
      grid[j * n + i] = w.data[wrapTo(w.j0 + j, n) * n + wrapTo(w.i0 + i, n)] as number;
  return grid;
}

/** Updates at a fixed point until a picture is up and nothing is left to do; returns the frames. */
function drain(chart: DepthChart, x: number, y: number, half: number, limit = 400): number {
  for (let frame = 1; frame <= limit; frame++) {
    chart.update(seed, SIZE, x, y, half);
    if (chart.idle) return frame;
  }
  throw new Error('the chart never settled');
}

describe('the minimap chart', () => {
  it('charts its window at once, as mapPixels does', () => {
    const chart = minimapChart();
    const half = 134;
    expect(chart.update(seed, SIZE, MID, MID, half)).toBe(true);
    const pic = chart.picture;
    expect(pic).not.toBeNull();
    if (!pic) return;
    expect(pic.n).toBe(CHART_TEXELS);
    expect(pic.side).toBeGreaterThanOrEqual(CHART_VIEWS * half);
    expect([...pic.pixels]).toEqual([
      ...mapPixels(unrolled(CHART_VIEWS, CHART_TEXELS, MID, MID, half), CHART_TEXELS),
    ]);
  });
});

describe('the map chart', () => {
  it('builds its picture over several frames, each within its budget, to the one-shot picture', () => {
    const chart = mapChart();
    const side = 8192;
    expect(chart.update(seed, SIZE, MID, MID, side)).toBe(false);
    expect(chart.picture).toBeNull();
    const frames = drain(chart, MID, MID, side);
    // The window's 16 frames, then a build of a few more.
    expect(frames).toBeGreaterThan(16);
    expect(frames).toBeLessThanOrEqual(40);
    expect(chart.worst).toBeLessThanOrEqual(MAP_BUILD_BUDGET);
    const pic = chart.picture;
    expect(pic?.n).toBe(MAP_TEXELS);
    // Twice the square: it stays inside the window until the window re-centres.
    expect(pic?.side).toBeGreaterThanOrEqual(2 * side);
    const once = new DepthChart(2, MAP_TEXELS, { smoothWu: MAP_SMOOTH_WU });
    once.update(seed, SIZE, MID, MID, side);
    expect(once.picture?.cell).toBe(pic?.cell);
    expect([...(pic?.pixels ?? [])]).toEqual([...(once.picture?.pixels ?? [])]);
  });

  it('keeps the last picture where it was until a jump far away is charted', () => {
    const chart = mapChart();
    const side = 8192;
    drain(chart, MID, MID, side);
    const before = chart.picture;
    const at = { x: before?.x, y: before?.y };
    chart.update(seed, SIZE, MID + 100_000, MID, side);
    expect(chart.picture?.x).toBe(at.x);
    expect(chart.picture?.y).toBe(at.y);
    drain(chart, MID + 100_000, MID, side);
    const after = chart.picture;
    expect(after).not.toBeNull();
    if (!after) return;
    expect(after.x).toBeLessThan(MID + 100_000);
    expect(after.x + after.side).toBeGreaterThan(MID + 100_000);
  });

  it('leaves the texels beyond the world clear', () => {
    const chart = mapChart();
    drain(chart, 1000, MID, 8192);
    const pic = chart.picture;
    expect(pic).not.toBeNull();
    if (!pic) return;
    const { n, pixels, cell, x } = pic;
    const row = Math.floor(n / 2) * n * 4;
    for (let i = 0; i < n; i++) {
      const cx = x + (i + 0.5) * cell;
      expect(pixels[row + i * 4 + 3], `texel ${i}`).toBe(cx < 0 ? 0 : 255);
    }
  });
});

speedTest("a frame of the open map's chart refill takes at most 4 ms in Node", () => {
  const chart = mapChart();
  const side = 8192;
  // Warm up: a whole refill and build.
  drain(chart, MID, MID, side);
  drain(chart, 200_000, 200_000, side);
  const times: number[] = [];
  const frame = (x: number, y: number) => {
    const t = performance.now();
    chart.update(seed, SIZE, x, y, side);
    times.push(performance.now() - t);
  };
  // Teleports far away, then a swim across a re-centre.
  for (const [x, y] of [
    [250_000, 250_000],
    [10_000, 250_000],
    [MID, 20_000],
  ] as const) {
    do frame(x, y);
    while (!chart.idle);
  }
  for (let k = 0; k < 600; k++) frame(MID + k * 12, 20_000 + k * 6);
  times.sort((a, b) => a - b);
  // The worst frame but one, so a single GC pause on a loaded runner does not decide it.
  expect(times[times.length - 2], `frames ${times.map((t) => t.toFixed(2))}`).toBeLessThanOrEqual(
    4,
  );
});

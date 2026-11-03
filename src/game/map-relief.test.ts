import { describe, expect, it } from 'vitest';
import { depthGrid, ZONE_TEXTURE_SIZE } from '../render/zones';
import type { Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { MAP_SMOOTH_RADIUS, RELIEF_LIMIT, relief, smoothDepth } from './map-relief';
import { mapPixels } from './pond-map';

const SEED = [11, 22, 33, 44] as unknown as Seed;
const WORLD = RULES.world.size;

describe('map relief', () => {
  it('keeps a flat grid flat and the mean depth', () => {
    const n = 32;
    const flat = new Uint8Array(n * n).fill(100);
    expect([...smoothDepth(flat, n)].every((d) => Math.abs(d - 100) < 1e-3)).toBe(true);
    const noisy = Uint8Array.from({ length: n * n }, (_, i) => (i * 37) % 251);
    const mean = (a: ArrayLike<number>) => {
      let s = 0;
      for (let i = 0; i < a.length; i++) s += a[i] as number;
      return s / a.length;
    };
    // Edges clamp, so the mean moves only a little.
    expect(Math.abs(mean(smoothDepth(noisy, n)) - mean(noisy))).toBeLessThan(2);
  });

  it('turns a step into a ramp no steeper than a fraction of the step', () => {
    const n = 64;
    const step = new Uint8Array(n * n);
    for (let j = 0; j < n; j++) for (let i = n / 2; i < n; i++) step[j * n + i] = 200;
    const out = smoothDepth(step, n);
    let worst = 0;
    for (let i = 1; i < n; i++)
      worst = Math.max(
        worst,
        Math.abs((out[32 * n + i] as number) - (out[32 * n + i - 1] as number)),
      );
    expect(worst).toBeLessThan(200 / MAP_SMOOTH_RADIUS / 1.5);
  });

  it('lights the slope that faces the north-west and shades the other', () => {
    const n = 32;
    // Depth rising to the east: the west side is the shallower one, towards the light.
    const ramp = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ramp[j * n + i] = i * 4;
    const { shade } = relief(ramp, n, []);
    expect(shade[16 * n + 16] as number).toBeGreaterThan(1);
    const reversed = ramp.map((_, o) => (n - 1 - (o % n)) * 4);
    expect(relief(reversed, n, []).shade[16 * n + 16] as number).toBeLessThan(1);
    // Never beyond the limit.
    for (const s of shade) expect(Math.abs(s - 1)).toBeLessThanOrEqual(RELIEF_LIMIT + 1e-6);
    // A flat grid is not shaded.
    const flat = relief(new Float32Array(n * n).fill(80), n, []);
    expect(flat.shade.every((s) => s === 1)).toBe(true);
  });

  it('draws an isobath where the depth crosses an edge and nowhere on a flat away from it', () => {
    const n = 32;
    const ramp = new Float32Array(n * n);
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) ramp[j * n + i] = i * 8;
    const { line } = relief(ramp, n, [96]);
    expect(Math.max(...line)).toBeGreaterThan(0.5);
    expect(line[16 * n + 4] as number).toBe(0);
    expect(line[16 * n + 28] as number).toBe(0);
  });

  it('leaves no hard circle at the spawn disc', () => {
    // Along rows through the pond's middle the depth bends where the centre cap opens (the disc's
    // edge). The map's depth must not: its bend, the second difference between neighbouring texels,
    // is a fraction of the raw field's.
    const n = ZONE_TEXTURE_SIZE;
    for (const seed of [SEED, [1, 2, 3, 4] as unknown as Seed]) {
      const grid = depthGrid(seed, WORLD, n);
      const smooth = smoothDepth(grid, n);
      for (const row of [n / 2, n / 2 - 28]) {
        let raw = 0;
        let soft = 0;
        for (let i = 1; i < n - 1; i++) {
          const o = row * n + i;
          raw = Math.max(
            raw,
            Math.abs((grid[o + 1] as number) - 2 * (grid[o] as number) + (grid[o - 1] as number)),
          );
          soft = Math.max(
            soft,
            Math.abs(
              (smooth[o + 1] as number) - 2 * (smooth[o] as number) + (smooth[o - 1] as number),
            ),
          );
        }
        expect(soft).toBeLessThan(0.6);
        expect(soft).toBeLessThan(raw / 3);
      }
    }
  });

  it('paints an opaque picture of the same size as the grid', () => {
    const n = ZONE_TEXTURE_SIZE;
    const px = mapPixels(depthGrid(SEED, WORLD, n), n);
    expect(px.length).toBe(n * n * 4);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
  });
});

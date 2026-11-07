import { describe, expect, it } from 'vitest';
import { followOrigin, ORIGIN_SLACK, ORIGIN_STEP, wrapTo } from './origin';

describe('the floating origin', () => {
  it('stays a multiple of 4,096 wu within 3,072 wu of the camera anywhere in the world', () => {
    const origin = { x: 0, y: 0 };
    // A swim across the whole world and back, and jumps to a lattice of points.
    const path: [number, number][] = [];
    for (let t = 0; t <= 262_144; t += 37) path.push([t, 262_144 - t * 0.7]);
    for (let j = 0; j <= 16; j++) for (let i = 0; i <= 16; i++) path.push([i * 16_384, j * 16_384]);
    path.push([250_000, 250_000], [131_072, 131_072], [0, 0]);
    for (const [x, y] of path) {
      followOrigin(origin, x, y);
      expect(origin.x % ORIGIN_STEP).toBe(0);
      expect(origin.y % ORIGIN_STEP).toBe(0);
      expect(Math.abs(x - origin.x)).toBeLessThanOrEqual(ORIGIN_SLACK);
      expect(Math.abs(y - origin.y)).toBeLessThanOrEqual(ORIGIN_SLACK);
    }
  });

  it('moves only past its slack, so a camera on a step boundary never flickers it', () => {
    const origin = { x: 4096, y: 0 };
    expect(followOrigin(origin, 4096 + 2048.5, 0)).toBe(false);
    expect(followOrigin(origin, 4096 + 2047.5, 0)).toBe(false);
    expect(followOrigin(origin, 4096 + 3073, 0)).toBe(true);
    expect(origin.x).toBe(8192);
    expect(followOrigin(origin, 8192 - 3000, 0)).toBe(false);
  });

  it('wraps a phase into [0, period)', () => {
    expect(wrapTo(-1, 10)).toBe(9);
    expect(wrapTo(250_000 / 18, 2 * Math.PI)).toBeCloseTo((250_000 / 18) % (2 * Math.PI), 9);
  });
});

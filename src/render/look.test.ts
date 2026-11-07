import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TAU } from '../sim/math';
import { viewHalfHeight } from '../sim/size';
import { CAUSTIC_WU, LOOK_HALF_HEIGHT, LookAnchor, lookScale } from './look';
import { wrapTo } from './origin';
import { causticShift } from './zones';

// M11 T17: the world-space look scales with the view, so a giant's screen reads like a starter's.

/** The folded-sine caustic of `caustics.glsl`, line for line in double precision. */
function caustic(px: number, py: number, t: number): number {
  let ix = px;
  let iy = py;
  let c = 1;
  for (let n = 0; n < 4; n++) {
    const tt = t * (1 - 3.5 / (n + 1));
    const nx = px + Math.cos(tt - ix) + Math.sin(tt + iy);
    const ny = py + Math.sin(tt - iy) + Math.cos(tt + ix);
    ix = nx;
    iy = ny;
    const sx = Math.max(Math.abs(Math.sin(ix + tt)), 1e-3);
    const cy = Math.max(Math.abs(Math.cos(iy + tt)), 1e-3);
    c += 1 / Math.hypot(0.44 / sx, 0.44 / cy);
  }
  c /= 4;
  return Math.min(1, Math.max(0, Math.abs(1.17 - c ** 1.4) ** 5));
}

/** The caustic light at a point `w` wu from the floating origin, as `causticAt` draws it. */
const causticAt = (wx: number, wy: number, scale: number, shift: [number, number]): number =>
  caustic(
    wrapTo(wx / (CAUSTIC_WU * scale) + shift[0], TAU),
    wrapTo(wy / (CAUSTIC_WU * scale) + shift[1], TAU),
    0.7,
  );

/** The mean width in pixels of the bright filaments along rows of a 1280 × 720 view. */
function filamentPx(halfHeight: number, camX: number, camY: number): number {
  const origin = { x: Math.round(camX / 4096) * 4096, y: Math.round(camY / 4096) * 4096 };
  const look = new LookAnchor();
  look.update(camX, camY, halfHeight, { x: 0, y: 0 });
  const shift: [number, number] = [
    causticShift(look.originX(origin.x)),
    causticShift(look.originY(origin.y)),
  ];
  const pxPerWu = 720 / (2 * halfHeight);
  let runs = 0;
  let lit = 0;
  for (let row = 0; row < 720; row += 24) {
    let on = false;
    for (let col = 0; col < 1280; col++) {
      const wx = camX - origin.x + (col - 640) / pxPerWu;
      const wy = camY - origin.y + (360 - row) / pxPerWu;
      const bright = causticAt(wx, wy, look.scale, shift) > 0.5;
      if (bright) lit++;
      if (bright && !on) runs++;
      on = bright;
    }
  }
  return lit / Math.max(1, runs);
}

describe('lookScale', () => {
  it('is 1 for a T0 adult and about 14.8 for a T2 adult of radius 400', () => {
    expect(LOOK_HALF_HEIGHT).toBeCloseTo(133.4, 1);
    expect(lookScale(viewHalfHeight(20, 20))).toBeCloseTo(1, 6);
    expect(lookScale(viewHalfHeight(400, 400))).toBeCloseTo(14.8, 1);
  });

  it('never shrinks the look below a starter adult’s', () => {
    expect(lookScale(viewHalfHeight(5, 20))).toBe(1);
    expect(lookScale(0)).toBe(1);
  });
});

describe('the caustics at every tier', () => {
  it('draws the filaments the same width in pixels for a T0 and a T2 adult, within 10%', () => {
    const t0 = filamentPx(viewHalfHeight(20, 20), 131_072, 131_072);
    const t2 = filamentPx(viewHalfHeight(400, 400), 131_072, 131_072);
    expect(t0).toBeGreaterThan(1);
    expect(Math.abs(t2 - t0) / t0).toBeLessThan(0.1);
  });

  it('scales the pattern in the shader by the look', () => {
    const glsl = readFileSync(new URL('./shaders/caustics.glsl', import.meta.url), 'utf8');
    expect(glsl).toContain(`w / (${CAUSTIC_WU.toFixed(1)} * uLookScale)`);
  });
});

describe('LookAnchor', () => {
  /** The pattern coordinate (wu at scale 1) of world point (x, y). */
  const at = (look: LookAnchor, origin: { x: number; y: number }, x: number, y: number) => ({
    x: look.originX(origin.x) + (x - origin.x) / look.scale,
    y: look.originY(origin.y) + (y - origin.y) / look.scale,
  });

  it('at a starter’s scale draws every pattern from the floating origin itself', () => {
    const look = new LookAnchor();
    const origin = { x: 131_072, y: 126_976 };
    look.update(131_100, 127_000, 133.4, { x: 0, y: 0 });
    look.update(132_500, 126_000, 133.4, { x: 30, y: -2 });
    expect(look.originX(origin.x)).toBeCloseTo(origin.x, 6);
    expect(look.originY(origin.y)).toBeCloseTo(origin.y, 6);
    expect(look.flow.x).toBeCloseTo(30, 9);
  });

  it('keeps the patterns put in the world while the camera swims at one scale', () => {
    const look = new LookAnchor();
    const origin = { x: 131_072, y: 131_072 };
    look.update(131_000, 131_000, 1977, { x: 0, y: 0 });
    const before = at(look, origin, 131_500, 130_700);
    look.update(131_400, 130_200, 1977, { x: 0, y: 0 });
    const after = at(look, origin, 131_500, 130_700);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
  });

  it('zooms the patterns about the camera as the view grows, so nothing sweeps across far from the centre', () => {
    const look = new LookAnchor();
    const origin = { x: 258_048, y: 258_048 };
    look.update(258_000, 258_100, 133.4, { x: 0, y: 0 });
    const centre = at(look, origin, 258_000, 258_100);
    look.update(258_000, 258_100, 140, { x: 0, y: 0 });
    const still = at(look, origin, 258_000, 258_100);
    expect(still.x).toBeCloseTo(centre.x, 6);
    expect(still.y).toBeCloseTo(centre.y, 6);
    expect(look.scale).toBeCloseTo(140 / LOOK_HALF_HEIGHT, 9);
  });

  it('carries the currents in the patterns’ own units', () => {
    const look = new LookAnchor();
    look.update(0, 0, 2 * LOOK_HALF_HEIGHT, { x: 100, y: 0 });
    look.update(0, 0, 2 * LOOK_HALF_HEIGHT, { x: 140, y: -20 });
    expect(look.flow.x - 100).toBeCloseTo(20, 9);
    expect(look.flow.y).toBeCloseTo(-10, 9);
  });
});

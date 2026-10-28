import { describe, expect, it } from 'vitest';
import { bokehShape, circleOfConfusion, DOF_LOOK, depthOfParallax, parallaxOfDepth } from './dof';

describe('circleOfConfusion', () => {
  it('is 0 at the focus plane on every preset', () => {
    for (const preset of ['low', 'medium', 'high'] as const) {
      expect(circleOfConfusion(0, 0, preset)).toBe(0);
      expect(circleOfConfusion(0.3, 0.3, preset)).toBe(0);
    }
  });

  it('grows linearly with the distance from the focus plane, on both sides', () => {
    for (const preset of ['medium', 'high'] as const) {
      expect(circleOfConfusion(0.1, 0, preset)).toBeCloseTo(2.4, 9);
      expect(circleOfConfusion(-0.1, 0, preset)).toBeCloseTo(2.4, 9);
      expect(circleOfConfusion(0.2, 0, preset)).toBeCloseTo(4.8, 9);
      expect(circleOfConfusion(0.45, 0.25, preset)).toBeCloseTo(4.8, 9);
    }
    expect(circleOfConfusion(-0.4, 0, 'high')).toBeCloseTo(9.6, 9);
  });

  it('stops at 6 px on medium and 12 px on high', () => {
    expect(circleOfConfusion(0.25, 0, 'medium')).toBe(6);
    expect(circleOfConfusion(-0.8, 0, 'medium')).toBe(6);
    expect(circleOfConfusion(0.5, 0, 'high')).toBe(12);
    expect(circleOfConfusion(-3, 0, 'high')).toBe(12);
  });

  it('is always 0 on low, which keeps its fake bokeh sprites', () => {
    expect(circleOfConfusion(-0.8, 0, 'low')).toBe(0);
    expect(circleOfConfusion(0.4, 0, 'low')).toBe(0);
  });
});

describe('depth and parallax', () => {
  it('puts the plane at depth 0, layers behind it below 0 and in front above it', () => {
    expect(depthOfParallax(1)).toBe(0);
    expect(depthOfParallax(0.55)).toBeLessThan(-0.8);
    expect(depthOfParallax(1.6)).toBeCloseTo(0.375, 9);
    for (const p of [0.55, 0.8, 1, 1.25, 1.6])
      expect(parallaxOfDepth(depthOfParallax(p))).toBeCloseTo(p, 9);
  });

  it('blurs the far and near layers of today to the cap or close to it', () => {
    expect(circleOfConfusion(depthOfParallax(0.55), 0, 'high')).toBe(DOF_LOOK.maxPx.high);
    expect(circleOfConfusion(depthOfParallax(1.6), 0, 'high')).toBeGreaterThan(
      DOF_LOOK.maxPx.high / 2,
    );
    expect(circleOfConfusion(depthOfParallax(1.6), 0, 'medium')).toBe(DOF_LOOK.maxPx.medium);
  });
});

/** The light a sprite of this shape carries: its profile integrated over the disc. */
function energy(shape: { inner: number; outer: number; peak: number }): number {
  // 1 - smoothstep(inner, outer, d), integrated in closed form: pi (a^2 + a w + 0.3 w^2).
  const a = shape.inner;
  const w = shape.outer - shape.inner;
  return shape.peak * Math.PI * (a * a + a * w + 0.3 * w * w);
}

describe('bokehShape', () => {
  it('without blur is the sprite of today: a soft dot or a hard-edged disc', () => {
    expect(bokehShape(20, 0, 0)).toEqual({ inner: 0, outer: 10, peak: 1 });
    const disc = bokehShape(100, 1, 0);
    expect(disc.inner).toBeCloseTo(42, 9);
    expect(disc.outer).toBeCloseTo(50, 9);
    expect(disc.peak).toBe(1);
  });

  it('widens the edge by the blur on both sides and keeps the light it carries', () => {
    const sharp = bokehShape(100, 1, 0);
    const blurred = bokehShape(100, 1, 12);
    expect(blurred.inner).toBeCloseTo(sharp.inner - 12, 9);
    expect(blurred.outer).toBeCloseTo(sharp.outer + 12, 9);
    expect(energy(blurred)).toBeCloseTo(energy(sharp), 6);
  });

  it('spreads a speck smaller than its blur into a dimmer disc of the blur size', () => {
    const sharp = bokehShape(4, 0, 0);
    const blurred = bokehShape(4, 0, 6);
    expect(blurred.outer).toBeCloseTo(8, 9);
    expect(blurred.inner).toBeGreaterThan(0);
    expect(blurred.peak).toBeLessThan(0.25);
    expect(energy(blurred)).toBeCloseTo(energy(sharp), 6);
  });

  it('never brightens a sprite', () => {
    for (const size of [1, 3, 8, 40, 200]) {
      for (const hard of [0, 1]) {
        for (const coc of [0, 0.5, 2, 6, 12]) {
          const shape = bokehShape(size, hard, coc);
          expect(shape.peak).toBeGreaterThan(0);
          expect(shape.peak).toBeLessThanOrEqual(1);
          expect(shape.outer).toBeCloseTo(size / 2 + coc, 9);
        }
      }
    }
  });
});

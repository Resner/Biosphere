import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { CAMERA_DEPTH, FollowCamera, topDownCamera, viewHalfHeight } from './camera';
import { BODY_DEPTH } from './creature-mesh';

/** A genesis cell hatches at 100 biomass (radius 10) and the adult maximum is 300 to 2.4 million. */
const ADULTS = [300, 500, 800, 5000, 100_000, 2_457_600].map((b) => Math.sqrt(b));

describe('viewHalfHeight', () => {
  it('keeps the longest body (maxReach core radii) inside the view at every size', () => {
    for (const adult of ADULTS) {
      for (let r = 5; r <= adult; r *= 1.05) {
        expect(RULES.body.maxReach * r).toBeLessThan(viewHalfHeight(r, adult));
      }
    }
  });

  it('is about 71 wu for an adult starter, as before growth showed', () => {
    expect(viewHalfHeight(10, 10)).toBeCloseTo(71.4, 0);
  });

  it('shows an adult the same view at every maximum size', () => {
    for (const adult of ADULTS) {
      expect(viewHalfHeight(adult, adult)).toBeCloseTo(9 * adult ** 0.9, 9);
    }
  });

  it('shows at least as many radii as the old curve did, so a hatchling is never cramped', () => {
    for (const adult of ADULTS) {
      for (let r = 5; r <= adult; r *= 1.05) {
        expect(viewHalfHeight(r, adult) / r).toBeGreaterThanOrEqual(9 * r ** -0.1 - 1e-9);
      }
    }
    expect(viewHalfHeight(10, 17.3) / 10).toBeGreaterThanOrEqual(7.15);
  });

  it('makes a creature that triples its radius at least 1.5x larger on screen', () => {
    for (const adult of ADULTS) {
      const from = adult / 3;
      if (from < 5) continue;
      const before = from / viewHalfHeight(from, adult);
      const after = adult / viewHalfHeight(adult, adult);
      expect(after / before).toBeGreaterThanOrEqual(1.5);
    }
  });

  it('is monotonic in size and keeps the creature a readable share of the view', () => {
    for (const adult of ADULTS) {
      let prev = 0;
      for (let r = adult / 3.2; r <= adult; r *= 1.02) {
        const h = viewHalfHeight(r, adult);
        expect(h).toBeGreaterThan(prev);
        prev = h;
        expect(r / h).toBeGreaterThanOrEqual(0.08);
        expect(r / h).toBeLessThanOrEqual(0.3);
      }
    }
  });

  it('stays finite for a creature with no size', () => {
    expect(viewHalfHeight(0, 0)).toBe(0);
  });

  it('treats a creature above its stated maximum as an adult', () => {
    expect(viewHalfHeight(30, 20)).toBeCloseTo(9 * 30 ** 0.9, 9);
  });
});

describe('FollowCamera', () => {
  it('snaps to its first target', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 50, y: -20, radius: 10, adult: 20 });
    expect(cam.x).toBe(50);
    expect(cam.y).toBe(-20);
    expect(cam.halfHeight).toBeCloseTo(viewHalfHeight(10, 20), 9);
  });

  it('eases to a larger view within 1.5 s without overshoot', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 0, y: 0, radius: 10, adult: 40 });
    const from = cam.halfHeight;
    const to = viewHalfHeight(20, 40);
    let prev = from;
    for (let i = 0; i < 90; i++) {
      cam.update(1 / 60, { x: 0, y: 0, radius: 20, adult: 40 });
      expect(cam.halfHeight).toBeGreaterThanOrEqual(prev);
      expect(cam.halfHeight).toBeLessThanOrEqual(to * 1.05);
      prev = cam.halfHeight;
    }
    expect(Math.abs(cam.halfHeight - to) / (to - from)).toBeLessThan(0.05);
  });

  it('is frame-rate independent', () => {
    const run = (dt: number, n: number) => {
      const cam = new FollowCamera();
      cam.update(dt, { x: 0, y: 0, radius: 10, adult: 40 });
      for (let i = 0; i < n; i++) cam.update(dt, { x: 0, y: 0, radius: 20, adult: 40 });
      return cam.halfHeight;
    };
    expect(run(1 / 30, 15)).toBeCloseTo(run(1 / 120, 60), 9);
  });

  it('tracks the creature position exactly', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 0, y: 0, radius: 10, adult: 40 });
    cam.update(1 / 60, { x: 33, y: 44, radius: 10, adult: 40 });
    expect([cam.x, cam.y]).toEqual([33, 44]);
  });
});

describe('topDownCamera', () => {
  it('reaches past the top of the tallest body at the largest radius a snapshot can carry', () => {
    const camera = topDownCamera();
    // The dorsal peak: half-width times the body depth times the tallest plate lift, in core radii.
    const lift = 1 + (RULES.develop.plateThickness[1] as number);
    const tallest = RULES.body.maxReach * BODY_DEPTH * lift * Math.sqrt(2 ** 24);
    expect(CAMERA_DEPTH).toBeGreaterThan(tallest);
    expect(camera.position.z - camera.near).toBeGreaterThan(tallest);
    expect(camera.position.z - camera.far).toBeLessThan(-tallest);
  });
});

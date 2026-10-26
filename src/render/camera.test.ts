import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import { CAMERA_DEPTH, FollowCamera, topDownCamera, viewHalfHeight } from './camera';
import { BODY_DEPTH } from './creature-mesh';

describe('viewHalfHeight', () => {
  it('keeps the longest body (maxReach core radii) inside the view at every size', () => {
    for (let r = 5; r <= 4096; r *= 1.05) {
      expect(RULES.body.maxReach * r).toBeLessThan(viewHalfHeight(r));
    }
  });

  it('is about 71 wu for a starter', () => {
    expect(viewHalfHeight(10)).toBeCloseTo(71.4, 0);
  });

  it('is monotonic and keeps the creature a readable share of the view', () => {
    let prev = 0;
    for (let r = 5; r <= 4096; r *= 1.05) {
      const h = viewHalfHeight(r);
      expect(h).toBeGreaterThan(prev);
      prev = h;
      expect(r / h).toBeGreaterThanOrEqual(0.1);
      expect(r / h).toBeLessThanOrEqual(0.3);
    }
  });
});

describe('FollowCamera', () => {
  it('snaps to its first target', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 50, y: -20, radius: 10 });
    expect(cam.x).toBe(50);
    expect(cam.y).toBe(-20);
    expect(cam.halfHeight).toBeCloseTo(viewHalfHeight(10), 9);
  });

  it('eases to a larger view within 1.5 s without overshoot', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 0, y: 0, radius: 10 });
    const from = cam.halfHeight;
    const to = viewHalfHeight(20);
    let prev = from;
    for (let i = 0; i < 90; i++) {
      cam.update(1 / 60, { x: 0, y: 0, radius: 20 });
      expect(cam.halfHeight).toBeGreaterThanOrEqual(prev);
      expect(cam.halfHeight).toBeLessThanOrEqual(to * 1.05);
      prev = cam.halfHeight;
    }
    expect(Math.abs(cam.halfHeight - to) / (to - from)).toBeLessThan(0.05);
  });

  it('is frame-rate independent', () => {
    const run = (dt: number, n: number) => {
      const cam = new FollowCamera();
      cam.update(dt, { x: 0, y: 0, radius: 10 });
      for (let i = 0; i < n; i++) cam.update(dt, { x: 0, y: 0, radius: 20 });
      return cam.halfHeight;
    };
    expect(run(1 / 30, 15)).toBeCloseTo(run(1 / 120, 60), 9);
  });

  it('tracks the creature position exactly', () => {
    const cam = new FollowCamera();
    cam.update(1 / 60, { x: 0, y: 0, radius: 10 });
    cam.update(1 / 60, { x: 33, y: 44, radius: 10 });
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

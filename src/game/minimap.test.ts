import { describe, expect, it } from 'vitest';
import { RULES } from '../sim/rules';
import {
  DEPTH_ARC,
  depthArcAngle,
  MINIMAP,
  minimapCorner,
  minimapHazard,
  minimapMark,
  minimapSide,
  onMinimap,
} from './minimap';
import type { ZoneReadout } from './zone-readout';

const readout = (over: Partial<ZoneReadout>): ZoneReadout => ({
  zone: 'twilight',
  name: 'Twilight',
  depth: 0.4,
  uv: false,
  pressure: false,
  ...over,
});

describe('the minimap (M6b T10)', () => {
  it('is 12% of the short side, and at least 120 px', () => {
    expect(minimapSide(1280, 720)).toBe(120);
    expect(minimapSide(960, 540)).toBe(120);
    expect(minimapSide(1920, 1080)).toBe(Math.round(0.12 * 1080));
    expect(minimapSide(2560, 1440)).toBe(Math.round(0.12 * 1440));
    expect(minimapSide(1440, 2560)).toBe(Math.round(0.12 * 1440));
    expect(MINIMAP.views).toBe(6);
  });

  it('is north-up and centred on the player, with its rim at the radius', () => {
    const side = 120;
    const out = { x: 0, y: 0, inside: false };
    // East is right, north is up (CSS y grows down).
    onMinimap(0, 0, 300, side, out);
    expect(out).toEqual({ x: 60, y: 60, inside: true });
    onMinimap(300, 0, 300, side, out);
    expect(out.x).toBeCloseTo(120, 9);
    expect(out.y).toBeCloseTo(60, 9);
    expect(out.inside).toBe(true);
    onMinimap(0, 150, 300, side, out);
    expect(out.x).toBeCloseTo(60, 9);
    expect(out.y).toBeCloseTo(30, 9);
    onMinimap(-250, -250, 300, side, out);
    expect(out.inside).toBe(false);
    // The bearing on the minimap is the world bearing.
    for (let deg = -180; deg < 180; deg += 15) {
      const a = (deg * Math.PI) / 180;
      onMinimap(200 * Math.cos(a), 200 * Math.sin(a), 300, side, out);
      const seen = (Math.atan2(60 - out.y, out.x - 60) * 180) / Math.PI;
      expect(Math.abs(((seen - deg + 540) % 360) - 180), `${deg}`).toBeLessThan(1e-6);
    }
  });

  it('marks players by size class (the edge arrows’ classes), mate-ready ones with a heart', () => {
    expect(minimapMark(10, { radius: 10, ready: false })).toBe('comparable');
    expect(minimapMark(10, { radius: 40, ready: false })).toBe('bigger');
    expect(minimapMark(40, { radius: 10, ready: false })).toBe('smaller');
    expect(minimapMark(10, { radius: 40, ready: true })).toBe('ready');
  });

  it('runs the depth arc down its right rim, surface at the top, the abyss floor at the bottom', () => {
    expect(depthArcAngle(0)).toBeCloseTo(DEPTH_ARC.from, 9);
    expect(depthArcAngle(1)).toBeCloseTo(DEPTH_ARC.to, 9);
    expect(depthArcAngle(-1)).toBeCloseTo(DEPTH_ARC.from, 9);
    expect(depthArcAngle(2)).toBeCloseTo(DEPTH_ARC.to, 9);
    // On the right side (cos > 0), going down the screen (sin, with y down, rising).
    let last = -Infinity;
    for (let d = 0; d <= 1; d += 0.1) {
      const a = depthArcAngle(d);
      expect(Math.cos(a)).toBeGreaterThan(0);
      expect(Math.sin(a)).toBeGreaterThan(last);
      last = Math.sin(a);
    }
    // The zone edges sit in order along it.
    const z = RULES.bathymetry.zones;
    expect(depthArcAngle(z.shallows)).toBeLessThan(depthArcAngle(z.twilight));
    expect(depthArcAngle(z.twilight)).toBeLessThan(depthArcAngle(z.deep));
  });

  it('shows the hazard that hurts now, UV or pressure', () => {
    expect(minimapHazard(readout({}))).toBeNull();
    expect(minimapHazard(readout({ zone: 'shallows', uv: true }))).toBe('uv');
    expect(minimapHazard(readout({ zone: 'abyss', pressure: true }))).toBe('pressure');
  });

  it('keeps the edge indicators out of its corner', () => {
    for (const [w, h] of [
      [960, 540],
      [1280, 720],
      [2560, 1440],
    ] as const) {
      const side = minimapSide(w, h);
      const corner = minimapCorner(w, h);
      expect(corner.corner).toBe('top-right');
      expect(corner.w).toBeGreaterThan(side + MINIMAP.inset);
      expect(corner.h).toBeGreaterThan(MINIMAP.top + side);
    }
  });
});

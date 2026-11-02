import { describe, expect, it } from 'vitest';
import {
  ArrowLayer,
  DrawClock,
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

  it('turns its arrow with the heading on every frame, within 1° (M6c T12)', () => {
    // The arrow is a CSS-rotated layer over the canvas: a 1 s fast turn at 60 frames a second,
    // two and a half turns each way, through headings beyond ±π as the interpolated cell has.
    const el = { style: { transform: '' } };
    const arrow = new ArrowLayer(el);
    let writes = 0;
    let last = '';
    const frames = 60;
    for (let f = 0; f <= frames; f++) {
      const t = f / frames;
      const heading = 5 * Math.PI * Math.sin(Math.PI * t) - 0.3 + 7 * t;
      arrow.set(heading);
      const shown = /^rotate\((-?[\d.]+)deg\)$/.exec(el.style.transform);
      expect(shown, el.style.transform).not.toBeNull();
      // CSS turns clockwise with y down; the heading turns counter-clockwise from east.
      const deg = -Number(shown?.[1]);
      const want = (heading * 180) / Math.PI;
      expect(Math.abs(((((deg - want) % 360) + 540) % 360) - 180), `frame ${f}`).toBeLessThan(1);
      if (el.style.transform !== last) writes++;
      last = el.style.transform;
    }
    // A fast turn changes the arrow on every frame.
    expect(writes).toBe(frames + 1);
    // The same transform string for the same heading: nothing new per frame.
    arrow.set(1);
    const a = el.style.transform;
    arrow.set(1 + 2 * Math.PI);
    expect(el.style.transform).toBe(a);
  });

  it('draws the map at most 30 times a second, whatever the frame rate (M6c T12)', () => {
    expect(MINIMAP.hz).toBe(30);
    for (const fps of [30, 59.94, 60, 75, 120, 144, 240]) {
      const clock = new DrawClock(MINIMAP.hz);
      let draws = 0;
      // Two seconds of frames, with a little jitter.
      for (let f = 0; f * (1000 / fps) < 2000; f++) {
        const now = 1000 + f * (1000 / fps) + (f % 3 === 1 ? 1.5 : 0);
        if (clock.due(now)) draws++;
      }
      expect(draws, `${fps} fps`).toBeLessThanOrEqual(2 * 31);
      expect(draws, `${fps} fps`).toBeGreaterThanOrEqual(Math.min(fps, 30) * 2 * 0.9);
    }
    // A long frame does not bring a burst of catch-up draws; an invalidate draws at once.
    const clock = new DrawClock(MINIMAP.hz);
    expect(clock.due(0)).toBe(true);
    expect(clock.due(500)).toBe(true);
    expect(clock.due(516)).toBe(false);
    expect(clock.due(534)).toBe(true);
    clock.reset();
    expect(clock.due(540)).toBe(true);
  });
});

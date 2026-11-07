import { describe, expect, it } from 'vitest';
import { type ParticleStyle, SPARKLE } from './materials';
import { ParticleLayer } from './particles';
import type { SpriteDof } from './post/chain';
import type { SceneView } from './scene';

// Marine snow v2 (M6 T17): specks carried by the currents, and a few bright ones on high.

const STYLE: ParticleStyle = {
  size: 1.1,
  period: 640,
  color: 0xffffff,
  opacity: 0.7,
  bokeh: 0,
  parallax: 1,
  spread: 0.2,
};
const NO_DOF: SpriteDof = { pixels: 1, shrink: 1, focus: 0, slope: 0, max: 0, fringe: 0 };
const view = (time: number) => ({ time, waterTime: time, camX: 1000, camY: 2000 }) as SceneView;
/** A starter's look (M11 T17): the virtual camera is the camera, and `flow` the currents' carry. */
const look = (flow: { x: number; y: number }, scale = 1) => ({
  scale,
  cam: { x: 1000, y: 2000 },
  flow,
});
/** Two pixels a world unit on a screen wider than the whole tile: every speck is on it. */
const PX = 2;
const SCREEN = 4000;
const TILE = STYLE.period * PX;
const wrap = (v: number): number => {
  const m = (((v + TILE / 2) % TILE) + TILE) % TILE;
  return m - TILE / 2;
};

describe('ParticleLayer', () => {
  it('carries every speck with the water by the flow, wrapped to its tile', () => {
    const layer = new ParticleLayer(400, 5, STYLE);
    layer.update(view(3), PX, NO_DOF, 1, look({ x: 0, y: 0 }));
    const still = layer.specks(PX, SCREEN, SCREEN);
    expect(still.length).toBe(400);
    for (const flow of [
      { x: 10, y: -4 },
      { x: STYLE.period * 1000 + 10, y: -4 },
    ]) {
      layer.update(view(3), PX, NO_DOF, 1, look(flow));
      const carried = layer.specks(PX, SCREEN, SCREEN);
      expect(carried.length).toBe(400);
      for (const [i, s] of carried.entries()) {
        const before = still[i] as (typeof still)[number];
        expect(s.index).toBe(before.index);
        // Screen y grows downwards.
        expect(wrap(s.x - before.x - 10 * PX)).toBeCloseTo(0, 2);
        expect(wrap(s.y - before.y - 4 * PX)).toBeCloseTo(0, 2);
      }
    }
    layer.dispose();
  });

  it('turns a few specks bright only where the style allows and the preset asks', () => {
    const plain = new ParticleLayer(2000, 23, STYLE);
    plain.setSparkle(true);
    plain.update(view(1), PX, NO_DOF, 1, look({ x: 0, y: 0 }));
    expect(plain.specks(PX, SCREEN, SCREEN).some((s) => s.bright)).toBe(false);
    plain.dispose();

    const layer = new ParticleLayer(2000, 23, { ...STYLE, sparkle: 0.03 });
    layer.update(view(1), PX, NO_DOF, 1, look({ x: 0, y: 0 }));
    const off = layer.specks(PX, SCREEN, SCREEN);
    expect(off.some((s) => s.bright)).toBe(false);

    layer.setSparkle(true);
    layer.update(view(1), PX, NO_DOF, 1, look({ x: 0, y: 0 }));
    const on = layer.specks(PX, SCREEN, SCREEN);
    const bright = on.filter((s) => s.bright);
    // Occasional: a few in a hundred.
    expect(bright.length / on.length).toBeGreaterThan(0.015);
    expect(bright.length / on.length).toBeLessThan(0.05);
    for (const s of bright) {
      const dim = off[s.index] as (typeof off)[number];
      expect(s.size).toBeCloseTo(dim.size * SPARKLE.size, 5);
    }
    // The rest are untouched.
    for (const s of on.filter((x) => !x.bright)) {
      expect(s.size).toBe((off[s.index] as (typeof off)[number]).size);
    }
    layer.dispose();
  });

  it('draws a giant’s snow as a starter sees it: offsets and sizes grow with the look (M11 T17)', () => {
    const layer = new ParticleLayer(400, 5, STYLE);
    layer.update(view(3), PX, NO_DOF, 1, look({ x: 7, y: 3 }));
    const starter = layer.specks(PX, SCREEN, SCREEN);
    // A view 4 times as tall: a quarter of the pixels per wu, and the look 4 times as large.
    layer.update(view(3), PX / 4, NO_DOF, 1, look({ x: 7, y: 3 }, 4));
    const giant = layer.specks(PX / 4, SCREEN, SCREEN);
    expect(giant.length).toBe(starter.length);
    for (const [i, s] of giant.entries()) {
      const before = starter[i] as (typeof starter)[number];
      expect(s.index).toBe(before.index);
      expect(s.x).toBeCloseTo(before.x, 6);
      expect(s.y).toBeCloseTo(before.y, 6);
      expect(s.size).toBeCloseTo(before.size, 6);
    }
    layer.dispose();
  });
});

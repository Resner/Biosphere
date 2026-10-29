import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { decodeGenome } from '../genome/codec';
import { develop } from '../genome/develop';
import { express } from '../genome/express';
import { GENOME_BYTES } from '../genome/karyotype';
import { starterGenome } from '../genome/starter';
import { buildCreature } from '../genome/stats';
import { createRng, seedFromString } from '../sim/prng';
import { hullOf, OUTLINE, OutlineLayer, outlineKind, outlinePulse, ringRadius } from './outlines';
import type { RemoteCellView } from './remotes';

const remote = (
  id: string,
  radius: number,
  over: Partial<RemoteCellView> = {},
): RemoteCellView => ({
  id,
  x: 0,
  y: 0,
  heading: 0,
  radius,
  beat: 0,
  alpha: 1,
  hue: 0.3,
  ...over,
});

describe('outlineKind', () => {
  it('rings a creature a tier bigger or smaller, and leaves a comparable one bare', () => {
    // Tier edges are at radius 32, 128 and 512.
    expect(outlineKind(20, 40)).toBe('bigger');
    expect(outlineKind(20, 600)).toBe('bigger');
    expect(outlineKind(20, 25)).toBeNull();
    expect(outlineKind(40, 100)).toBeNull();
    expect(outlineKind(40, 20)).toBe('smaller');
  });
});

describe('outlinePulse', () => {
  it('beats on a bigger creature and holds still on a smaller one', () => {
    const big = Array.from({ length: 40 }, (_, i) => outlinePulse('bigger', i * 0.05, 0.3));
    expect(Math.min(...big)).toBeLessThan(0.1);
    expect(Math.max(...big)).toBeGreaterThan(0.9);
    for (const v of big) expect(v).toBeGreaterThanOrEqual(0);
    for (const v of big) expect(v).toBeLessThanOrEqual(1);
    // One beat lasts the period.
    expect(outlinePulse('bigger', 0.2, 0)).toBeCloseTo(
      outlinePulse('bigger', 0.2 + OUTLINE.period, 0),
    );
    for (let t = 0; t < 2; t += 0.1) expect(outlinePulse('smaller', t, 0.3)).toBe(0);
  });
});

describe('hullOf', () => {
  it('is the unit circle for the plain cell', () => {
    expect(hullOf(null)).toEqual({ x: 0, y: 0, radius: 1 });
  });

  it('holds every body segment of a plan', () => {
    const rng = createRng(seedFromString('outline-tests'), 'bytes');
    for (let i = 0; i < 200; i++) {
      const bytes = Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);
      const plan = develop(express(decodeGenome(bytes)));
      const hull = hullOf(plan);
      expect(Number.isFinite(hull.radius)).toBe(true);
      for (const s of plan.segments) {
        const reach = Math.hypot(s.x - hull.x, s.y - hull.y) + Math.max(s.rx, s.ry);
        expect(reach).toBeLessThanOrEqual(hull.radius + 1e-9);
      }
      // The circle hugs the body, not the bounds of its parts.
      expect(hull.radius).toBeLessThanOrEqual(2.5);
    }
  });
});

describe('ringRadius', () => {
  it('sits outside the hull, by at least a few pixels at any zoom', () => {
    expect(ringRadius(1, 10, 4)).toBeGreaterThanOrEqual(10 + OUTLINE.minGapPx / 4);
    expect(ringRadius(1, 10, 0.1)).toBeGreaterThanOrEqual(10 + OUTLINE.minGapPx / 0.1);
    expect(ringRadius(2, 10, 4)).toBeGreaterThanOrEqual(20 * (1 + OUTLINE.gap));
  });
});

describe('OutlineLayer', () => {
  const body = buildCreature(starterGenome());

  it('draws one outline per bigger or smaller remote, none for comparable, ghosts or the faded', () => {
    const layer = new OutlineLayer();
    const scene = new THREE.Scene();
    scene.add(layer.mesh);
    const view = { camX: 0, camY: 0, pxPerWu: 2, width: 960, height: 540 };
    layer.set(
      [
        remote('big', 130, { x: 50, body }),
        remote('same', 50),
        remote('small', 10, { x: -50 }),
        remote('ghost', 130, { dissolve: 0.4 }),
        remote('faded', 130, { alpha: 0.005 }),
      ],
      40,
      0,
      view,
    );
    expect(layer.drawn().map((o) => [o.id, o.kind])).toEqual([
      ['big', 'bigger'],
      ['small', 'smaller'],
    ]);
    expect(layer.counts()).toEqual({ bigger: 1, smaller: 1 });
    expect(layer.mesh.count).toBe(2);
    expect(layer.mesh.visible).toBe(true);
    // Drawn in CSS pixels: the small one sits 100 px left of the centre.
    const small = layer.drawn()[1];
    expect(small?.x).toBeCloseTo(480 - 100);
    expect(small?.y).toBeCloseTo(270);
    expect(small?.radius).toBeGreaterThanOrEqual(10 * 2 + OUTLINE.minGapPx);
    layer.dispose();
  });

  it('draws nothing without a player, and stays within its capacity', () => {
    const layer = new OutlineLayer();
    const view = { camX: 0, camY: 0, pxPerWu: 2, width: 960, height: 540 };
    layer.set([remote('big', 40)], null, 0, view);
    expect(layer.mesh.count).toBe(0);
    expect(layer.mesh.visible).toBe(false);
    const many = Array.from({ length: OUTLINE.capacity + 5 }, (_, i) => remote(`r${i}`, 40));
    layer.set(many, 20, 0, view);
    expect(layer.mesh.count).toBe(OUTLINE.capacity);
    expect(layer.drawn()).toHaveLength(OUTLINE.capacity);
    layer.dispose();
  });
});

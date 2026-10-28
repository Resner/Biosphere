import { describe, expect, it } from 'vitest';
import { depthAt, type Zone, zoneAt } from '../sim/bathymetry';
import { seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import {
  depthGrid,
  glowAt,
  LIGHT_RADII,
  lightOf,
  nearestInZone,
  SIGHT_MIN_RADII,
  sightAt,
  sightRadius,
  wellInside,
  ZONE_LOOK,
  ZONES,
  zoneBlend,
  zoneGlsl,
  zoneWeights,
} from './zones';

const lum = ([r, g, b]: readonly number[]): number =>
  0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
const mid = (zone: Zone): number => {
  const e = RULES.bathymetry.zones;
  return {
    shallows: e.shallows / 2,
    twilight: (e.shallows + e.twilight) / 2,
    deep: (e.twilight + e.deep) / 2,
    abyss: (e.deep + 1) / 2,
  }[zone];
};

describe('zone look', () => {
  it('weights a zone fully inside it and blends only across the edge bands', () => {
    ZONES.forEach((zone, i) => {
      const w = zoneWeights(mid(zone));
      expect(w[i]).toBeCloseTo(1, 9);
    });
    for (let d = 0; d <= 1; d += 0.005) {
      const w = zoneWeights(d);
      expect(w.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
    }
    const edge = zoneWeights(RULES.bathymetry.zones.twilight);
    expect(edge[1]).toBeCloseTo(0.5, 6);
    expect(edge[2]).toBeCloseTo(0.5, 6);
  });

  it('darkens strictly from the shallows to the abyss, in the hues the spec names', () => {
    const levels = ZONES.map((z) => lum(ZONE_LOOK[z].water) + lum(ZONE_LOOK[z].haze));
    for (let i = 1; i < levels.length; i++) {
      expect(levels[i] as number).toBeLessThan((levels[i - 1] as number) * 0.6);
    }
    const [sr, sg, sb] = ZONE_LOOK.shallows.haze;
    // Shallows: cyan-green, green leading.
    expect(sg).toBeGreaterThan(sb);
    expect(sb).toBeGreaterThan(sr);
    // Twilight and deep: blue leads.
    for (const zone of ['twilight', 'deep'] as const) {
      const [r, g, b] = ZONE_LOOK[zone].haze;
      expect(b).toBeGreaterThan(g);
      expect(g).toBeGreaterThan(r);
    }
    expect(lum(ZONE_LOOK.abyss.haze)).toBeLessThan(0.01);
    // The look is monotonic over depth too, edge bands included.
    let last = Number.POSITIVE_INFINITY;
    for (let d = 0; d <= 1; d += 0.005) {
      const w = zoneWeights(d);
      const brightness = ZONES.reduce(
        (sum, z, i) => sum + (w[i] as number) * (lum(ZONE_LOOK[z].water) + lum(ZONE_LOOK[z].haze)),
        0,
      );
      expect(brightness).toBeLessThanOrEqual(last + 1e-12);
      last = brightness;
      // The scalars blend with the same weights.
      const dark = ZONES.reduce((sum, z, i) => sum + (w[i] as number) * ZONE_LOOK[z].dark, 0);
      expect(zoneBlend(d, 'dark')).toBeCloseTo(dark, 12);
    }
  });

  it('dims beyond the sight ring only in the deep and the abyss, never to nothing', () => {
    expect(ZONE_LOOK.shallows.dark).toBe(0);
    expect(ZONE_LOOK.twilight.dark).toBe(0);
    expect(ZONE_LOOK.deep.dark).toBeGreaterThan(0);
    expect(ZONE_LOOK.abyss.dark).toBeGreaterThan(ZONE_LOOK.deep.dark);
    expect(ZONE_LOOK.abyss.dark).toBeLessThan(1);
    // Glow from creatures matters most where the water is darkest.
    expect(ZONE_LOOK.abyss.glow).toBeGreaterThan(ZONE_LOOK.twilight.glow);
  });

  it('writes the table into the shader chunk', () => {
    const glsl = zoneGlsl();
    expect(glsl).toContain('uniform sampler2D tZoneDepth');
    expect(glsl).toContain(
      `const vec4 ZONE_DARK = vec4(${ZONES.map((z) => ZONE_LOOK[z].dark.toFixed(4)).join(', ')})`,
    );
    expect(glsl).toContain('float zoneSight(');
  });
});

describe('depthGrid', () => {
  it('samples depthAt at texel centres, a byte per texel', () => {
    const seed = seedFromString('grid');
    const n = 32;
    const size = RULES.world.size;
    const grid = depthGrid(seed, size, n);
    expect(grid).toHaveLength(n * n);
    for (const [i, j] of [
      [0, 0],
      [5, 17],
      [31, 31],
      [16, 3],
    ] as const) {
      const x = ((i + 0.5) * size) / n;
      const y = ((j + 0.5) * size) / n;
      expect(Math.abs((grid[j * n + i] as number) / 255 - depthAt(seed, x, y))).toBeLessThanOrEqual(
        0.5 / 255 + 1e-9,
      );
    }
  });
});

describe('sight and glow', () => {
  it('sees within the detection ring, never less than the minimum', () => {
    expect(sightRadius(3, 10)).toBe(30);
    expect(sightRadius(1, 10)).toBe(SIGHT_MIN_RADII * 10);
  });

  it('sees a whole body clearly within the ring, in lit water, and anywhere outside dark zones', () => {
    const abyss = mid('abyss');
    expect(sightAt(mid('twilight'), 500, 20, 0)).toBe(1);
    expect(sightAt(abyss, 10, 20, 0)).toBe(1);
    expect(sightAt(abyss, 40, 20, 0)).toBeCloseTo(1 - ZONE_LOOK.abyss.dark, 9);
    expect(sightAt(abyss, 40, 20, 1)).toBe(1);
    const half = sightAt(abyss, 30, 20, 0);
    expect(half).toBeGreaterThan(1 - ZONE_LOOK.abyss.dark);
    expect(half).toBeLessThan(1);
    expect(glowAt(0, 60, 0.8)).toBeCloseTo(0.8, 9);
    expect(glowAt(60, 60, 0.8)).toBe(0);
  });

  it('lights a pool only for an expressed luminescence allele', () => {
    expect(lightOf({ luminescence: 0, lumColor: [1, 0, 0] }, 10)).toBeNull();
    expect(lightOf({ luminescence: 0.8, lumColor: [0, 1, 0.5] }, 10)).toEqual({
      radius: LIGHT_RADII * 10,
      strength: 0.8,
      color: [0, 1, 0.5],
    });
  });
});

describe('nearestInZone', () => {
  const size = RULES.world.size;
  it('lands well inside the zone asked for, and stays put when already there', () => {
    for (const name of ['a', 'b', 'c']) {
      const seed = seedFromString(name);
      for (const zone of ZONES) {
        const p = nearestInZone(seed, size, size / 2, size / 2, zone);
        expect(zoneAt(seed, p.x, p.y)).toBe(zone);
        expect(p.x).toBeGreaterThan(0);
        expect(p.x).toBeLessThan(size);
        expect(p.y).toBeGreaterThan(0);
        expect(p.y).toBeLessThan(size);
        // Its surroundings share the zone too, so a screenful of water shows it.
        for (const [dx, dy] of [
          [64, 0],
          [-64, 0],
          [0, 64],
          [0, -64],
        ] as const) {
          expect(zoneAt(seed, p.x + dx, p.y + dy)).toBe(zone);
        }
      }
    }
    const seed = seedFromString('a');
    const p = nearestInZone(seed, size, size / 2, size / 2, 'deep');
    expect(nearestInZone(seed, size, p.x, p.y, 'deep')).toEqual(p);
  });

  it('finds the nearest such point (within the search step)', () => {
    const seed = seedFromString('near');
    const p = nearestInZone(seed, size, size / 2, size / 2, 'shallows');
    const found = Math.hypot(p.x - size / 2, p.y - size / 2);
    // A brute scan finds nothing well inside the shallows meaningfully closer.
    for (let y = 64; y < size; y += 128) {
      for (let x = 64; x < size; x += 128) {
        const d = Math.hypot(x - size / 2, y - size / 2);
        if (d >= found - 64) continue;
        expect(wellInside(seed, x, y, 'shallows')).toBe(false);
      }
    }
  });
});

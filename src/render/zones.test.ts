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
  SunClock,
  sightAt,
  sightRadius,
  sunlight,
  wellInside,
  ZONE_BAND,
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
    expect(glsl).toContain(
      `const vec4 ZONE_CAUSTIC = vec4(${ZONES.map((z) => ZONE_LOOK[z].caustic.toFixed(4)).join(', ')})`,
    );
    expect(glsl).toContain('float zoneSun(');
  });
});

describe('sunlight (M6 T17)', () => {
  const depths = Array.from({ length: 201 }, (_, i) => i / 200);
  const e = RULES.bathymetry.zones;

  for (const key of ['caustic', 'rays'] as const) {
    it(`${key}: calm in the shallows, strongest at the twilight's top and fading through it, gone deeper`, () => {
      // The shallows hold one calm strength (M6b T8), below the twilight's top.
      const calm = sunlight(mid('shallows'), key);
      expect(calm).toBeGreaterThan(0);
      for (const d of depths.filter((d) => d <= e.shallows - ZONE_BAND)) {
        expect(sunlight(d, key)).toBeCloseTo(calm, 12);
      }
      const top = sunlight(e.shallows + ZONE_BAND, key);
      expect(calm).toBeLessThan(top);
      // From the twilight's top down it is never brighter deeper down (M6 T17).
      const below = depths.filter((d) => d >= e.shallows + ZONE_BAND);
      for (let i = 1; i < below.length; i++) {
        expect(sunlight(below[i] as number, key)).toBeLessThanOrEqual(
          sunlight(below[i - 1] as number, key) + 1e-12,
        );
      }
      // It fades through the twilight rather than stepping down at its edges.
      const upper = sunlight(e.shallows + 0.03, key);
      const lower = sunlight(e.twilight - 0.03, key);
      expect(upper).toBeLessThanOrEqual(top);
      expect(lower).toBeGreaterThan(0);
      expect(lower).toBeLessThan(0.5 * upper);
      expect(sunlight(mid('deep'), key)).toBe(0);
      expect(sunlight(mid('abyss'), key)).toBe(0);
      expect(sunlight(e.twilight + 0.02, key)).toBe(0);
    });
  }

  it('calmer shallows (M6b T8): caustics at most 0.4 and god rays at most 0.5; deeper zones as in M6', () => {
    expect(ZONE_LOOK.shallows.caustic).toBeLessThanOrEqual(0.4);
    expect(ZONE_LOOK.shallows.rays).toBeLessThanOrEqual(0.5);
    // The owner liked the depth zones: their light, colours and fog stay as v0.7.0 drew them.
    expect(ZONE_LOOK.twilight).toEqual({
      water: [0.01, 0.026, 0.034],
      haze: [0.04, 0.1, 0.11],
      dark: 0,
      glow: 0.5,
      caustic: 1,
      rays: 0.8,
      pace: 1,
      snow: 1,
    });
    for (const zone of ['deep', 'abyss'] as const) {
      expect(ZONE_LOOK[zone].caustic).toBe(0);
      expect(ZONE_LOOK[zone].rays).toBe(0);
    }
    expect(ZONE_LOOK.shallows.water).toEqual([0.03, 0.1, 0.085]);
    expect(ZONE_LOOK.shallows.haze).toEqual([0.1, 0.27, 0.215]);
  });
});

describe('SunClock (M6b T8)', () => {
  const twilight = mid('twilight');
  const shallows = mid('shallows');

  it('the shallows move at their calm pace, the twilight at the clock', () => {
    expect(ZONE_LOOK.shallows.pace).toBeLessThanOrEqual(0.5);
    expect(ZONE_LOOK.shallows.pace).toBeGreaterThan(0);
    for (const zone of ['twilight', 'deep', 'abyss'] as const) expect(ZONE_LOOK[zone].pace).toBe(1);
    const sun = new SunClock();
    expect(sun.advance(40, twilight)).toBe(40);
    expect(sun.advance(40.5, twilight)).toBeCloseTo(40.5, 12);
    expect(sun.advance(41, shallows)).toBeCloseTo(40.5 + 0.5 * ZONE_LOOK.shallows.pace, 12);
  });

  it('holds still while the clock holds, and stays continuous across a zone edge', () => {
    const sun = new SunClock();
    sun.advance(10, shallows);
    const held = sun.advance(10, shallows);
    expect(sun.advance(10, twilight)).toBe(held);
    const e = RULES.bathymetry.zones;
    let last = held;
    for (let i = 1; i <= 120; i++) {
      // A swim through the shallows' edge band at one frame per 1/60 s.
      const depth = e.shallows - 0.03 + (0.06 * i) / 120;
      const now = sun.advance(10 + i / 60, depth);
      expect(now - last).toBeGreaterThan(0);
      expect(now - last).toBeLessThanOrEqual(1 / 60 + 1e-12);
      last = now;
    }
  });

  it('re-bases on a jump in the clock, so a set clock gives the same light every time', () => {
    const a = new SunClock();
    const b = new SunClock();
    a.advance(3, twilight);
    a.advance(3.2, shallows);
    b.advance(500, shallows);
    // A clock set back, or far ahead (a debug clock, a long-hidden tab), lands on time × pace.
    expect(a.advance(100, shallows)).toBeCloseTo(100 * ZONE_LOOK.shallows.pace, 12);
    expect(b.advance(100, shallows)).toBeCloseTo(100 * ZONE_LOOK.shallows.pace, 12);
    expect(a.advance(100, twilight)).toBeCloseTo(100 * ZONE_LOOK.shallows.pace, 12);
    expect(new SunClock().advance(7, null)).toBe(7);
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

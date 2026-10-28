import { describe, expect, it } from 'vitest';
import { depthAt, type Zone, zoneAt, zoneOfDepth } from './bathymetry';
import { seedFromString } from './prng';
import { RULES } from './rules';

const SEEDS = Array.from({ length: 20 }, (_, i) => seedFromString(`pond-${i}`));
const CENTRE = RULES.world.size / 2;

describe('depthAt', () => {
  it('is a pure function of the seed and position, between 0 and 1', () => {
    const seed = seedFromString('pond-0');
    expect(depthAt(seed, 1234, 5678)).toBe(depthAt(seedFromString('pond-0'), 1234, 5678));
    expect(depthAt(seed, 1234, 5678)).not.toBe(depthAt(seedFromString('pond-1'), 1234, 5678));
    for (let i = 0; i < 200; i++) {
      const d = depthAt(seed, (i * 997) % 8192, (i * 619) % 8192);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('is smooth: 8 wu apart, the depth hardly changes', () => {
    for (const seed of SEEDS.slice(0, 5)) {
      for (let i = 0; i < 100; i++) {
        const x = (i * 811) % 8000;
        const y = (i * 523) % 8000;
        expect(Math.abs(depthAt(seed, x, y) - depthAt(seed, x + 8, y))).toBeLessThan(0.02);
      }
    }
  });

  it('keeps a disc of 1,400 wu around the centre in twilight', () => {
    for (const seed of SEEDS) {
      for (let ring = 0; ring <= 1400; ring += 100) {
        for (let k = 0; k < 24; k++) {
          const a = (k / 24) * 2 * Math.PI;
          const zone = zoneAt(seed, CENTRE + ring * Math.cos(a), CENTRE + ring * Math.sin(a));
          expect(zone).toBe('twilight');
        }
      }
    }
  });

  it('puts the nearest shallows and the nearest deep within 2,200 wu of the centre', () => {
    for (const seed of SEEDS) {
      const nearest: Partial<Record<Zone, number>> = {};
      for (let y = 0; y <= 8192; y += 64) {
        for (let x = 0; x <= 8192; x += 64) {
          const zone = zoneAt(seed, x, y);
          const d = Math.hypot(x - CENTRE, y - CENTRE);
          nearest[zone] = Math.min(nearest[zone] ?? Number.POSITIVE_INFINITY, d);
        }
      }
      expect(nearest.shallows).toBeLessThanOrEqual(2200);
      expect(nearest.deep).toBeLessThanOrEqual(2200);
    }
  });

  it('gives each zone its share of the world on every seed', () => {
    const bounds: Record<Zone, [number, number]> = {
      shallows: [0.2, 0.3],
      twilight: [0.3, 0.4],
      deep: [0.2, 0.3],
      abyss: [0.05, 0.15],
    };
    for (const seed of SEEDS) {
      const counts: Record<Zone, number> = { shallows: 0, twilight: 0, deep: 0, abyss: 0 };
      let n = 0;
      for (let y = 32; y < 8192; y += 64) {
        for (let x = 32; x < 8192; x += 64) {
          counts[zoneAt(seed, x, y)]++;
          n++;
        }
      }
      for (const zone of Object.keys(bounds) as Zone[]) {
        const [lo, hi] = bounds[zone];
        expect(counts[zone] / n).toBeGreaterThanOrEqual(lo);
        expect(counts[zone] / n).toBeLessThanOrEqual(hi);
      }
    }
  });

  it('is not periodic', () => {
    const seed = seedFromString('pond-3');
    let same = 0;
    for (let i = 0; i < 50; i++) {
      const x = 500 + i * 61;
      same += Math.abs(depthAt(seed, x, 3000) - depthAt(seed, x + 2048, 3000)) < 0.005 ? 1 : 0;
    }
    expect(same).toBeLessThan(10);
  });

  it('pins samples (golden)', () => {
    const seed = seedFromString('golden');
    const samples = [
      [0, 0],
      [4096, 4096],
      [1000, 7000],
      [6500, 2500],
      [8192, 8192],
    ].map(([x, y]) => Math.round(depthAt(seed, x as number, y as number) * 1e6) / 1e6);
    expect(samples).toEqual(GOLDEN);
  });
});

describe('zoneOfDepth', () => {
  it('cuts at 0.25, 0.55 and 0.8', () => {
    expect(
      ['0', '0.2499', '0.25', '0.5499', '0.55', '0.7999', '0.8', '1'].map((d) =>
        zoneOfDepth(Number(d)),
      ),
    ).toEqual(['shallows', 'shallows', 'twilight', 'twilight', 'deep', 'deep', 'abyss', 'abyss']);
  });
});

const GOLDEN = [0.807208, 0.417907, 0.57345, 0.188765, 0];

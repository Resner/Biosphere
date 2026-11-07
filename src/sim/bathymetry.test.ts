import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { depthAt, depthSpan, type Zone, zoneAt, zoneOfDepth } from './bathymetry';
import { seedFromString } from './prng';
import { RULES } from './rules';

const SEEDS = Array.from({ length: 20 }, (_, i) => seedFromString(`pond-${i}`));
const SIZES = [8192, 262144];
const LARGE = 262144;

describe('depthAt', () => {
  it('is a pure function of the seed and position, between 0 and 1', () => {
    const seed = seedFromString('pond-0');
    expect(depthAt(seed, 1234, 5678)).toBe(depthAt(seedFromString('pond-0'), 1234, 5678));
    expect(depthAt(seed, 1234, 5678)).not.toBe(depthAt(seedFromString('pond-1'), 1234, 5678));
    for (const size of SIZES) {
      for (let i = 0; i < 200; i++) {
        const d = depthAt(seed, ((i * 997) % 8192) * (size / 8192), (i * 619) % size, size);
        expect(d).toBeGreaterThanOrEqual(0);
        expect(d).toBeLessThanOrEqual(1);
      }
    }
  });

  it('calibrates every world size on its own', () => {
    const seed = seedFromString('pond-0');
    expect(depthAt(seed, 4096, 4096, 8192)).not.toBe(depthAt(seed, 4096, 4096, LARGE));
    expect(depthAt(seed, 4096, 4096, 8192)).toBe(depthAt(seed, 4096, 4096, 8192));
  });

  it('is smooth: 1 wu apart, the depth changes by at most 0.003', () => {
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        for (let i = 0; i < 100; i++) {
          const x = (i * 811 * (size / 8192)) % (size - 8);
          const y = (i * 523 * (size / 8192)) % (size - 8);
          const here = depthAt(seed, x, y, size);
          expect(Math.abs(here - depthAt(seed, x + 1, y, size))).toBeLessThanOrEqual(0.003);
          expect(Math.abs(here - depthAt(seed, x, y + 1, size))).toBeLessThanOrEqual(0.003);
        }
      }
    }
  });

  it('keeps a disc of 1,400 wu around the centre of the world in twilight', () => {
    for (const size of SIZES) {
      const centre = size / 2;
      for (const seed of SEEDS) {
        for (let ring = 0; ring <= 1400; ring += 100) {
          for (let k = 0; k < 24; k++) {
            const a = (k / 24) * 2 * Math.PI;
            const zone = zoneAt(
              seed,
              centre + ring * Math.cos(a),
              centre + ring * Math.sin(a),
              size,
            );
            expect(zone).toBe('twilight');
          }
        }
      }
    }
  });

  it('puts the nearest shallows and the nearest deep within 2,200 wu of the centre', () => {
    for (const size of SIZES) {
      const centre = size / 2;
      for (const seed of SEEDS) {
        const nearest: Partial<Record<Zone, number>> = {};
        for (let y = centre - 2200; y <= centre + 2200; y += 64) {
          for (let x = centre - 2200; x <= centre + 2200; x += 64) {
            const d = Math.hypot(x - centre, y - centre);
            if (d > 2200) continue;
            const zone = zoneAt(seed, x, y, size);
            nearest[zone] = Math.min(nearest[zone] ?? Number.POSITIVE_INFINITY, d);
          }
        }
        expect(nearest.shallows).toBeLessThanOrEqual(2200);
        expect(nearest.deep).toBeLessThanOrEqual(2200);
      }
    }
  });

  it('gives each zone its share of the world on every seed and size', () => {
    const bounds: Record<Zone, [number, number]> = {
      shallows: [0.2, 0.3],
      twilight: [0.3, 0.4],
      deep: [0.2, 0.3],
      abyss: [0.05, 0.15],
    };
    const n = 256;
    for (const size of SIZES) {
      for (const seed of SEEDS) {
        const counts: Record<Zone, number> = { shallows: 0, twilight: 0, deep: 0, abyss: 0 };
        for (let j = 0; j < n; j++) {
          for (let i = 0; i < n; i++) {
            counts[zoneAt(seed, ((i + 0.5) * size) / n, ((j + 0.5) * size) / n, size)]++;
          }
        }
        for (const zone of Object.keys(bounds) as Zone[]) {
          const [lo, hi] = bounds[zone];
          expect(counts[zone] / (n * n), `${size} ${zone}`).toBeGreaterThanOrEqual(lo);
          expect(counts[zone] / (n * n), `${size} ${zone}`).toBeLessThanOrEqual(hi);
        }
      }
    }
  });

  it('keeps every zone near everywhere in the large world', () => {
    const n = 256;
    const cell = LARGE / n;
    const reach: Record<Zone, number> = {
      shallows: 16384,
      twilight: Number.POSITIVE_INFINITY,
      deep: 16384,
      abyss: 32768,
    };
    for (const seed of SEEDS) {
      const map = new Uint8Array(n * n);
      const zones: Zone[] = ['shallows', 'twilight', 'deep', 'abyss'];
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          map[j * n + i] = zones.indexOf(zoneAt(seed, (i + 0.5) * cell, (j + 0.5) * cell, LARGE));
        }
      }
      for (const zone of ['shallows', 'deep', 'abyss'] as const) {
        const code = zones.indexOf(zone);
        const window = Math.ceil(reach[zone] / cell);
        for (let ly = 0; ly < 32; ly++) {
          for (let lx = 0; lx < 32; lx++) {
            const px = (lx + 0.5) * (LARGE / 32);
            const py = (ly + 0.5) * (LARGE / 32);
            const ci = Math.floor(px / cell);
            const cj = Math.floor(py / cell);
            let found = false;
            for (
              let j = Math.max(0, cj - window);
              j <= Math.min(n - 1, cj + window) && !found;
              j++
            ) {
              for (let i = Math.max(0, ci - window); i <= Math.min(n - 1, ci + window); i++) {
                if (
                  map[j * n + i] === code &&
                  Math.hypot((i + 0.5) * cell - px, (j + 0.5) * cell - py) <= reach[zone]
                ) {
                  found = true;
                  break;
                }
              }
            }
            expect(found, `${zone} near lattice point ${lx},${ly}`).toBe(true);
          }
        }
      }
    }
  });

  speedTest('calibrates a 262,144 wu world in under 30 ms in Node', () => {
    for (let i = 0; i < 3; i++) depthAt(seedFromString(`warm-${i}`), 100, 100, LARGE);
    const ms = Math.min(
      ...Array.from({ length: 7 }, (_, i) => {
        const seed = seedFromString(`calibrate-${i}`);
        const start = process.hrtime.bigint();
        depthAt(seed, 100, 100, LARGE);
        return Number(process.hrtime.bigint() - start) / 1e6;
      }),
    );
    expect(ms).toBeLessThan(30);
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
    ].map(([x, y]) => Math.round(depthAt(seed, x as number, y as number, 8192) * 1e6) / 1e6);
    expect(samples).toEqual(GOLDEN);
    const large = [
      [0, 0],
      [131072, 131072],
      [1000, 250000],
      [200000, 30000],
      [262144, 262144],
    ].map(([x, y]) => Math.round(depthAt(seed, x as number, y as number, LARGE) * 1e6) / 1e6);
    expect(large).toEqual(GOLDEN_LARGE);
  });
});

describe('depthSpan', () => {
  it('gives depthAt bit for bit at each cell centre of a row, at both sizes and any cell', () => {
    for (const size of SIZES) {
      for (const seed of SEEDS.slice(0, 4)) {
        for (const [cell, i0, j] of [
          [0.5, 500_000, 499_999],
          [1, 12, 7],
          [4, 62_400, 61_000],
          [37.5, -3, 100],
          [1024, 0, 255],
        ] as const) {
          const n = 300;
          const out = new Float64Array(n + 2);
          depthSpan(seed, size, cell, i0, j, n, out, 2);
          for (let k = 0; k < n; k++) {
            const want = depthAt(seed, (i0 + k + 0.5) * cell, (j + 0.5) * cell, size);
            if (out[k + 2] !== want) {
              expect(out[k + 2], `size ${size} cell ${cell} k ${k}`).toBe(want);
            }
          }
        }
      }
    }
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

const GOLDEN = [0.081962, 0.386363, 0.433603, 0.151615, 0.061816];
const GOLDEN_LARGE = [0.179611, 0.26, 0.228812, 0.453327, 0.844628];

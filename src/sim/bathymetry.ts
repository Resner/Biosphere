// Bathymetry (M6 T15, DESIGN §2): how deep the water is under every point of a pond. A pure
// function of the pond seed and a position, so peers, witnesses and the authority all agree, and
// presentation reads the same field. Depth runs from 0 (the sunlit surface) to 1 (the abyss floor).

import { clamp, cos, length, lerp, sin, TAU } from './math';
import { hashU32, type Seed } from './prng';
import { RULES } from './rules';

export type Zone = 'shallows' | 'twilight' | 'deep' | 'abyss';

const B = RULES.bathymetry;
const SALT = { angle: 1, noise: 2 } as const;
const CENTRE = RULES.world.size / 2;
const OCTAVES = B.octaves;
const NORMALISER = OCTAVES.reduce((sum, o) => sum + o.weight, 0);

interface Field {
  /** Unit vector pointing towards the deep side of the pond. */
  tx: number;
  ty: number;
  /** The raw field at the quantiles that become depth 0, the zone edges and 1. */
  knots: number[];
}

// A pond's world keeps one seed array for its whole life, so the identity lookup is the hot path;
// ponds rebuilt from the same seed text land in the keyed map instead of calibrating again.
const byIdentity = new WeakMap<Seed, Field>();
const byKey = new Map<string, Field>();
const MAX_KEYED = 16;

const unit = (hash: number): number => (hash >>> 0) / 4294967296;

/** A lattice value in [-1, 1]. */
const lattice = (seed: Seed, octave: number, ix: number, iy: number): number =>
  unit(hashU32(seed[0], seed[1], seed[2], seed[3], SALT.noise, octave, ix, iy)) * 2 - 1;

const fade = (t: number): number => t * t * t * (t * (t * 6 - 15) + 10);

/** Smooth value noise in [-1, 1] with one lattice cell per `wavelength` wu. */
function noise(seed: Seed, octave: number, wavelength: number, x: number, y: number): number {
  const gx = x / wavelength;
  const gy = y / wavelength;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const u = fade(gx - ix);
  const v = fade(gy - iy);
  const a = lattice(seed, octave, ix, iy);
  const b = lattice(seed, octave, ix + 1, iy);
  const c = lattice(seed, octave, ix, iy + 1);
  const d = lattice(seed, octave, ix + 1, iy + 1);
  return lerp(lerp(a, b, u), lerp(c, d, u), v);
}

/** The uncalibrated field: fractal noise plus a slope towards the deep side. */
function rawField(seed: Seed, tx: number, ty: number, x: number, y: number): number {
  let n = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    const o = OCTAVES[i] as { wavelength: number; weight: number };
    n += o.weight * noise(seed, i, o.wavelength, x, y);
  }
  return (B.noiseAmplitude * n) / NORMALISER + B.tilt * ((x - CENTRE) * tx + (y - CENTRE) * ty);
}

/**
 * The field of a pond. Seeds differ in how much of the pond their noise puts in each zone, so the
 * raw field is calibrated once per seed: sampled on a lattice, its quantiles are mapped onto the
 * zone edges and every pond ends up with the same shares of shallows, twilight, deep and abyss.
 */
function fieldFor(seed: Seed): Field {
  const known = byIdentity.get(seed);
  if (known !== undefined) return known;
  const key = seed.join('.');
  const cached = byKey.get(key);
  if (cached !== undefined) {
    byIdentity.set(seed, cached);
    return cached;
  }
  const angle = unit(hashU32(seed[0], seed[1], seed[2], seed[3], SALT.angle)) * TAU;
  const tx = cos(angle);
  const ty = sin(angle);
  const n = B.calibrationSamples;
  const step = RULES.world.size / n;
  const samples = new Float64Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      samples[j * n + i] = rawField(seed, tx, ty, (i + 0.5) * step, (j + 0.5) * step);
    }
  }
  samples.sort();
  const at = (share: number): number =>
    samples[Math.min(samples.length - 1, Math.floor(share * samples.length))] as number;
  const q = B.shares;
  const knots = [
    at(0),
    at(q.shallows),
    at(q.shallows + q.twilight),
    at(q.shallows + q.twilight + q.deep),
    at(1),
  ];
  const field = { tx, ty, knots };
  if (byKey.size >= MAX_KEYED) byKey.clear();
  byKey.set(key, field);
  byIdentity.set(seed, field);
  return field;
}

const EDGES = [0, B.zones.shallows, B.zones.twilight, B.zones.deep, 1];

/**
 * Depth under (x, y), 0 (surface) to 1 (abyss floor). The calibrated field, held within
 * `centreCap` of the middle depth near the world centre (which is every pond's spawn centre) so
 * that a disc of `centreRadius` wu there is always twilight.
 */
export function depthAt(seed: Seed, x: number, y: number): number {
  const field = fieldFor(seed);
  const f = rawField(seed, field.tx, field.ty, x, y);
  const k = field.knots;
  let i = 0;
  while (i < 3 && f >= (k[i + 1] as number)) i++;
  const lo = k[i] as number;
  const hi = k[i + 1] as number;
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  const depth = lerp(EDGES[i] as number, EDGES[i + 1] as number, t);
  const away = Math.max(0, length(x - CENTRE, y - CENTRE) - B.centreRadius);
  const cap = B.centreCap + B.capGrowth * away;
  return clamp(B.base + clamp(depth - B.base, -cap, cap), 0, 1);
}

/** The zone of a depth. */
export function zoneOfDepth(depth: number): Zone {
  const z = B.zones;
  if (depth < z.shallows) return 'shallows';
  if (depth < z.twilight) return 'twilight';
  if (depth < z.deep) return 'deep';
  return 'abyss';
}

export function zoneAt(seed: Seed, x: number, y: number): Zone {
  return zoneOfDepth(depthAt(seed, x, y));
}

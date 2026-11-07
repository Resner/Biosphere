// Bathymetry (M6 T15, DESIGN §2): how deep the water is under every point of a pond. A pure
// function of the pond seed and a position, so peers, witnesses and the authority all agree, and
// presentation reads the same field. Depth runs from 0 (the sunlit surface) to 1 (the abyss floor).

import { clamp, length, lerp } from './math';
import { hashU32, type Seed } from './prng';
import { RULES } from './rules';

export type Zone = 'shallows' | 'twilight' | 'deep' | 'abyss';

const B = RULES.bathymetry;
const SALT = { noise: 2 } as const;
// The broad octave comes last, so that it never shifts the others' lattices.
/** The plastic-number sequence's two increments (Roberts' R2). */
const R2 = { x: 0.7548776662466927, y: 0.5698402909980532 } as const;
const OCTAVES = [...B.octaves, B.broad];
const NORMALISER = OCTAVES.reduce((sum, o) => sum + o.weight, 0);

interface Field {
  /** How far the field is moved at the world's centre (raw units). */
  shift: number;
  /** The raw field at the quantiles that become depth 0, the zone edges and 1. */
  knots: number[];
}

// A world keeps one seed array for its whole life, so the identity lookup is the hot path; worlds
// rebuilt from the same seed text land in the keyed map instead of calibrating again. Every size
// calibrates its own field.
const byIdentity = new WeakMap<Seed, Map<number, Field>>();
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

/** The uncalibrated field: fractal noise, the broad octave last. */
function rawField(seed: Seed, x: number, y: number): number {
  let n = 0;
  for (let i = 0; i < OCTAVES.length; i++) {
    const o = OCTAVES[i] as { wavelength: number; weight: number };
    n += o.weight * noise(seed, i, o.wavelength, x, y);
  }
  return (B.noiseAmplitude * n) / NORMALISER;
}

/** The raw field's mean over the square of `localHalf` wu around the world's centre, on an 8 × 8 lattice. */
function localMean(seed: Seed, centre: number): number {
  const half = B.localHalf;
  let sum = 0;
  for (let j = 0; j < 8; j++) {
    for (let i = 0; i < 8; i++) {
      sum += rawField(
        seed,
        centre + ((i + 0.5) / 4 - 1) * half,
        centre + ((j + 0.5) / 4 - 1) * half,
      );
    }
  }
  return sum / 64;
}

/**
 * How much of the field's centre shift applies at a distance from the world's centre: all of it
 * there, none one broad wavelength out.
 */
function pinAt(distance: number): number {
  const away = distance / B.broad.wavelength;
  return away < 1 ? fade(1 - away) : 0;
}

/**
 * The field of a world. Seeds differ in how much of the world their noise puts in each zone, so
 * the raw field is calibrated once per seed and size: sampled on a lattice, its quantiles are
 * mapped onto the zone edges and every world ends up with the same shares of shallows, twilight,
 * deep and abyss.
 */
function fieldFor(seed: Seed, size: number): Field {
  const known = byIdentity.get(seed)?.get(size);
  if (known !== undefined) return known;
  const key = `${seed.join('.')}:${size}`;
  let field = byKey.get(key);
  if (field === undefined) {
    field = calibrate(seed, size);
    if (byKey.size >= MAX_KEYED) byKey.clear();
    byKey.set(key, field);
  }
  let sizes = byIdentity.get(seed);
  if (sizes === undefined) {
    sizes = new Map();
    byIdentity.set(seed, sizes);
  }
  sizes.set(size, field);
  return field;
}

function calibrate(seed: Seed, size: number): Field {
  const count = B.calibrationSamples * B.calibrationSamples;
  const raw = new Float64Array(count);
  const pins = new Float64Array(count);
  const centre = size / 2;
  let kept = 0;
  // An R2 low-discrepancy sequence rather than a grid: a grid step that divides the octaves'
  // wavelengths samples every lattice at one phase and biases the quantiles. The centre disc is
  // twilight whatever the field says, so it stays out of the quantiles: outside it the shares hold.
  for (let k = 0; k < count; k++) {
    const u = 0.5 + k * R2.x;
    const v = 0.5 + k * R2.y;
    const x = (u - Math.floor(u)) * size;
    const y = (v - Math.floor(v)) * size;
    const away = length(x - centre, y - centre);
    if (away < B.centreRadius) continue;
    raw[kept] = rawField(seed, x, y);
    pins[kept++] = pinAt(away);
  }
  const q = B.shares;
  const quantile = (sorted: Float64Array, share: number): number =>
    sorted[Math.min(kept - 1, Math.floor(share * kept))] as number;
  // Wherever the noise happens to put the centre's surroundings, the field is shifted there (and smoothly less
  // out to one broad wavelength) so that the centre lies mid-twilight in the world's own
  // distribution: shallows and deep are then both near it, which the rank-based zones alone
  // could not promise in a world many wavelengths wide.
  const sorted = raw.slice(0, kept).sort();
  const shift = localMean(seed, centre) - quantile(sorted, q.shallows + q.twilight / 2);
  for (let i = 0; i < kept; i++) sorted[i] = (raw[i] as number) - (pins[i] as number) * shift;
  sorted.sort();
  const knots = [
    quantile(sorted, 0),
    quantile(sorted, q.shallows),
    quantile(sorted, q.shallows + q.twilight),
    quantile(sorted, q.shallows + q.twilight + q.deep),
    quantile(sorted, 1),
  ];
  return { knots, shift };
}

const EDGES = [0, B.zones.shallows, B.zones.twilight, B.zones.deep, 1];

/**
 * Depth under (x, y) in a world of `size` wu, 0 (surface) to 1 (abyss floor). The calibrated
 * field, held within `centreCap` of the middle depth near the world's centre (the spawn centre) so
 * that a disc of `centreRadius` wu there is always twilight.
 */
export function depthAt(seed: Seed, x: number, y: number, size: number = RULES.world.size): number {
  const field = fieldFor(seed, size);
  const away = length(x - size / 2, y - size / 2);
  const f = rawField(seed, x, y) - pinAt(away) * field.shift;
  const k = field.knots;
  let i = 0;
  while (i < 3 && f >= (k[i + 1] as number)) i++;
  const lo = k[i] as number;
  const hi = k[i + 1] as number;
  const t = hi > lo ? (f - lo) / (hi - lo) : 0;
  const depth = lerp(EDGES[i] as number, EDGES[i + 1] as number, t);
  const cap = B.centreCap + B.capGrowth * Math.max(0, away - B.centreRadius);
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

export function zoneAt(seed: Seed, x: number, y: number, size: number = RULES.world.size): Zone {
  return zoneOfDepth(depthAt(seed, x, y, size));
}

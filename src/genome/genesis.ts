// Genesis DNA (M3 T7, DESIGN §6): a pure function of a seed gives a fresh single cell with a whip,
// a half chance of a ciliary band, and colours, patterns and membrane that vary widely. Rare
// alleles are drawn per allele, so they show up (homozygous) far less often than they exist.

import { createRng, type Rng, type Seed } from '../sim/prng';
import { decodeGenome, type Genome } from './codec';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, MODULE_PARAMS } from './karyotype';

type Param = (typeof MODULE_PARAMS)[number];

/**
 * Allele frequencies of the genesis pool (the rare ones are DESIGN §6). These are per allele: a
 * dominant allele shows in more cells than its frequency (luminescent 30% glows in about half).
 */
export const GENESIS_FREQ = {
  iridescent: 0.05,
  albino: 0.04,
  load: 0.03,
  luminescent: 0.3,
  /** none, rings, spots, stripes. */
  pattern: [0.4, 0.2, 0.3, 0.1],
  grainy: 0.5,
  /** nearest, weakest, largest. */
  targetPref: [0.4, 0.35, 0.25],
  /** The chance that a genesis cell also has a ciliary band (slot M2). */
  band: 0.5,
} as const;

const offsets = new Map<string, number>(LOCI.map((l) => [l.id, l.offset]));
const offsetOf = (id: string): number => offsets.get(id) as number;

/** The index of the first cumulative weight above `u` (weights need not sum to exactly 1). */
function pick(weights: readonly number[], u: number): number {
  let acc = 0;
  for (let i = 0; i < weights.length; i++) {
    acc += weights[i] as number;
    if (u < acc) return i;
  }
  return weights.length - 1;
}

class Builder {
  readonly bytes = new Uint8Array(GENOME_BYTES);
  constructor(readonly rng: Rng) {}

  set(hap: number, id: string, value: number): void {
    this.bytes[hap * HAPLOTYPE_BYTES + offsetOf(id)] = value;
  }

  /**
   * Traits are means over the alleles of their loci: aim a mean at `f` (0-1) and scatter the
   * alleles around it, keeping their sum, so the cell is heterozygous but the trait is exact.
   */
  mean(ids: readonly string[], f: number, scatter = 24): void {
    const n = ids.length * 2;
    const total = Math.round(Math.min(1, Math.max(0, f)) * 255 * n);
    const values = Array.from(
      { length: n },
      (_, i) => Math.floor(total / n) + (i < total % n ? 1 : 0),
    );
    for (let k = 0; k < n; k++) {
      const i = this.rng.int(0, n - 1);
      const j = this.rng.int(0, n - 1);
      const d = Math.min(
        this.rng.int(0, scatter),
        values[i] as number,
        255 - (values[j] as number),
      );
      values[i] = (values[i] as number) - d;
      values[j] = (values[j] as number) + d;
    }
    ids.forEach((id, s) => {
      this.set(0, id, values[s] as number);
      this.set(1, id, values[ids.length + s] as number);
    });
  }

  /** A trait at a uniform point of `[lo, hi]` (fractions of its range). */
  between(ids: readonly string[], lo: number, hi: number): void {
    this.mean(ids, this.rng.range(lo, hi));
  }

  /** Each haplotype draws its allele from `weights` (indices into the locus table). */
  alleles(id: string, weights: readonly number[]): void {
    for (let hap = 0; hap < 2; hap++) this.set(hap, id, pick(weights, this.rng.next()));
  }

  module(id: string, params: Partial<Record<Param, number>>): void {
    for (let hap = 0; hap < 2; hap++) {
      const o = hap * HAPLOTYPE_BYTES + offsetOf(id);
      this.bytes[o] = 1;
      MODULE_PARAMS.forEach((name, k) => {
        const v = params[name];
        // Each haplotype's copy of a named parameter differs a little; the rest stay 0.
        if (v !== undefined)
          this.bytes[o + 1 + k] = Math.min(255, Math.max(0, v + this.rng.int(-6, 6)));
      });
    }
  }
}

/** Probabilities for a two-allele locus where index 1 has frequency `p`. */
const biallelic = (p: number): number[] => [1 - p, p];

/** A fresh genesis genome: a pure function of the seed. */
export function genesisGenome(seed: Seed): Genome {
  const rng = createRng(seed, 'genesis');
  const b = new Builder(rng);

  // One cell: the drive stays below 1/8 of its range. Size 300-900 biomass.
  b.between(['segDrive1', 'segDrive2'], 0, 0.1);
  // Two draws multiplied, so most cells stay near the small end.
  b.mean(['size1', 'size2', 'size3'], rng.next() * rng.next() * 0.119, 12);
  b.between(['aspect'], 0.1, 0.6);
  b.between(['taper'], 0, 1);
  b.between(['flexibility'], 0, 1);

  // Integument: wide membrane variation, almost no armour.
  b.between(['membrane'], 0, 1);
  b.between(['translucency'], 0, 1);
  b.between(['plating1', 'plating2'], 0, 0.12);
  b.between(['spines'], 0, 0.15);
  b.alleles('iridescence', biallelic(GENESIS_FREQ.iridescent));
  b.alleles('texture', biallelic(GENESIS_FREQ.grainy));

  // Mouth: all-round to leaning towards a filter or a jaw.
  b.between(['mouthSize'], 0.6, 1);
  b.between(['mouthType'], 0.2, 0.8);
  b.between(['digestion'], 0.4, 0.8);

  // Behaviour.
  b.between(['gaitAmp'], 0, 0.35);
  b.between(['gaitFreq'], 0.3, 0.7);
  for (const id of ['aggression', 'caution', 'curiosity', 'reflex']) b.between([id], 0, 1);
  b.alleles('targetPref', GENESIS_FREQ.targetPref);

  // Colour: hue is uniform so the starters spread over the whole wheel.
  b.mean(['hue1', 'hue2', 'hue3'], rng.next(), 20);
  b.between(['saturation'], 0.3, 1);
  b.between(['value'], 0.3, 1);
  b.between(['patternScale'], 0, 1);
  b.between(['lumHue'], 0, 1);
  b.alleles('pattern', GENESIS_FREQ.pattern);
  b.alleles('albino', biallelic(GENESIS_FREQ.albino));
  b.alleles('luminescence', biallelic(GENESIS_FREQ.luminescent));

  // Physiology around the middle.
  b.between(['lifespan'], 0.3, 0.7);
  b.between(['metabolism'], 0.3, 0.7);
  b.between(['growth'], 0.3, 0.7);
  b.between(['uvTolerance'], 0, 1);
  b.between(['pressureTolerance'], 0, 1);

  // Load alleles: functional unless drawn.
  for (const id of ['L1', 'L2', 'L3', 'L4'])
    for (let hap = 0; hap < 2; hap++) b.set(hap, id, rng.next() < GENESIS_FREQ.load ? 1 : 0);

  // M1: a whip like the starter's, varied.
  b.module('M1', {
    length: rng.int(108, 125),
    thickness: rng.int(22, 27),
    curvature: rng.int(0, 255),
    joints: rng.int(80, 120),
    tipShape: rng.int(240, 255),
    stiffness: rng.int(0, 60),
    beat: rng.int(195, 215),
    phase: rng.int(0, 255),
    attachStart: 255,
    angle: rng.int(215, 245),
  });
  // M2: sometimes a band of fine cilia along the sides.
  if (rng.next() < GENESIS_FREQ.band) {
    b.module('M2', {
      length: rng.int(30, 55),
      thickness: rng.int(14, 24),
      curvature: rng.int(0, 255),
      tipShape: rng.int(215, 245),
      beat: rng.int(40, 80),
      phase: rng.int(0, 255),
      attachStart: rng.int(60, 140),
      attachSpan: rng.int(60, 200),
      angle: rng.int(120, 190),
      pairs: rng.int(0, 255),
    });
  }
  return decodeGenome(b.bytes);
}

// Genesis DNA (ADR 0025, ADR 0035, ADR 0040, DESIGN §6): a pure function of a seed gives a fresh
// single cell. The base cell draws a whip, a half chance of a ciliary band, and colours, patterns and
// membrane that vary widely; rare alleles are drawn per allele, so they show up (homozygous) far less
// often than they exist. The cell is then given a larval form: a plain cell, a ciliate, a spiny
// larva, a bell, a tadpole or a fan-tailed one. Every form is still one body unit with at most three
// module slots, so the lineage starts at the cell stage; the multi-segment bodies arise through
// breeding. The form draws from its own stream, so it never shifts the base cell's draws, and the
// slots other than the whip are bristled with draws after the form's (M6b T7). Only the live rules
// version exists (ADR 0040): changing a draw here is a rules change.

import { createRng, type Rng, type Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, encodeGenome, type Genome } from './codec';
import {
  GENOME_BYTES,
  HAPLOTYPE_BYTES,
  LOCI,
  MODULE_EXT,
  MODULE_LOCI,
  MODULE_PARAMS,
  type SHAPE_LOCI,
} from './karyotype';
import type { Silhouette } from './silhouette';

type Param = (typeof MODULE_PARAMS)[number];
type Ext = (typeof MODULE_EXT)[number];
type Shape = (typeof SHAPE_LOCI)[number];

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

/** The base cell, in canonical bytes; the larval form is written over it. */
function baseCell(seed: Seed): Uint8Array {
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
  return encodeGenome(decodeGenome(b.bytes));
}

/** The chance that a genesis cell of any form has a pair of eyes. */
export const GENESIS_EYES = 0.12;

/**
 * Rules 7 (M6b T7): the chance that each module slot other than the whip (M1) is bristled, with a
 * setae density of at least `density[0]` and a setae length of at least `length[0]`, so bred trunks
 * carry combs of setae. Drawn last from the form's stream, so no earlier draw shifts.
 */
export const GENESIS_BRISTLES = { chance: 0.7, density: [0.3, 0.45], length: [0.25, 0.6] } as const;

/** A larval form: its share of genesis cells and the silhouette it mostly develops into. */
export interface GenesisForm {
  readonly name: string;
  readonly weight: number;
  readonly silhouette: Silhouette;
  /** Symmetry at or above `RULES.develop.radial.at`: the parts ring the core (from the recipe). */
  readonly radial: boolean;
  /** A module with webbing (from the recipe). */
  readonly webbed: boolean;
}

type Span = readonly [lo: number, hi: number];
type Params = Partial<Record<Param, Span>>;

/** What a form changes in the base cell; absent entries are left as the base cell drew them. */
interface Recipe {
  /** Shape loci as fractions of their range, drawn uniformly between the two ends. */
  shape?: Partial<Record<Shape, Span>>;
  /** Slot M1 (the whip) and M2 (the band) parameters in bytes; M2 is added when missing. */
  m1?: Params;
  m2?: Params;
  /** Extension fractions of M1 and M2. */
  ext1?: Partial<Record<Ext, Span>>;
  ext2?: Partial<Record<Ext, Span>>;
}

type Form = Omit<GenesisForm, 'radial' | 'webbed'> & { recipe: Recipe };

const FORMS: readonly Form[] = [
  // The base cell as it is: a whip, and a band of cilia in half of them (a third of those with three pairs read as ciliates).
  { name: 'cell', weight: 0.35, silhouette: 'cell', recipe: {} },
  // A fringe of cilia (the band at its three pairs), bristled in some.
  {
    name: 'ciliate',
    weight: 0.15,
    silhouette: 'ciliate',
    recipe: {
      m2: { pairs: [250, 255], length: [30, 55] },
      ext2: { setaeDensity: [0, 0.6], setaeLength: [0, 0.5] },
    },
  },
  // A sphere ringed with short stiff spines, bristles and bead tips.
  {
    name: 'spiny larva',
    weight: 0.17,
    silhouette: 'spiny-larva',
    recipe: {
      shape: { symmetry: [0.6, 1] },
      m2: {
        pairs: [250, 255],
        length: [110, 150],
        thickness: [30, 60],
        tipShape: [90, 130],
        beat: [0, 20],
        attachStart: [60, 140],
        attachSpan: [120, 200],
      },
      ext2: { setaeDensity: [0.2, 0.8], setaeLength: [0.2, 0.6], bulb: [0.4, 1] },
    },
  },
  // A small bell: round, with tentacles trailing behind.
  {
    name: 'bell',
    weight: 0.1,
    silhouette: 'bell',
    recipe: {
      shape: { symmetry: [0.6, 1], drape: [0.8, 1] },
      m2: {
        pairs: [250, 255],
        length: [120, 170],
        thickness: [10, 25],
        tipShape: [150, 230],
        beat: [60, 110],
        attachStart: [60, 140],
        attachSpan: [120, 200],
      },
      ext2: { setaeDensity: [0, 0.4], setaeLength: [0, 0.4], bulb: [0, 0.7] },
    },
  },
  // A tadpole: a thick, long tail behind the cell.
  {
    name: 'tadpole',
    weight: 0.15,
    silhouette: 'tadpole',
    recipe: {
      m1: { length: [170, 210], thickness: [150, 190], angle: [235, 250] },
      ext1: { beads: [0, 0.5] },
    },
  },
  // The same with a fan of membrane across the tail.
  {
    name: 'fan tail',
    weight: 0.08,
    silhouette: 'fan-tail',
    recipe: {
      m1: { length: [170, 210], thickness: [150, 190], angle: [235, 250] },
      ext1: { webbing: [0.6, 1] },
    },
  },
];

/** The table with the features the recipes make, so rarity prices what the draw does. */
export const GENESIS_FORMS: readonly GenesisForm[] = FORMS.map(({ recipe, ...form }) => ({
  ...form,
  radial: (recipe.shape?.symmetry?.[0] ?? 0) >= RULES.develop.radial.at,
  webbed: (recipe.ext1?.webbing?.[0] ?? 0) > 0 || (recipe.ext2?.webbing?.[0] ?? 0) > 0,
}));

const m1 = MODULE_LOCI[0] as (typeof MODULE_LOCI)[number];
const m2 = MODULE_LOCI[1] as (typeof MODULE_LOCI)[number];
const paramAt = (name: Param): number => MODULE_PARAMS.indexOf(name);
/** Every slot but the whip (slot 0) can carry bristles. */
const BRISTLED_SLOTS = MODULE_LOCI.slice(1);
const SETAE_DENSITY = MODULE_EXT.indexOf('setaeDensity');
const SETAE_LENGTH = MODULE_EXT.indexOf('setaeLength');

function pickForm(rng: Rng): Form {
  let u = rng.next();
  for (const f of FORMS) {
    if (u < f.weight) return f;
    u -= f.weight;
  }
  return FORMS[0] as Form;
}

class Writer {
  constructor(
    readonly bytes: Uint8Array,
    readonly rng: Rng,
  ) {}

  /** The same byte on both haplotypes. */
  both(offset: number, value: number): void {
    this.bytes[offset] = value;
    this.bytes[HAPLOTYPE_BYTES + offset] = value;
  }

  fraction(offset: number, [lo, hi]: Span): void {
    this.both(offset, Math.round(255 * this.rng.range(lo, hi)));
  }

  /** A module parameter: each haplotype's copy differs a little. */
  param(slot: typeof m1, name: Param, [lo, hi]: Span): void {
    const v = Math.round(this.rng.range(lo, hi));
    for (const hap of [0, 1])
      this.bytes[hap * HAPLOTYPE_BYTES + slot.offset + 1 + paramAt(name)] = Math.min(
        255,
        Math.max(0, v + this.rng.int(-3, 3)),
      );
  }

  /** A fraction drawn in `span`, unless the byte already holds more. */
  atLeast(offset: number, span: Span): void {
    const was = this.bytes[offset] as number;
    this.fraction(offset, span);
    if (was > (this.bytes[offset] as number)) this.both(offset, was);
  }

  present(slot: typeof m1): boolean {
    return (this.bytes[slot.offset] as number) === 1;
  }
}

/** A fresh genesis genome: a pure function of the seed. */
export function genesisGenome(seed: Seed): Genome {
  const bytes = baseCell(seed);
  const rng = createRng(seed, 'genesis-form');
  const w = new Writer(bytes, rng);
  const { recipe } = pickForm(rng);

  for (const [id, span] of Object.entries(recipe.shape ?? {})) w.fraction(offsetOf(id), span);
  if (recipe.m2 && !w.present(m2)) {
    // The band the form needs: the base cell's draw of a cilia slot, then its own parameters on top.
    w.both(m2.offset, 1);
    w.param(m2, 'thickness', [14, 24]);
    w.param(m2, 'curvature', [0, 255]);
    w.param(m2, 'beat', [40, 80]);
    w.param(m2, 'phase', [0, 255]);
    w.param(m2, 'angle', [120, 190]);
    w.param(m2, 'tipShape', [215, 245]);
  }
  for (const [name, span] of Object.entries(recipe.m1 ?? {})) w.param(m1, name as Param, span);
  for (const [name, span] of Object.entries(recipe.m2 ?? {})) w.param(m2, name as Param, span);
  for (const [name, span] of Object.entries(recipe.ext1 ?? {}))
    w.fraction(m1.ext + MODULE_EXT.indexOf(name as Ext), span);
  for (const [name, span] of Object.entries(recipe.ext2 ?? {}))
    w.fraction(m2.ext + MODULE_EXT.indexOf(name as Ext), span);

  // Eyes are independent of the form.
  if (rng.next() < GENESIS_EYES) {
    w.fraction(offsetOf('eyeSize'), [0.4, 0.9]);
    w.fraction(offsetOf('eyeStalk'), [0, 0.5]);
  }
  // Bristles on every slot but the whip: a form's own setae stay if they are already more.
  const B = GENESIS_BRISTLES;
  for (const slot of BRISTLED_SLOTS) {
    if (!w.present(slot) || !(rng.next() < B.chance)) continue;
    w.atLeast(slot.ext + SETAE_DENSITY, B.density);
    w.atLeast(slot.ext + SETAE_LENGTH, B.length);
  }
  return decodeGenome(bytes);
}

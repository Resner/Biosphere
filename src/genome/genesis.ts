// Genesis DNA under rules version 7 (ADR 0025, ADR 0035, DESIGN §6). A genesis cell is the v5 cell
// (colours, size, behaviour, physiology and rare alleles are drawn exactly as before) written as a
// karyotype v2 genome and then given a larval form: a plain cell, a ciliate, a spiny larva, a bell, a
// tadpole or a fan-tailed one. Every form is still one body unit with at most three module slots, so
// the lineage starts at the cell stage; the multi-segment bodies arise through breeding. The form
// draws from its own stream, so it never shifts the v5 draws, and rules 7 bristles the slots other
// than the whip with draws after the form's (M6b T7). The v5 and v6 code stay frozen in
// `genesis-v5.ts` and `genesis-v6.ts` for verifying old genesis records.

import { createRng, type Rng, type Seed } from '../sim/prng';
import { RULES } from '../sim/rules';
import { decodeGenome, encodeGenome, type Genome, upgrade } from './codec';
import { genesisGenomeV5 } from './genesis-v5';
import { HAPLOTYPE_BYTES, MODULE_EXT, MODULE_LOCI, MODULE_PARAMS, SHAPE_LOCI } from './karyotype';
import { HAPLOTYPE_BYTES_V1 } from './karyotype-v1';
import type { Silhouette } from './silhouette';

export { GENESIS_FREQ } from './genesis-v5';

type Param = (typeof MODULE_PARAMS)[number];
type Ext = (typeof MODULE_EXT)[number];
type Shape = (typeof SHAPE_LOCI)[number];

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

/** What a form changes in the v5 cell; absent entries are left as v5 drew them. */
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
  // The v5 cell as it was: a whip, and a band of cilia in half of them (a third of those with three pairs read as ciliates).
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
const shapeOffset = (id: Shape): number => HAPLOTYPE_BYTES_V1 + SHAPE_LOCI.indexOf(id);
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

/** A fresh genesis genome of karyotype v2: a pure function of the seed. */
export function genesisGenome(seed: Seed): Genome {
  const bytes = encodeGenome(upgrade(genesisGenomeV5(seed)));
  const rng = createRng(seed, 'genesis-form');
  const w = new Writer(bytes, rng);
  const { recipe } = pickForm(rng);

  for (const [id, span] of Object.entries(recipe.shape ?? {}))
    w.fraction(shapeOffset(id as Shape), span);
  if (recipe.m2 && !w.present(m2)) {
    // The band the form needs: the v5 draw of a cilia slot, then its own parameters on top.
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
    w.fraction(shapeOffset('eyeSize'), [0.4, 0.9]);
    w.fraction(shapeOffset('eyeStalk'), [0, 0.5]);
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

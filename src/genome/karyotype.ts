// Karyotype v1 (ADR 0006, ADR 0018, DESIGN §6): the single table that lays a haplotype out in bytes.
// Every locus is one byte except a module slot (a presence byte and 14 parameters). Changing the
// layout is a new karyotype version; the old decoder stays for verifying history.

export const KARYOTYPE_VERSION = 1;

export const MODULE_SLOTS = 8;
export const MODULE_PARAMS = [
  'length',
  'thickness',
  'taper',
  'curvature',
  'joints',
  'branching',
  'tipShape',
  'stiffness',
  'beat',
  'phase',
  'attachStart',
  'attachSpan',
  'angle',
  'pairs',
] as const;
export const MODULE_BYTES = 1 + MODULE_PARAMS.length;

export type Dominance = 'complete' | 'codominant' | 'incomplete';

interface LocusBase {
  readonly id: string;
  /** Chromosome 1-6. */
  readonly chr: number;
  /** Byte offset inside a haplotype. */
  readonly offset: number;
  readonly size: number;
}

/** An allele value 0-255, expressed additively. */
export interface QuantLocus extends LocusBase {
  readonly kind: 'quant';
}

/**
 * An allele id from a small table. `rank` orders the alleles: with `complete` dominance the higher
 * rank is expressed (equal ranks show both), `codominant` shows both, and `incomplete` blends the
 * ranks. Alleles from `novelFrom` on are never produced by genesis, only by mutation.
 */
export interface MendelLocus extends LocusBase {
  readonly kind: 'mendel';
  readonly alleles: readonly string[];
  readonly rank: readonly number[];
  readonly dominance: Dominance;
  readonly novelFrom: number;
}

/** 0 is functional, 1 is a recessive loss of function. */
export interface LoadLocus extends LocusBase {
  readonly kind: 'load';
}

/** Byte 0 is the presence flag (0 or 1); bytes 1-14 are `MODULE_PARAMS`, all zero when absent. */
export interface ModuleLocus extends LocusBase {
  readonly kind: 'module';
}

export type Locus = QuantLocus | MendelLocus | LoadLocus | ModuleLocus;

type Spec =
  | string
  | { id: string; mendel: Omit<MendelLocus, 'id' | 'chr' | 'offset' | 'size' | 'kind'> }
  | { load: string }
  | { module: string };

const mendel = (
  id: string,
  alleles: readonly string[],
  rank: readonly number[],
  dominance: Dominance,
  novelFrom: number,
): Spec => ({ id, mendel: { alleles, rank, dominance, novelFrom } });

const CHROMOSOMES: readonly (readonly Spec[])[] = [
  // 1 Body plan
  [
    'segDrive1',
    'segDrive2',
    'aspect',
    'taper',
    'flexibility',
    'size1',
    'size2',
    'size3',
    { load: 'L1' },
  ],
  // 2 Integument
  [
    'membrane',
    'translucency',
    'plating1',
    'plating2',
    'spines',
    mendel('iridescence', ['plain', 'iridescent', 'oil'], [2, 1, 0], 'complete', 2),
    mendel('texture', ['smooth', 'grainy', 'ridged'], [0, 1, 2], 'incomplete', 2),
    { load: 'L2' },
  ],
  // 3 Locomotion
  [
    { module: 'M1' },
    { module: 'M2' },
    { module: 'M3' },
    { module: 'M4' },
    'gaitAmp',
    'gaitFreq',
    { load: 'L3' },
  ],
  // 4 Feeding and weapons
  ['mouthSize', 'mouthType', 'digestion', { module: 'M5' }, { module: 'M6' }],
  // 5 Senses and behaviour
  [
    { module: 'M7' },
    { module: 'M8' },
    'aggression',
    'caution',
    'curiosity',
    'reflex',
    mendel(
      'targetPref',
      ['nearest', 'weakest', 'largest', 'strongest'],
      [3, 2, 1, 0],
      'complete',
      3,
    ),
  ],
  // 6 Pigment and physiology
  [
    'hue1',
    'hue2',
    'hue3',
    'saturation',
    'value',
    mendel(
      'pattern',
      ['none', 'rings', 'spots', 'stripes', 'bands'],
      [0, 1, 2, 2, 3],
      'complete',
      4,
    ),
    'patternScale',
    mendel('albino', ['normal', 'albino', 'pale'], [2, 1, 0], 'complete', 2),
    mendel('luminescence', ['off', 'on', 'pulse'], [0, 2, 1], 'complete', 2),
    'lumHue',
    'lifespan',
    'metabolism',
    'growth',
    'uvTolerance',
    'pressureTolerance',
    { load: 'L4' },
  ],
];

function layout(): readonly Locus[] {
  const loci: Locus[] = [];
  let offset = 0;
  CHROMOSOMES.forEach((specs, c) => {
    const chr = c + 1;
    for (const spec of specs) {
      let locus: Locus;
      if (typeof spec === 'string') locus = { kind: 'quant', id: spec, chr, offset, size: 1 };
      else if ('mendel' in spec)
        locus = { kind: 'mendel', id: spec.id, chr, offset, size: 1, ...spec.mendel };
      else if ('load' in spec) locus = { kind: 'load', id: spec.load, chr, offset, size: 1 };
      else locus = { kind: 'module', id: spec.module, chr, offset, size: MODULE_BYTES };
      loci.push(locus);
      offset += locus.size;
    }
  });
  return loci;
}

export const LOCI: readonly Locus[] = Object.freeze(layout());

export const HAPLOTYPE_BYTES: number = LOCI.reduce((n, l) => n + l.size, 0);
/** Two haplotypes, back to back. */
export const GENOME_BYTES: number = 2 * HAPLOTYPE_BYTES;

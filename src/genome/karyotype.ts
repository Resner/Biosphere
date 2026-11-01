// Karyotype v2 (ADR 0006, ADR 0018, ADR 0025, DESIGN §6): the table that lays a haplotype out in
// bytes, the only one since rules 8 (ADR 0040). The first 164 bytes are the base loci over six
// chromosomes, laid out as karyotype v1 had them; after them come the body-shape loci (chromosome 1),
// then a fixed extension block per module slot. Every locus is one byte except a module slot (a
// presence byte and 14 parameters, plus its extension). Changing the layout is a rules change.

export const KARYOTYPE_VERSION = 2 as const;

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

/** The body-shape loci, appended to chromosome 1 in this order (ADR 0025: curve, tagmata, fusion, symmetry, eyes). */
export const SHAPE_LOCI = [
  'curve',
  'curveMode',
  'headScale',
  'trunkSwell',
  'tailLength',
  'tailTaper',
  'fusion',
  'symmetry',
  'drape',
  'eyeSize',
  'eyeStalk',
] as const;

/** The extension of every module slot, one byte each: fine detail on the slot's parts. */
export const MODULE_EXT = [
  'webbing',
  'setaeDensity',
  'setaeLength',
  'bulb',
  'chela',
  'beads',
] as const;
export const MODULE_EXT_BYTES = MODULE_EXT.length;

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

/**
 * Byte 0 is the presence flag (0 or 1); bytes 1-14 are `MODULE_PARAMS`, and the `MODULE_EXT` block
 * at `ext` moves and clears with the slot. All zero when absent.
 */
export interface ModuleLocus extends LocusBase {
  readonly kind: 'module';
  readonly ext: number;
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

/** The base loci, chromosome by chromosome, in byte order. */
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

const sizeOf = (spec: Spec): number =>
  typeof spec === 'object' && 'module' in spec ? MODULE_BYTES : 1;

/** Bytes of the base loci: where the shape loci start. */
export const BASE_BYTES: number = CHROMOSOMES.flat().reduce((n, s) => n + sizeOf(s), 0);

function layout(): readonly Locus[] {
  const loci: Locus[] = [];
  const extStart = BASE_BYTES + SHAPE_LOCI.length;
  let offset = 0;
  let slot = 0;
  CHROMOSOMES.forEach((specs, c) => {
    const chr = c + 1;
    for (const spec of specs) {
      let locus: Locus;
      if (typeof spec === 'string') locus = { kind: 'quant', id: spec, chr, offset, size: 1 };
      else if ('mendel' in spec)
        locus = { kind: 'mendel', id: spec.id, chr, offset, size: 1, ...spec.mendel };
      else if ('load' in spec) locus = { kind: 'load', id: spec.load, chr, offset, size: 1 };
      else
        locus = {
          kind: 'module',
          id: spec.module,
          chr,
          offset,
          size: MODULE_BYTES,
          ext: extStart + MODULE_EXT_BYTES * slot++,
        };
      loci.push(locus);
      offset += locus.size;
    }
  });
  SHAPE_LOCI.forEach((id, i) => {
    loci.push({ kind: 'quant', id, chr: 1, offset: BASE_BYTES + i, size: 1 });
  });
  return loci;
}

/** Every locus in byte order: the base loci, then the shape loci. A slot's extension sits at its `ext`. */
export const LOCI: readonly Locus[] = Object.freeze(layout());
export const MENDEL_LOCI: readonly MendelLocus[] = LOCI.filter((l) => l.kind === 'mendel');
export const LOAD_LOCI: readonly LoadLocus[] = LOCI.filter((l) => l.kind === 'load');
export const MODULE_LOCI: readonly ModuleLocus[] = LOCI.filter((l) => l.kind === 'module');

export const HAPLOTYPE_BYTES: number =
  BASE_BYTES + SHAPE_LOCI.length + MODULE_LOCI.length * MODULE_EXT_BYTES;
/** Two haplotypes, back to back. */
export const GENOME_BYTES: number = 2 * HAPLOTYPE_BYTES;

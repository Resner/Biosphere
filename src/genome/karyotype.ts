// Karyotype v2 (ADR 0025, DESIGN §6): the table that lays a haplotype out in bytes from rules
// version 6. It appends to the frozen v1 table (`karyotype-v1.ts`), whose bytes keep their meaning
// and position: after them come the body-shape loci (chromosome 1), then a fixed extension block per
// module slot. Every new locus reads 0 as "off" or v1 behaviour, so a zero-padded v1 genome develops
// as it did under v1. Changing the layout is a new karyotype version; the old table stays.

import {
  HAPLOTYPE_BYTES_V1,
  LOCI_V1,
  type LoadLocus,
  type MendelLocus,
  type ModuleLocus as ModuleLocusV1,
  type QuantLocus,
} from './karyotype-v1';

export {
  type Dominance,
  type LoadLocus,
  type MendelLocus,
  MODULE_BYTES,
  MODULE_PARAMS,
  MODULE_SLOTS,
  type QuantLocus,
} from './karyotype-v1';

export const KARYOTYPE_VERSION = 2 as const;

/** The karyotype that births and genesis write under a rules version: v1 up to rules 5, v2 from 6. */
export function karyotypeForRules(rules: number): 1 | 2 {
  return rules <= 5 ? 1 : KARYOTYPE_VERSION;
}

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

/** A v2 module slot: its v1 bytes plus an extension block at `ext`, which moves and clears with the slot. */
export interface ModuleLocus extends ModuleLocusV1 {
  readonly ext: number;
}

export type Locus = QuantLocus | MendelLocus | LoadLocus | ModuleLocus;

function layout(): readonly Locus[] {
  const extStart = HAPLOTYPE_BYTES_V1 + SHAPE_LOCI.length;
  let slot = 0;
  const v1 = LOCI_V1.map(
    (l): Locus => (l.kind === 'module' ? { ...l, ext: extStart + MODULE_EXT_BYTES * slot++ } : l),
  );
  const shape = SHAPE_LOCI.map(
    (id, i): QuantLocus => ({ kind: 'quant', id, chr: 1, offset: HAPLOTYPE_BYTES_V1 + i, size: 1 }),
  );
  return [...v1, ...shape];
}

/** Every locus in byte order: the v1 loci, then the shape loci. A slot's extension sits at its `ext`. */
export const LOCI: readonly Locus[] = Object.freeze(layout());
export const MENDEL_LOCI: readonly MendelLocus[] = LOCI.filter((l) => l.kind === 'mendel');
export const LOAD_LOCI: readonly LoadLocus[] = LOCI.filter((l) => l.kind === 'load');
export const MODULE_LOCI: readonly ModuleLocus[] = LOCI.filter((l) => l.kind === 'module');

export const HAPLOTYPE_BYTES: number =
  HAPLOTYPE_BYTES_V1 + SHAPE_LOCI.length + MODULE_LOCI.length * MODULE_EXT_BYTES;
/** Two haplotypes, back to back. */
export const GENOME_BYTES: number = 2 * HAPLOTYPE_BYTES;

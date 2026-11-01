// Expression (ADR 0006): a genome's two haplotypes become plain-data traits. Total and symmetric:
// any genome, even one that was not built by the codec, gives finite in-range traits, and swapping
// the haplotypes changes nothing. The sim never sees this; `develop` and `computeStats` consume it.

import { pow } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Genome, Haplotype } from './codec';
import {
  LOCI,
  type Locus,
  type MendelLocus,
  MODULE_EXT,
  MODULE_LOCI,
  MODULE_PARAMS,
  type ModuleLocus,
  SHAPE_LOCI,
} from './karyotype';

export type ModuleParam = (typeof MODULE_PARAMS)[number];
export type ModuleExt = (typeof MODULE_EXT)[number];
export type ShapeTrait = (typeof SHAPE_LOCI)[number];

/** A module slot as expressed; parameters are raw 0-255 values (T5 maps them to lengths and angles). */
export interface ModuleTrait {
  present: boolean;
  params: Record<ModuleParam, number>;
  /** Karyotype v2 detail on the slot's parts, each on its `RULES.genes.range.part` range; 0 is off. */
  ext: Record<ModuleExt, number>;
}

export interface Traits {
  body: {
    /** 1..RULES.genes.segments. */
    segments: number;
    aspect: number;
    taper: number;
    flexibility: number;
    maxBiomass: number;
  };
  skin: {
    membrane: number;
    translucency: number;
    plating: number;
    spines: number;
    iridescence: string;
    /** 0 smooth, 1 grainy, 2 ridged; a heterozygote blends. */
    texture: number;
  };
  /** Slots M1-M8. */
  modules: ModuleTrait[];
  mouth: { size: number; type: number; digestion: number };
  /** The swimming gait and the combat autopilot (M7). */
  behaviour: {
    gaitAmp: number;
    gaitFreq: number;
    aggression: number;
    caution: number;
    curiosity: number;
    reflex: number;
    targetPref: string;
  };
  colour: {
    hue: number;
    saturation: number;
    value: number;
    /** One allele, or both when two equally ranked ones meet (spots with stripes). */
    pattern: string[];
    patternScale: number;
    albino: string;
    luminescence: string;
    lumHue: number;
  };
  physiology: {
    lifespan: number;
    metabolism: number;
    growth: number;
    uvTolerance: number;
    pressureTolerance: number;
  };
  /** Body shape (ADR 0025) on the `RULES.genes.range.shape` ranges: all 0 is the plain body. */
  shape: Record<ShapeTrait, number>;
  /** Factors that are 1 unless the matching load locus is homozygous loss of function. */
  defects: {
    membraneIntegrity: number;
    partScale: number;
    beatStrength: number;
    metabolismCost: number;
  };
}

type RangedGroup = keyof typeof RULES.genes.range;

interface QuantTrait {
  group: RangedGroup;
  key: string;
  /** Loci that sum with equal weight; the trait is their mean across both alleles. */
  loci: readonly string[];
}

/** Every linear quantitative trait. A locus moving 0-255 on both alleles moves its trait by (high − low) ÷ loci.length. */
export const QUANT_TRAITS: readonly QuantTrait[] = [
  { group: 'body', key: 'aspect', loci: ['aspect'] },
  { group: 'body', key: 'taper', loci: ['taper'] },
  { group: 'body', key: 'flexibility', loci: ['flexibility'] },
  { group: 'skin', key: 'membrane', loci: ['membrane'] },
  { group: 'skin', key: 'translucency', loci: ['translucency'] },
  { group: 'skin', key: 'plating', loci: ['plating1', 'plating2'] },
  { group: 'skin', key: 'spines', loci: ['spines'] },
  { group: 'mouth', key: 'size', loci: ['mouthSize'] },
  { group: 'mouth', key: 'type', loci: ['mouthType'] },
  { group: 'mouth', key: 'digestion', loci: ['digestion'] },
  { group: 'behaviour', key: 'gaitAmp', loci: ['gaitAmp'] },
  { group: 'behaviour', key: 'gaitFreq', loci: ['gaitFreq'] },
  { group: 'behaviour', key: 'aggression', loci: ['aggression'] },
  { group: 'behaviour', key: 'caution', loci: ['caution'] },
  { group: 'behaviour', key: 'curiosity', loci: ['curiosity'] },
  { group: 'behaviour', key: 'reflex', loci: ['reflex'] },
  { group: 'colour', key: 'hue', loci: ['hue1', 'hue2', 'hue3'] },
  { group: 'colour', key: 'saturation', loci: ['saturation'] },
  { group: 'colour', key: 'value', loci: ['value'] },
  { group: 'colour', key: 'patternScale', loci: ['patternScale'] },
  { group: 'colour', key: 'lumHue', loci: ['lumHue'] },
  { group: 'physiology', key: 'lifespan', loci: ['lifespan'] },
  { group: 'physiology', key: 'metabolism', loci: ['metabolism'] },
  { group: 'physiology', key: 'growth', loci: ['growth'] },
  { group: 'physiology', key: 'uvTolerance', loci: ['uvTolerance'] },
  { group: 'physiology', key: 'pressureTolerance', loci: ['pressureTolerance'] },
  ...SHAPE_LOCI.map((id): QuantTrait => ({ group: 'shape', key: id, loci: [id] })),
];

/** The segmentation drive and the size loci are polygenic but map nonlinearly. */
export const SEGMENT_LOCI = ['segDrive1', 'segDrive2'] as const;
export const SIZE_LOCI = ['size1', 'size2', 'size3'] as const;

const byId = new Map<string, Locus>(LOCI.map((l) => [l.id, l]));

export function locusOf(id: string): Locus {
  return byId.get(id) as Locus;
}

/** An allele byte, whatever the haplotype holds. */
export function byte(h: Haplotype, offset: number): number {
  const v = h.alleles[offset];
  return typeof v === 'number' && Number.isFinite(v) ? v & 0xff : 0;
}

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Mean of the loci's alleles on both haplotypes, 0-1; exact at 0 and 1. */
function fraction(g: Genome, ids: readonly string[]): number {
  let sum = 0;
  for (const id of ids) {
    const at = locusOf(id).offset;
    sum += byte(g.haplotypes[0], at) + byte(g.haplotypes[1], at);
  }
  return clamp01(sum / (510 * ids.length));
}

function ranged(group: RangedGroup, key: string, f: number): number {
  const table = RULES.genes.range[group] as unknown as Record<string, readonly number[]>;
  const [lo, hi] = table[key] as readonly [number, number];
  const v = lo + (hi - lo) * f;
  return v < lo ? lo : v > hi ? hi : v;
}

export function allele(g: Genome, locus: MendelLocus, hap: 0 | 1): number {
  return byte(g.haplotypes[hap], locus.offset) % locus.alleles.length;
}

/**
 * Complete dominance: the higher rank shows; equal ranks of different alleles show both (table
 * order), and a co-dominant locus always shows both.
 */
export function dominant(g: Genome, id: string): string[] {
  const locus = locusOf(id) as MendelLocus;
  const a = allele(g, locus, 0);
  const b = allele(g, locus, 1);
  const ra = locus.rank[a] as number;
  const rb = locus.rank[b] as number;
  if (locus.dominance !== 'codominant') {
    if (ra > rb) return [locus.alleles[a] as string];
    if (rb > ra) return [locus.alleles[b] as string];
  }
  return [...new Set([a, b].sort((x, y) => x - y))].map((i) => locus.alleles[i] as string);
}

export function blended(g: Genome, id: string): number {
  const locus = locusOf(id) as MendelLocus;
  const ra = locus.rank[allele(g, locus, 0)] as number;
  const rb = locus.rank[allele(g, locus, 1)] as number;
  return (ra + rb) / 2;
}

function homozygousLof(g: Genome, id: string): boolean {
  const at = locusOf(id).offset;
  return (byte(g.haplotypes[0], at) & 1) === 1 && (byte(g.haplotypes[1], at) & 1) === 1;
}

function expressModule(g: Genome, slot: ModuleLocus): ModuleTrait {
  const at = slot.offset;
  const [a, b] = g.haplotypes;
  const inA = (byte(a, at) & 1) === 1;
  const inB = (byte(b, at) & 1) === 1;
  // The mean rounds half up, so both haplotype orders agree.
  const value = (offset: number): number => {
    const pa = byte(a, offset);
    const pb = byte(b, offset);
    return inA && inB ? (pa + pb + 1) >> 1 : inA ? pa : inB ? pb : 0;
  };
  const params = {} as Record<ModuleParam, number>;
  MODULE_PARAMS.forEach((name, k) => {
    params[name] = value(at + 1 + k);
  });
  // The extension follows its slot.
  const ext = {} as Record<ModuleExt, number>;
  MODULE_EXT.forEach((name, k) => {
    ext[name] = ranged('part', name, value(slot.ext + k) / 255);
  });
  return { present: inA || inB, params, ext };
}

/** Max size: 300 · 2^(13·t), with the whole octaves multiplied exactly so t = 0 and t = 1 give the endpoints. */
function maxBiomass(t: number): number {
  const { base, octaves } = RULES.genes.size;
  const e = octaves * t;
  const whole = Math.floor(e);
  let scale = 1;
  for (let i = 0; i < whole; i++) scale *= 2;
  const frac = e - whole;
  return base * scale * (frac > 0 ? pow(2, frac) : 1);
}

const QUANT_BY_GROUP = new Map<RangedGroup, readonly QuantTrait[]>();
for (const q of QUANT_TRAITS)
  QUANT_BY_GROUP.set(q.group, [...(QUANT_BY_GROUP.get(q.group) ?? []), q]);

/** The linear traits of one group, keyed by trait name. */
function quantGroup(g: Genome, group: RangedGroup): Record<string, number> {
  const out: Record<string, number> = {};
  for (const q of QUANT_BY_GROUP.get(group) ?? []) {
    out[q.key] = ranged(group, q.key, fraction(g, q.loci));
  }
  return out;
}

export function express(g: Genome): Traits {
  const maxSegments = RULES.genes.segments;
  const lof = RULES.genes.lof;
  return {
    body: {
      ...(quantGroup(g, 'body') as Pick<Traits['body'], 'aspect' | 'taper' | 'flexibility'>),
      segments: 1 + Math.min(maxSegments - 1, Math.floor(fraction(g, SEGMENT_LOCI) * maxSegments)),
      maxBiomass: maxBiomass(fraction(g, SIZE_LOCI)),
    },
    skin: {
      ...(quantGroup(g, 'skin') as Pick<
        Traits['skin'],
        'membrane' | 'translucency' | 'plating' | 'spines'
      >),
      iridescence: dominant(g, 'iridescence')[0] as string,
      texture: blended(g, 'texture'),
    },
    modules: MODULE_LOCI.map((slot) => expressModule(g, slot)),
    mouth: quantGroup(g, 'mouth') as Traits['mouth'],
    behaviour: {
      ...(quantGroup(g, 'behaviour') as Omit<Traits['behaviour'], 'targetPref'>),
      targetPref: dominant(g, 'targetPref')[0] as string,
    },
    colour: {
      ...(quantGroup(g, 'colour') as Pick<
        Traits['colour'],
        'hue' | 'saturation' | 'value' | 'patternScale' | 'lumHue'
      >),
      pattern: dominant(g, 'pattern'),
      albino: dominant(g, 'albino')[0] as string,
      luminescence: dominant(g, 'luminescence')[0] as string,
    },
    physiology: quantGroup(g, 'physiology') as Traits['physiology'],
    shape: quantGroup(g, 'shape') as Traits['shape'],
    defects: {
      membraneIntegrity: homozygousLof(g, 'L1') ? lof.membraneIntegrity : 1,
      partScale: homozygousLof(g, 'L2') ? lof.partScale : 1,
      beatStrength: homozygousLof(g, 'L3') ? lof.beatStrength : 1,
      metabolismCost: homozygousLof(g, 'L4') ? lof.metabolismCost : 1,
    },
  };
}

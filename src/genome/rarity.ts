// Rarity (M3 T9, DESIGN §6): how surprising a creature's looks and body are, as bits. Each rare
// feature costs -log2 of its exact frequency among genesis cells, worked out here from the genesis
// allele frequencies and the real dominance rules, so it cannot drift from `genesis.ts`. A feature
// genesis never makes (extra segments, more modules, a novel allele, a big body) costs 12 bits.

import { decodeGenome, type Genome } from './codec';
import { express, type Traits } from './express';
import { GENESIS_FREQ } from './genesis';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, type MendelLocus } from './karyotype';

export type RarityTier = 'common' | 'uncommon' | 'rare' | 'exotic';

export interface Rarity {
  score: number;
  tier: RarityTier;
  features: string[];
}

/** The cost of a feature that genesis never produces. */
export const NEVER_BITS = 12;

/** Each tier from its lowest score (DESIGN §6). */
export const RARITY_TIERS: readonly (readonly [RarityTier, number])[] = [
  ['common', 0],
  ['uncommon', 4],
  ['rare', 8],
  ['exotic', 14],
];

/** Tier 1 starts at radius 32 (ADR 0013), which is a biomass of 1,024. */
const TIER_1_BIOMASS = 1024;
/** Genesis cells fill slots M1 (whip) and M2 (cilia); anything else is an extra module. */
const GENESIS_MODULES = 2;

type Test = (t: Traits) => boolean;

const locusOf = (id: string): MendelLocus => LOCI.find((l) => l.id === id) as MendelLocus;

/** The share of genesis cells whose traits pass `test`, over every pair of alleles at one locus. */
function genesisShare(id: string, weights: readonly number[], test: Test): number {
  const at = locusOf(id).offset;
  let share = 0;
  weights.forEach((wa, a) => {
    weights.forEach((wb, b) => {
      const bytes = new Uint8Array(GENOME_BYTES);
      bytes[at] = a;
      bytes[HAPLOTYPE_BYTES + at] = b;
      if (test(express(decodeGenome(bytes)))) share += wa * wb;
    });
  });
  return share;
}

const biallelic = (p: number): number[] => [1 - p, p];
const has =
  (name: string): Test =>
  (t) =>
    t.colour.pattern.includes(name);

/** A rare feature that genesis makes: how to see it, and how often genesis shows it. */
const COMMON_KINDS: readonly (readonly [string, Test, number])[] = [
  [
    'iridescent',
    (t) => t.skin.iridescence === 'iridescent',
    genesisShare(
      'iridescence',
      biallelic(GENESIS_FREQ.iridescent),
      (t) => t.skin.iridescence === 'iridescent',
    ),
  ],
  [
    'albino',
    (t) => t.colour.albino === 'albino',
    genesisShare('albino', biallelic(GENESIS_FREQ.albino), (t) => t.colour.albino === 'albino'),
  ],
  ['stripes', has('stripes'), genesisShare('pattern', GENESIS_FREQ.pattern, has('stripes'))],
  ['spots', has('spots'), genesisShare('pattern', GENESIS_FREQ.pattern, has('spots'))],
  ['rings', has('rings'), genesisShare('pattern', GENESIS_FREQ.pattern, has('rings'))],
  [
    'luminescent',
    (t) => t.colour.luminescence !== 'off',
    genesisShare(
      'luminescence',
      biallelic(GENESIS_FREQ.luminescent),
      (t) => t.colour.luminescence !== 'off',
    ),
  ],
];

/** The alleles that only mutation makes, as they show in a creature's traits. */
const NOVEL: readonly Test[] = (() => {
  const names = (id: string): string[] => {
    const l = locusOf(id);
    return l.alleles.slice(l.novelFrom);
  };
  const shows = (id: string, read: (t: Traits) => string[]): Test => {
    const novel = names(id);
    return (t) => read(t).some((n) => novel.includes(n));
  };
  // An incomplete-dominance locus shows a blend, so a novel allele pushes it past the genesis ranks.
  const texture = locusOf('texture');
  const genesisTop = Math.max(...texture.rank.slice(0, texture.novelFrom));
  return [
    shows('iridescence', (t) => [t.skin.iridescence]),
    shows('albino', (t) => [t.colour.albino]),
    shows('luminescence', (t) => [t.colour.luminescence]),
    shows('pattern', (t) => t.colour.pattern),
    shows('targetPref', (t) => [t.behaviour.targetPref]),
    (t) => t.skin.texture > genesisTop,
  ];
})();

const NEVER_KINDS: readonly (readonly [string, Test])[] = [
  ['segments', (t) => t.body.segments > 1],
  ['modules', (t) => t.modules.slice(GENESIS_MODULES).some((m) => m.present)],
  ['novel', (t) => NOVEL.some((shows) => shows(t))],
  ['size', (t) => t.body.maxBiomass >= TIER_1_BIOMASS],
];

/** The price of each feature in bits, in listing order. */
export const featureBits: Readonly<Record<string, number>> = Object.freeze({
  ...Object.fromEntries(
    COMMON_KINDS.map(([name, , share]) => [name, share > 0 ? -Math.log2(share) : NEVER_BITS]),
  ),
  ...Object.fromEntries(NEVER_KINDS.map(([name]) => [name, NEVER_BITS])),
});

const FEATURES: readonly (readonly [string, Test])[] = [
  ...COMMON_KINDS.map(([name, test]) => [name, test] as const),
  ...NEVER_KINDS,
];

export function rarityOfTraits(traits: Traits): Rarity {
  const features: string[] = [];
  let score = 0;
  for (const [name, test] of FEATURES) {
    if (!test(traits)) continue;
    features.push(name);
    score += featureBits[name] as number;
  }
  let tier: RarityTier = 'common';
  for (const [name, from] of RARITY_TIERS) if (score >= from) tier = name;
  return { score, tier, features };
}

export function rarityOf(g: Genome): Rarity {
  return rarityOfTraits(express(g));
}

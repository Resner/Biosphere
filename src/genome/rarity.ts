// Rarity (M3 T9, DESIGN §6): how surprising a creature's looks and body are, as bits. Each rare
// feature costs -log2 of its exact frequency among genesis cells, worked out here from the genesis
// allele frequencies and the real dominance rules, so it cannot drift from `genesis.ts`. A feature
// genesis never makes (extra segments, more modules, a novel allele, a big body) costs 12 bits.

import { decodeGenome, type Genome } from './codec';
import { express, type Traits } from './express';
import { GENESIS_FREQ } from './genesis';
import { GENOME_BYTES, HAPLOTYPE_BYTES, LOCI, type MendelLocus } from './karyotype';
import { sizeTier } from './size';

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

/** Genesis cells fill slots M1 (whip) and M2 (cilia); anything else is an extra module. */
const GENESIS_MODULES = 2;

type Test = (t: Traits) => boolean;
/** A rare feature: its name, how to see it in the traits, and its price in bits. */
type Feature = readonly [string, Test, number];

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

/** A rare feature that genesis makes: its price follows from how often genesis shows it. */
function common(name: string, locus: string, weights: readonly number[], test: Test): Feature {
  const share = genesisShare(locus, weights, test);
  return [name, test, share > 0 ? -Math.log2(share) : NEVER_BITS];
}

const iridescent: Test = (t) => t.skin.iridescence === 'iridescent';
const albino: Test = (t) => t.colour.albino === 'albino';
const luminescent: Test = (t) => t.colour.luminescence !== 'off';

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

const never = (name: string, test: Test): Feature => [name, test, NEVER_BITS];

/** Every rare feature with its price in bits, in listing order. */
const FEATURES: readonly Feature[] = [
  common('iridescent', 'iridescence', biallelic(GENESIS_FREQ.iridescent), iridescent),
  common('albino', 'albino', biallelic(GENESIS_FREQ.albino), albino),
  common('stripes', 'pattern', GENESIS_FREQ.pattern, has('stripes')),
  common('spots', 'pattern', GENESIS_FREQ.pattern, has('spots')),
  common('rings', 'pattern', GENESIS_FREQ.pattern, has('rings')),
  common('luminescent', 'luminescence', biallelic(GENESIS_FREQ.luminescent), luminescent),
  never('segments', (t) => t.body.segments > 1),
  never('modules', (t) => t.modules.slice(GENESIS_MODULES).some((m) => m.present)),
  never('novel', (t) => NOVEL.some((shows) => shows(t))),
  never('size', (t) => sizeTier(t.body.maxBiomass) >= 1),
];

/** The price of each feature in bits. */
export const featureBits: Readonly<Record<string, number>> = Object.freeze(
  Object.fromEntries(FEATURES.map(([name, , bits]) => [name, bits])),
);

export function rarityOfTraits(traits: Traits): Rarity {
  const features: string[] = [];
  let score = 0;
  for (const [name, test, bits] of FEATURES) {
    if (!test(traits)) continue;
    features.push(name);
    score += bits;
  }
  let tier: RarityTier = 'common';
  for (const [name, from] of RARITY_TIERS) if (score >= from) tier = name;
  return { score, tier, features };
}

export function rarityOf(g: Genome): Rarity {
  return rarityOfTraits(express(g));
}

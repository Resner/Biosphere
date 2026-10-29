// Rarity (M3 T9, DESIGN §6): how surprising a creature's looks and body are, as bits. Each rare
// feature costs -log2 of its exact frequency among genesis cells, worked out here from the genesis
// allele frequencies and the real dominance rules, or from the genesis form table, so it cannot
// drift from `genesis-v6.ts`. A feature genesis never makes (extra segments, more modules, a novel
// allele, a big body, a coil, a carapace, a chela) costs 12 bits.

import { log } from '../sim/math';
import { RULES } from '../sim/rules';
import { sizeTier } from '../sim/size';
import { decodeGenome, type Genome } from './codec';
import { weaponShare } from './develop';
import { express, type Traits } from './express';
import { GENESIS_EYES, GENESIS_FORMS, GENESIS_FREQ } from './genesis-v6';
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

/** The price of a feature that genesis makes in `share` of its cells (none: it never does). */
const bitsOf = (share: number): number => (share > 0 ? -log(share) * Math.LOG2E : NEVER_BITS);

/** A rare feature that genesis makes: its price follows from how often genesis shows it. */
function common(name: string, locus: string, weights: readonly number[], test: Test): Feature {
  return [name, test, bitsOf(genesisShare(locus, weights, test))];
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

/** The v2 body (ADR 0025). Genesis forms and eyes are drawn from tables, so their shares are exact. */
const D = RULES.develop;
const formShare = (pick: (f: (typeof GENESIS_FORMS)[number]) => boolean): number =>
  GENESIS_FORMS.filter(pick).reduce((sum, f) => sum + f.weight, 0);
const coil: Test = (t) => t.shape.curve > D.curve.coilStart;
const radial: Test = (t) => t.shape.symmetry >= D.radial.at;
const carapace: Test = (t) => Math.round(t.shape.fusion * t.body.segments) >= 1;
const chela: Test = (t) =>
  t.modules.some(
    (m) =>
      m.present && m.ext.chela > D.detail.chela.min && weaponShare(m.params.tipShape / 255) > 0,
  );
const webbing: Test = (t) => t.modules.some((m) => m.present && m.ext.webbing > 0);
const eyes: Test = (t) => t.shape.eyeSize > D.eyes.min;

/** Every rare feature with its price in bits, in listing order. */
const FEATURES: readonly Feature[] = [
  common('iridescent', 'iridescence', biallelic(GENESIS_FREQ.iridescent), iridescent),
  common('albino', 'albino', biallelic(GENESIS_FREQ.albino), albino),
  common('stripes', 'pattern', GENESIS_FREQ.pattern, has('stripes')),
  common('spots', 'pattern', GENESIS_FREQ.pattern, has('spots')),
  common('rings', 'pattern', GENESIS_FREQ.pattern, has('rings')),
  common('luminescent', 'luminescence', biallelic(GENESIS_FREQ.luminescent), luminescent),
  ['radial', radial, bitsOf(formShare((f) => f.radial))],
  ['webbing', webbing, bitsOf(formShare((f) => f.webbed))],
  ['eyes', eyes, bitsOf(GENESIS_EYES)],
  never('coil', coil),
  never('carapace', carapace),
  never('chela', chela),
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

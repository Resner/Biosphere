// Species-like names (M3 T9, DESIGN §6): a genus built from syllables by the genome hash, and an
// epithet that says what the body is best at. Pure and ASCII. The syllables are consonant-vowel
// pairs and the suffixes and epithets are fixed words, so no name can spell a word the chat filter
// blocks (a test walks every possible genus).

import { type Genome, genomeHash } from './codec';
import { express, type Traits } from './express';

// No k, p or f: with them a few stems spell slurs ("kanake"), which the filter test found.
const CONSONANTS = 'bdglmnrstvz';
const VOWELS = 'aeio';
export const SYLLABLES: readonly string[] = [...CONSONANTS].flatMap((c) =>
  [...VOWELS].map((v) => c + v),
);

export const GENUS_SUFFIXES: readonly string[] = [
  'thrix',
  'ella',
  'onas',
  'ium',
  'ocus',
  'ina',
  'ula',
  'phora',
  'nema',
  'cystis',
  'spira',
  'monas',
  'plasma',
  'zoon',
  'coccus',
  'bacter',
  'myxa',
  'trix',
  'fera',
  'plax',
  'rhiza',
  'vorax',
  'cilia',
  'spora',
];

const STEM_SYLLABLES = 3;

/** How strongly a trait makes the body what the epithet says, 0-1; the strongest one names it. */
const EPITHET_SCORES: readonly (readonly [string, (t: Traits) => number])[] = [
  ['armatus', (t) => t.skin.plating],
  ['spinosus', (t) => t.skin.spines],
  ['ferox', (t) => Math.max(0, (t.mouth.type - 0.5) * 2)],
  ['filtrans', (t) => Math.max(0, (0.5 - t.mouth.type) * 2)],
  ['lucens', (t) => (t.colour.luminescence === 'off' ? 0 : 0.6)],
  ['iridescens', (t) => (t.skin.iridescence === 'plain' ? 0 : 0.65)],
  ['albus', (t) => (t.colour.albino === 'normal' ? 0 : 0.65)],
  // Size in octaves above the smallest cell: a giant (13 octaves) scores 1.
  ['magnus', (t) => Math.log2(t.body.maxBiomass / 300) / 13],
  ['serpens', (t) => (t.body.segments > 1 ? 0.3 + 0.1 * t.body.segments : 0)],
  // The default: a swimmer, a little more so when the gait is wide.
  ['natans', (t) => 0.25 + 0.5 * t.behaviour.gaitAmp],
];

export const EPITHETS: readonly string[] = EPITHET_SCORES.map(([name]) => name);

function epithetOf(traits: Traits): string {
  let best = 'natans';
  let top = -1;
  for (const [name, score] of EPITHET_SCORES) {
    const s = score(traits);
    if (s > top) {
      top = s;
      best = name;
    }
  }
  return best;
}

/** Genus from the genome hash, epithet from the body: for example "Kavelothrix natans". */
export function speciesName(g: Genome): string {
  const hash = genomeHash(g);
  const word = (k: number): number => Number.parseInt(hash.slice(k * 4, k * 4 + 4), 16);
  let genus = '';
  for (let i = 0; i < STEM_SYLLABLES; i++) genus += SYLLABLES[word(i) % SYLLABLES.length];
  genus += GENUS_SUFFIXES[word(STEM_SYLLABLES) % GENUS_SUFFIXES.length];
  return `${genus.charAt(0).toUpperCase()}${genus.slice(1)} ${epithetOf(express(g))}`;
}

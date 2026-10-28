// The specimen search (M6 T9, ADR 0024): builds a karyotype v2 genome for a target silhouette class
// or rarity tier by a deterministic search from a seed: genesis cells and wild cells in turn, the
// first valid body that matches. The gallery's added specimens come from here and are then stored
// as hex, never re-drawn (`npm run specimens -- --write`).

import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeGenome, type Genome, genomeHash } from '../src/genome/codec';
import { bodyViolations } from '../src/genome/develop';
import { genesisGenome } from '../src/genome/genesis';
import { type RarityTier, rarityOfTraits } from '../src/genome/rarity';
import { SILHOUETTES, type Silhouette, silhouetteOf } from '../src/genome/silhouette';
import { buildCreature, type Creature } from '../src/genome/stats';
import { specimenOf, wildGenome } from '../src/lab/specimens';
import { seedFromString } from '../src/sim/prng';

/** Every silhouette class a specimen is made for: all but `other`. */
export const SPECIMEN_SILHOUETTES: readonly Silhouette[] = SILHOUETTES.filter((s) => s !== 'other');
export const SPECIMEN_TIERS: readonly RarityTier[] = ['common', 'uncommon', 'rare', 'exotic'];

/** Candidates tried before giving up. */
const BUDGET = 20_000;

export interface Found {
  genome: Genome;
  /** The candidate number that matched. */
  tried: number;
}

/** Candidate `i`: genesis cells and wild cells in turn, all karyotype v2. */
function candidate(seed: string, i: number): Genome {
  const at = seedFromString(`${seed}/specimen/${i}`);
  return i % 2 === 0 ? genesisGenome(at) : wildGenome(at);
}

function search(
  seed: string,
  taken: ReadonlySet<string>,
  accept: (c: Creature) => boolean,
): Found | null {
  for (let i = 0; i < BUDGET; i++) {
    const genome = candidate(seed, i);
    // Only the cheap parts of a specimen: its text and name are built for the winner alone.
    const c = buildCreature(genome);
    if (accept(c) && bodyViolations(c.plan).length === 0 && !taken.has(genomeHash(genome)))
      return { genome, tried: i };
  }
  return null;
}

/** The first valid body of silhouette class `target` whose genome hash is not in `taken`, or null. */
export function findSpecimen(
  target: Silhouette,
  seed: string,
  taken: ReadonlySet<string> = new Set(),
): Found | null {
  return search(seed, taken, (c) => silhouetteOf(c.plan) === target);
}

/** The first valid body of rarity tier `tier` whose genome hash is not in `taken`, or null. */
export function findTier(
  tier: RarityTier,
  seed: string,
  taken: ReadonlySet<string> = new Set(),
): Found | null {
  return search(seed, taken, (c) => rarityOfTraits(c.traits).tier === tier);
}

/** A gallery file for `genome`: its name (`NN-specimen-<what>-<genus>-<epithet>.hex`) and text (a comment, then hex). */
export function specimenFile(
  index: number,
  what: string,
  genome: Genome,
  seed: string,
): { name: string; text: string } {
  const s = specimenOf(genome);
  const c = s.creature;
  const name = `${String(index).padStart(2, '0')}-specimen-${what}-${s.species.toLowerCase().replace(' ', '-')}.hex`;
  const comment = `${s.species}, ${what} specimen (search seed ${seed}): ${c.plan.segments.length} segments, ${c.plan.appendages.length / 2} parts, ${s.silhouette}, ${s.rarity}.`;
  return { name, text: `# ${comment}\n${bytesToHex(encodeGenome(genome))}\n` };
}

// The specimen search (M6 T9, ADR 0024): builds a karyotype v2 genome for a target silhouette class
// or rarity tier by a deterministic search from a seed: genesis cells and wild cells in turn, the
// first valid body that matches. The gallery's added specimens come from here and are then stored
// as hex, never re-drawn (`npm run specimens -- --write`).

import { encodeGenome, type Genome, genomeHash } from '../src/genome/codec';
import { genesisGenome } from '../src/genome/genesis';
import type { RarityTier } from '../src/genome/rarity';
import { SILHOUETTES, type Silhouette } from '../src/genome/silhouette';
import { specimenOf, wildGenome } from '../src/lab/specimens';
import { seedFromString } from '../src/sim/prng';

/** Every silhouette class a specimen is made for: all but `other`. */
export const SPECIMEN_SILHOUETTES: readonly Silhouette[] = SILHOUETTES.filter((s) => s !== 'other');
export const SPECIMEN_TIERS: readonly RarityTier[] = ['common', 'uncommon', 'rare', 'exotic'];

/** Candidates tried before giving up. */
const BUDGET = 20_000;
/** A specimen must draw within the medium budget of the mesh (M6 T10 sets the real ones). */
const MAX_VERTICES = 6000;

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
  accept: (s: ReturnType<typeof specimenOf>) => boolean,
): Found | null {
  for (let i = 0; i < BUDGET; i++) {
    const genome = candidate(seed, i);
    const s = specimenOf(genome);
    if (
      s.violations.length === 0 &&
      s.vertices <= MAX_VERTICES &&
      accept(s) &&
      !taken.has(genomeHash(genome))
    )
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
  return search(seed, taken, (s) => s.silhouette === target);
}

/** The first valid body of rarity tier `tier` whose genome hash is not in `taken`, or null. */
export function findTier(
  tier: RarityTier,
  seed: string,
  taken: ReadonlySet<string> = new Set(),
): Found | null {
  return search(seed, taken, (s) => s.rarity === tier);
}

const hex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

/** A gallery file for `genome`: its name (`NN-specimen-<what>-<genus>-<epithet>.hex`) and text (a comment, then hex). */
export function specimenFile(
  index: number,
  what: string,
  genome: Genome,
  seed: string,
): { name: string; text: string } {
  const s = specimenOf(genome);
  const c = s.creature;
  const parts = c.plan.appendages.length / 2;
  const name = `${String(index).padStart(2, '0')}-specimen-${what}-${s.species.toLowerCase().replace(' ', '-')}.hex`;
  const comment = `${s.species}, ${what} specimen (search seed ${seed}): ${c.plan.segments.length} segments, ${parts} parts, ${s.silhouette}, ${s.rarity}.`;
  return { name, text: `# ${comment}\n${hex(encodeGenome(genome))}\n` };
}

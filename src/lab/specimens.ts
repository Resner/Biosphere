// What the Lab shows (M3 T13): genomes from a page seed, and everything the grid and the inspector
// need to know about each one. Pure, so the same seed always gives the same 24 creatures.

import { decodeGenome, type Genome } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { bodyViolations, estimateVertices } from '../genome/develop';
import { genesisGenome } from '../genome/genesis';
import { GENOME_BYTES } from '../genome/karyotype';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { type Silhouette, silhouetteOf } from '../genome/silhouette';
import { buildCreature, type Creature } from '../genome/stats';
import { createRng, seedFromString } from '../sim/prng';
import { sizeTier } from '../sim/size';

/** Genesis cells, or random genome bytes that show the extremes. */
export type LabMode = 'genesis' | 'wild';

export const LAB_COUNT = 24;

export interface Specimen {
  genome: Genome;
  creature: Creature;
  species: string;
  rarity: RarityTier;
  /** Size tier of the fully grown body (DESIGN §3). */
  tier: number;
  /** The shape class of the body plan (M6 T8). */
  silhouette: Silhouette;
  /** Vertices of the full-detail mesh. */
  vertices: number;
  /** Plain-words description, six sentences. */
  lines: string[];
  /** Broken body rules; empty for every valid body. */
  violations: string[];
}

export function specimenOf(genome: Genome): Specimen {
  const creature = buildCreature(genome);
  return {
    genome,
    creature,
    species: speciesName(genome),
    rarity: rarityOfTraits(creature.traits).tier,
    tier: sizeTier(creature.stats.maxBiomass),
    silhouette: silhouetteOf(creature.plan),
    vertices: estimateVertices(creature.plan, 'full'),
    lines: describeCreature(creature),
    violations: bodyViolations(creature.plan),
  };
}

export function labGenomes(seed: string, mode: LabMode, count = LAB_COUNT): Genome[] {
  return Array.from({ length: count }, (_, i) => {
    const at = seedFromString(`${seed}/${mode}/${i}`);
    if (mode === 'genesis') return genesisGenome(at);
    const rng = createRng(at, 'lab-wild');
    return decodeGenome(Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff));
  });
}

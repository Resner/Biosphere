// What the Lab shows (M3 T13): genomes from a page seed, and everything the grid and the inspector
// need to know about each one. Pure, so the same seed always gives the same 24 creatures.

import { decodeGenome, type Genome } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { bodyViolations } from '../genome/develop';
import { genesisGenome } from '../genome/genesis';
import { BASE_BYTES, GENOME_BYTES, HAPLOTYPE_BYTES } from '../genome/karyotype';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { type Silhouette, silhouetteOf } from '../genome/silhouette';
import { buildCreature, type Creature } from '../genome/stats';
import { anatomyOf } from '../render/anatomy';
import { estimateVertices } from '../render/creature-mesh';
import { glintPlanOf } from '../render/surface';
import { createRng, type Seed, seedFromString } from '../sim/prng';
import { sizeTier } from '../sim/size';

/** Genesis cells, or random genome bytes that show the extremes. */
export type LabMode = 'genesis' | 'wild';

export const LAB_COUNT = 24;

/** The chance that a wild cell leaves one v2 byte (a shape locus or a part detail) at 0. */
const WILD_V2_OFF = 0.6;

export interface Specimen {
  genome: Genome;
  creature: Creature;
  species: string;
  rarity: RarityTier;
  /** Size tier of the fully grown body (DESIGN §3). */
  tier: number;
  /** The shape class of the body plan (M6 T8). */
  silhouette: Silhouette;
  /** Vertices of the mesh on the high preset, which the Lab and the gallery draw. */
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
    vertices: estimateVertices(
      creature.plan,
      'high',
      anatomyOf(creature.plan, creature.traits, creature.hash),
      glintPlanOf(creature),
    ),
    lines: describeCreature(creature),
    violations: bodyViolations(creature.plan),
  };
}

/** A wild cell: random bytes with most of the v2 bytes off, from a seed. */
export function wildGenome(at: Seed): Genome {
  const rng = createRng(at, 'lab-wild');
  const bytes = Uint8Array.from({ length: GENOME_BYTES }, () => rng.nextU32() & 0xff);
  // Each v2 byte (body shape and part detail) is off in most cells, or half of them would be radial
  // bells and a third winged: wild cells mix a few new axes into a plain body, the way breeding does.
  const extra = HAPLOTYPE_BYTES - BASE_BYTES;
  for (let i = 0; i < extra; i++) {
    if (rng.next() < WILD_V2_OFF) {
      bytes[BASE_BYTES + i] = 0;
      bytes[HAPLOTYPE_BYTES + BASE_BYTES + i] = 0;
    }
  }
  return decodeGenome(bytes);
}

export function labGenomes(seed: string, mode: LabMode, count = LAB_COUNT): Genome[] {
  return Array.from({ length: count }, (_, i) => {
    const at = seedFromString(`${seed}/${mode}/${i}`);
    return mode === 'genesis' ? genesisGenome(at) : wildGenome(at);
  });
}

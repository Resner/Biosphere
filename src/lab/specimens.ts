// What the Lab shows (M3 T13): genomes from a page seed, and everything the grid and the inspector
// need to know about each one. Pure, so the same seed always gives the same 24 creatures.

import { type Genome, genomeHash } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { bodyViolations } from '../genome/develop';
import { fraction, SEGMENT_LOCI } from '../genome/express';
import { genesisGenome } from '../genome/genesis';
import { breed } from '../genome/inherit';
import { speciesName } from '../genome/names';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { type Silhouette, silhouetteOf } from '../genome/silhouette';
import { buildCreature, type Creature } from '../genome/stats';
import { anatomyOf } from '../render/anatomy';
import { estimateVertices } from '../render/creature-mesh';
import { glintPlanOf } from '../render/surface';
import { createRng, seedFromString } from '../sim/prng';
import { sizeTier } from '../sim/size';
import { LAB_MUTATION } from './breed';

/** Genesis cells, or lineages bred from genesis cells toward an aim (M6c T5). */
export type LabMode = 'genesis' | 'evolved';

export const LAB_COUNT = 24;

/**
 * The Evolved grid (M6c T5): 4 lineages, one per grid row. Each starts from its own 6 genesis cells
 * and is bred for `generations` at the Lab's mutation rate: every generation pairs two different
 * parents at random `brood` times per place and keeps the 6 children that go furthest toward the
 * lineage's aim. A row shows the founder, then the best of every `generations ÷ (size − 1)`
 * generations, left to right.
 */
export const EVOLVED = {
  lineages: 4,
  size: 6,
  generations: 60,
  brood: 3,
} as const;
const EVERY = EVOLVED.generations / (EVOLVED.size - 1);

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

/**
 * The aims a lineage may be bred toward: the loci whose mean a breeder raises, read from the genome
 * as a breeder reads a trait. A grid gives its 4 lineages 4 different ones.
 */
export const AIMS = {
  chain: SEGMENT_LOCI,
  shell: [...SEGMENT_LOCI, 'fusion'],
  curl: [...SEGMENT_LOCI, 'curve'],
  tail: [...SEGMENT_LOCI, 'tailLength'],
  eyes: [...SEGMENT_LOCI, 'eyeSize'],
  ring: ['symmetry', 'drape'],
} as const satisfies Record<string, readonly string[]>;
export type AimName = keyof typeof AIMS;

/** The aims of the grid of `seed`, one per lineage, in row order. */
export function evolvedAims(seed: string): AimName[] {
  const rng = createRng(seedFromString(`${seed}/evolved`), 'aims');
  return (Object.keys(AIMS) as AimName[])
    .map((name) => ({ name, r: rng.next() }))
    .sort((a, b) => a.r - b.r)
    .slice(0, EVOLVED.lineages)
    .map((x) => x.name);
}

/** Whether a body breaks no rule: the cull. */
const sound = (g: Genome): boolean => bodyViolations(buildCreature(g).plan).length === 0;

/**
 * Lineage `k` of the Evolved grid of `seed`, bred toward `aim`: its founder, then one body per
 * snapshot: the best kept child that is sound (no broken rule) and not shown yet.
 */
function evolvedLineage(
  seed: string,
  k: number,
  aim: readonly string[],
  shown: Set<string>,
): Genome[] {
  const at = `${seed}/evolved/${k}`;
  const rng = createRng(seedFromString(at), 'pairs');
  let pool = Array.from({ length: EVOLVED.size }, (_, i) =>
    genesisGenome(seedFromString(`${at}/${i}`)),
  );
  const founder = pool[0] as Genome;
  const row = [founder];
  shown.add(genomeHash(founder));
  for (let gen = 1; gen <= EVOLVED.generations; gen++) {
    const brood = Array.from({ length: EVOLVED.size * EVOLVED.brood }, (_, i) => {
      const a = rng.int(0, EVOLVED.size - 1);
      const b = (a + rng.int(1, EVOLVED.size - 1)) % EVOLVED.size;
      const child = breed(
        pool[a] as Genome,
        pool[b] as Genome,
        seedFromString(`${at}/${gen}/${i}`),
        { mutation: LAB_MUTATION },
      );
      return { child, score: fraction(child, aim) };
    }).sort((x, y) => y.score - x.score);
    pool = brood.slice(0, EVOLVED.size).map((x) => x.child);
    // The snapshot, or the next generation's when no kept child is sound and new. Only shown bodies
    // are culled: no bred body has broken a rule yet (0 of 4,320), and developing one costs more
    // than breeding it.
    if (row.length < 1 + Math.floor(gen / EVERY)) {
      const best = pool.find((g) => !shown.has(genomeHash(g)) && sound(g));
      if (best) {
        shown.add(genomeHash(best));
        row.push(best);
      }
    }
  }
  // Total: a row is always full (never needed so far), padded with the last generation.
  for (let i = 0; row.length < EVOLVED.size; i++) row.push(pool[i] as Genome);
  return row;
}

let lastGrid: { seed: string; grid: Genome[] } | undefined;

/**
 * The Evolved grid of `seed`: its lineages row by row (24 cells). The last one is kept: breeding
 * takes ~0.2 s and the Lab asks for the same grid on every mode toggle.
 */
export function evolvedGrid(seed: string): Genome[] {
  if (lastGrid?.seed === seed) return lastGrid.grid;
  const shown = new Set<string>();
  const grid = evolvedAims(seed).flatMap((name, k) => evolvedLineage(seed, k, AIMS[name], shown));
  lastGrid = { seed, grid };
  return grid;
}

/** The seeds of the Evolved diversity check: the first three run in `check`, all in `report:diversity`. */
export const EVOLVED_SEEDS: readonly string[] = Array.from(
  { length: 10 },
  (_, i) => `evolved-variety-${i}`,
);
/** Silhouette classes an Evolved grid shows in 9 of 10 seeds (M6c T5). */
export const EVOLVED_CLASSES = 5;

/** How many silhouette classes `genomes` show. */
export const silhouetteClasses = (genomes: readonly Genome[]): number =>
  new Set(genomes.map((g) => silhouetteOf(buildCreature(g).plan))).size;

export function labGenomes(seed: string, mode: LabMode): Genome[] {
  if (mode === 'evolved') return evolvedGrid(seed);
  return Array.from({ length: LAB_COUNT }, (_, i) =>
    genesisGenome(seedFromString(`${seed}/genesis/${i}`)),
  );
}

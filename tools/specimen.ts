// The specimen search (M6 T9, ADR 0024): builds a karyotype v2 genome for a target silhouette class
// or rarity tier by a deterministic search from a seed: genesis cells and wild cells in turn, the
// first valid body that matches. The gallery's added specimens come from here and are then stored
// as hex, never re-drawn (`npm run specimens -- --write`). After a world reset they are checked
// against the new rules and only the ones that no longer show their class are searched again
// (`--refresh`, ADR 0043); the evolved cells 07-20 are picks from the Lab's Evolved grids (M6c T5).

import { bytesToHex } from '@noble/hashes/utils.js';
import { encodeGenome, type Genome, genomeHash } from '../src/genome/codec';
import { type Appendage, type BodyPlan, bodyViolations } from '../src/genome/develop';
import { genesisGenome } from '../src/genome/genesis';
import { longest, measure, regionOf, visibleCount } from '../src/genome/organism';
import { type RarityTier, rarityOfTraits } from '../src/genome/rarity';
import { SILHOUETTES, type Silhouette, silhouetteOf } from '../src/genome/silhouette';
import { buildCreature, type Creature } from '../src/genome/stats';
import { type AimName, EVOLVED, evolvedAims, evolvedGrid, specimenOf } from '../src/lab/specimens';
import { seedFromString } from '../src/sim/prng';
import { wildGenome } from '../tests/wild';

/** Every silhouette class a specimen is made for: all but `other`. */
export const SPECIMEN_SILHOUETTES: readonly Silhouette[] = SILHOUETTES.filter((s) => s !== 'other');
export const SPECIMEN_TIERS: readonly RarityTier[] = ['common', 'uncommon', 'rare', 'exotic'];

/** Whether `a`, if it is a visible part on the trunk, is a short leg: at most 0.9 body widths (ADR 0041). */
export const shortLeg = (plan: BodyPlan, a: Appendage): boolean => {
  if (a.fringe) return true;
  const m = measure(plan.segments);
  return regionOf(a, plan, m) !== 'trunk' || a.length <= longest('leg', plan.segments, m) + 1e-9;
};

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

/**
 * The look features look pass 5 adds a specimen for (ADR 0032): bodies the references show that no
 * class or tier specimen happened to: 02's long sweeping antennae, 05's big eyes set into the head,
 * and 03's and 05's spirals, a bilateral coiled chain of 4 or more segments with only short parts
 * round it. Under ADR 0041 every coil is one: its legs are short (at most 0.9 body widths) and few
 * (the coil's gate), and the rest of its parts are fringe, antennae or a tail. M6b T6 adds 02's and 05's S-worms: a worm whose spine bends two opposite arcs of 0.6π
 * or more, with no part longer than a core radius (the class specimen, 28, is bent into a C by its genes).
 */
export const FEATURES = {
  antennae: (c: Creature): boolean =>
    c.plan.form.radial === 0 &&
    c.plan.segments.length >= 3 &&
    c.plan.appendages.filter(
      (a) => a.segment === 0 && a.length >= 1.8 && a.width <= 0.15 && a.dir <= 1.9,
    ).length >= 2,
  'big-eyes': (c: Creature): boolean =>
    c.plan.eyes.count === 2 && c.plan.eyes.size >= 0.25 && c.plan.eyes.stalk <= 0.05,
  spiral: (c: Creature): boolean =>
    c.plan.form.mode === 2 &&
    c.plan.form.radial === 0 &&
    c.plan.segments.length >= 4 &&
    c.plan.appendages.every((a) => shortLeg(c.plan, a)),
  's-worm': (c: Creature): boolean => {
    const angles = c.plan.segments.map((s) => s.angle);
    const peak = Math.max(...angles);
    const arc = 0.6 * Math.PI;
    return (
      c.plan.form.mode === 1 &&
      silhouetteOf(c.plan) === 'worm' &&
      c.plan.appendages.every((a) => a.length <= 1) &&
      peak - (angles[0] as number) >= arc &&
      peak - (angles[angles.length - 1] as number) >= arc
    );
  },
} as const satisfies Record<string, (c: Creature) => boolean>;

export type Feature = keyof typeof FEATURES;

/** The first valid body showing `feature` whose genome hash is not in `taken`, or null. */
export function findFeature(
  feature: Feature,
  seed: string,
  taken: ReadonlySet<string> = new Set(),
): Found | null {
  return search(seed, taken, FEATURES[feature]);
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
  const comment = `${s.species}, ${what} specimen (search seed ${seed}): ${c.plan.segments.length} segments, ${visibleCount(c.plan)} parts shown, ${s.silhouette}, ${s.rarity}.`;
  return { name, text: `# ${comment}\n${bytesToHex(encodeGenome(genome))}\n` };
}

/** What a gallery file `NN-specimen-<what>-<genus>-<epithet>.hex` stands for, or null for another file. */
export function specimenWhat(file: string): string | null {
  return /^\d\d-specimen-([a-z-]+?)-[a-z]+-[a-z]+\.hex$/.exec(file)?.[1] ?? null;
}

/** Whether `genome` still shows `what` (a class, `tier-<tier>` or a look feature) under the live rules. */
export function stillShows(what: string, genome: Genome): boolean {
  const c = buildCreature(genome);
  if (bodyViolations(c.plan).length > 0) return false;
  if (what.startsWith('tier-')) return rarityOfTraits(c.traits).tier === what.slice(5);
  if (what in FEATURES) return FEATURES[what as Feature](c);
  return silhouetteOf(c.plan) === what;
}

/** One pick for the gallery's evolved cells (M6c T5): a lineage's last body in an Evolved grid. */
export interface EvolvedPick {
  genome: Genome;
  /** The grid's Lab seed. */
  set: string;
  /** The lineage, 0-3: the grid row. */
  lineage: number;
  aim: AimName;
}

/**
 * The gallery's evolved picks (M6c T5, ADR 0043): the last body of every lineage (generation
 * `EVOLVED.generations`, the right end of each row) of the Evolved grids `<seed>-0`, `<seed>-1`, …,
 * row by row, skipping genomes in `taken`, until `count`.
 */
export function evolvedPicks(
  seed: string,
  count: number,
  taken: ReadonlySet<string> = new Set(),
): EvolvedPick[] {
  const picks: EvolvedPick[] = [];
  for (let j = 0; picks.length < count; j++) {
    const set = `${seed}-${j}`;
    const grid = evolvedGrid(set);
    const aims = evolvedAims(set);
    for (let lineage = 0; lineage < EVOLVED.lineages && picks.length < count; lineage++) {
      const genome = grid[(lineage + 1) * EVOLVED.size - 1] as Genome;
      if (taken.has(genomeHash(genome))) continue;
      picks.push({ genome, set, lineage, aim: aims[lineage] as AimName });
    }
  }
  return picks;
}

/** A gallery file for an evolved pick: `NN-evolved-<genus>-<epithet>.hex`, a comment, then hex. */
export function evolvedFile(index: number, pick: EvolvedPick): { name: string; text: string } {
  const s = specimenOf(pick.genome);
  const plan = s.creature.plan;
  const name = `${String(index).padStart(2, '0')}-evolved-${s.species.toLowerCase().replace(' ', '-')}.hex`;
  const comment = `${s.species}, lineage ${pick.lineage + 1} (aim ${pick.aim}) of the Lab's Evolved set ${pick.set}, generation ${EVOLVED.generations}: ${plan.segments.length} segments, ${visibleCount(plan)} parts shown, ${s.silhouette}, ${s.rarity}.`;
  return { name, text: `# ${comment}\n${bytesToHex(encodeGenome(pick.genome))}\n` };
}

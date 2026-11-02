// What the Lab shows (M3 T13): genomes from a page seed, and everything the grid and the inspector
// need to know about each one. Pure, so the same seed always gives the same 24 creatures.

import { type Genome, genomeHash } from '../genome/codec';
import { describeCreature } from '../genome/describe';
import { bodyViolations } from '../genome/develop';
import { genesisGenome } from '../genome/genesis';
import { express, fraction, SEGMENT_LOCI, type Traits } from '../genome/express';
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

/** Genesis cells, or the last generation of bred lineages: what selection reaches (M6c T5). */
export type LabMode = 'genesis' | 'evolved';

export const LAB_COUNT = 24;

/**
 * The Evolved grid (M6c T5): 4 lineages of 6, each bred from its own 6 genesis cells over 15
 * generations of random pairings at the Lab's mutation rate. One lineage fills one grid row.
 */
export const EVOLVED = { lineages: 4, size: 6, generations: 15, mutation: LAB_MUTATION } as const;
const seg = (g: Genome): number => fraction(g, SEGMENT_LOCI);
const most = (t: Traits, f: (m: Traits['modules'][number]) => number): number =>
  t.modules.reduce((m, x) => (x.present ? Math.max(m, f(x)) : m), 0);
type Aim = (g: Genome, t: Traits) => number;
const AIMS: readonly Aim[] = [
  (g) => seg(g),
  (g, t) => seg(g) + t.shape.fusion,
  (g, t) => seg(g) + t.shape.curve,
  (g, t) => seg(g) + most(t, (m) => m.params.pairs / 255),
  (g, t) => seg(g) + t.shape.tailLength,
  (g, t) => seg(g) + most(t, (m) => m.ext.webbing),
  (g, t) => t.shape.symmetry + most(t, (m) => m.params.length / 255),
];
const GENS = Number(process.env.GENS ?? 15);
const BROOD = Number(process.env.BROOD ?? 2);
const LASTB = Number(process.env.LASTB ?? 4);
export const STAT = { bad: 0, all: 0 };

function aimOf(seed: string, k: number): Aim {
  const rng = createRng(seedFromString(`${seed}/evolved`), 'aims');
  const order = AIMS.map((a, i) => ({ a, r: rng.next() + i * 0 })).sort((x, y) => x.r - y.r);
  return (order[k] as { a: Aim }).a;
}

function evolvedLineage(seed: string, k: number, shown: Set<string>): Genome[] {
  const at = `${seed}/evolved/${k}`;
  const rng = createRng(seedFromString(at), 'pairs');
  const aim = aimOf(seed, k);
  let pool = Array.from({ length: EVOLVED.size }, (_, i) =>
    genesisGenome(seedFromString(`${at}/${i}`)),
  );
  const child = (gen: number, i: number): Genome => {
    const a = rng.int(0, EVOLVED.size - 1);
    const b = (a + rng.int(1, EVOLVED.size - 1)) % EVOLVED.size;
    return breed(pool[a] as Genome, pool[b] as Genome, seedFromString(`${at}/${gen}/${i}`), {
      mutation: EVOLVED.mutation,
    });
  };
  for (let gen = 1; gen < GENS; gen++) {
    const brood = Array.from({ length: EVOLVED.size * BROOD }, (_, i) => {
      const g = child(gen, i);
      return { g, score: aim(g, express(g)) };
    }).sort((x, y) => y.score - x.score);
    if (process.env.CULL) {
      const kept = [];
      for (const b of brood) { if (kept.length === EVOLVED.size) break; STAT.all++; if (bodyViolations(buildCreature(b.g).plan).length > 0) { STAT.bad++; continue; } kept.push(b.g); }
      pool = kept;
    } else
    pool = brood.slice(0, EVOLVED.size).map((x) => x.g);
  }
  // The last generation: a bigger brood, culled, and shown one of each class first.
  const last = Array.from({ length: EVOLVED.size * LASTB }, (_, i) => {
    const g = child(GENS, i);
    return { g, score: aim(g, express(g)) };
  }).sort((x, y) => y.score - x.score);
  const picked: Genome[] = [];
  const classes = new Set<string>();
  const rest: Genome[] = [];
  for (const { g } of last) {
    const hash = genomeHash(g);
    if (shown.has(hash)) continue;
    const plan = buildCreature(g).plan;
    STAT.all++;
    if (bodyViolations(plan).length > 0) { STAT.bad++; continue; }
    shown.add(hash);
    const c = silhouetteOf(plan);
    if (picked.length < EVOLVED.size && !classes.has(c)) {
      classes.add(c);
      picked.push(g);
    } else rest.push(g);
  }
  return [...picked, ...rest].slice(0, EVOLVED.size);
}

/** The Evolved grid of `seed`: each lineage's last generation, lineage by lineage (24 cells). */
export function evolvedGrid(seed: string): Genome[] {
  const shown = new Set<string>();
  return Array.from({ length: EVOLVED.lineages }, (_, k) => evolvedLineage(seed, k, shown)).flat();
}

export function labGenomes(seed: string, mode: LabMode): Genome[] {
  if (mode === 'evolved') return evolvedGrid(seed);
  return Array.from({ length: LAB_COUNT }, (_, i) =>
    genesisGenome(seedFromString(`${seed}/genesis/${i}`)),
  );
}

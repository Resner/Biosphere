import { type Genome, genomeFromBase64url, genomeHash } from '../genome/codec';
import { type Beacon, roundTime } from './drand';
import { type Commitment, checkGenesis } from './genesis';
import { checkBirth } from './mating';
import { recordProblems, rulesOf, type StoredRecord } from './record';
import type { BundleIndex, LineageReport, Problem, VerifyOptions } from './verify';
import { creatureOf, firstNamers, whereNamed } from './verify-chain';

// The origin family of `verifyLineage` (ADR 0055): each held creature's genesis or birth recomputed
// from its committed drand round and both parents (`checkGenesis`, `checkBirth`), each genome text
// against the genome its first record names, the commitments' timing, and the lineage graph. A
// birth whose parent the bundle leaves out (`more`) is unchecked, which is not a problem.

const problem = (creature: string, seq: number | null, code: string): Problem => ({
  creature,
  seq,
  family: 'origin',
  code,
});

/**
 * The genesis or birth a held creature starts from, when the chain family can read it: a first
 * record of a live rules version and a valid shape. Otherwise the chain family has named it already.
 */
function originOf(index: BundleIndex, id: string): StoredRecord | null {
  const first = index.records.get(id)?.[0];
  if (first?.record.seq !== 0) return null;
  if (first.record.kind !== 'genesis' && first.record.kind !== 'birth') return null;
  return rulesOf(first.record) === null && recordProblems(first.record).length === 0 ? first : null;
}

/** Whether `id`'s birth names a parent the bundle does not hold, so it cannot be recomputed. */
const unheldParent = (index: BundleIndex, id: string): boolean =>
  index.parents.get(id)?.some((p) => !index.creatures.has(p)) ?? false;

export function verifyOrigin(index: BundleIndex, _opts: VerifyOptions): Problem[] {
  const out: Problem[] = [];
  // Each held creature's genome, when its text hashes to the genome its first record names.
  const genomes = new Map<string, Genome | null>();
  const genomeOf = (id: string): Genome | null => {
    if (!genomes.has(id)) {
      const text = index.creatures.get(id);
      const named = originOf(index, id)?.record.body.genome;
      const genome = text === undefined ? null : genomeFromBase64url(text);
      genomes.set(id, genome && genomeHash(genome) === named ? genome : null);
    }
    return genomes.get(id) ?? null;
  };
  for (const id of index.creatures.keys()) {
    const first = originOf(index, id);
    if (!first) continue;
    const at = (code: string) => out.push(problem(id, 0, code));
    if (!genomeOf(id)) at('genome-text');
    const signed = index.commits.get(first.record.body.commit as string);
    const beacon = signed && index.beacons.get(signed.commitment.round);
    if (!signed) at('commit-missing');
    else if (!beacon) at('beacon-missing');
    else {
      const codes =
        first.record.kind === 'genesis'
          ? checkGenesis(first.record, signed.commitment, beacon)
          : birthProblems(index, id, first, signed.commitment, beacon, genomeOf);
      for (const code of codes) at(code.startsWith('invalid-record:') ? 'origin-unreadable' : code);
    }
  }
  out.push(...timing(index));
  return out;
}

/**
 * Why `first`, a birth, is not the child its commitment, beacon and parents produce. The parents'
 * genomes come from their texts, and the `mate-commit` records it names must lie in the parents'
 * held prefixes. A birth with a parent left out (`more`) is not checked.
 */
function birthProblems(
  index: BundleIndex,
  id: string,
  first: StoredRecord,
  commit: Commitment,
  beacon: Beacon,
  genomeOf: (id: string) => Genome | null,
): string[] {
  const parents = index.parents.get(id);
  if (!parents) return ['origin-unreadable'];
  if (unheldParent(index, id)) {
    return parents.some((p) => !index.creatures.has(p) && !index.bundle.more.includes(p))
      ? ['parent-missing']
      : [];
  }
  const held = parents.flatMap((p) => index.records.get(p) ?? []);
  const mates = (first.record.body.mates as string[]).map((h) => held.find((s) => s.hash === h));
  if (mates.some((m) => !m)) return ['mate-not-held'];
  const pair = mates as [StoredRecord, StoredRecord];
  // Each parent's genome is that of the creature whose `mate-commit` it is, in the birth's order.
  const genomes = pair.map((m) => genomeOf(creatureOf(m)));
  if (genomes.some((g) => !g)) return ['parent-genome'];
  const generations = pair.some(
    (m) => m.record.body.generation !== originOf(index, creatureOf(m))?.record.body.generation,
  );
  return [
    ...(generations ? ['mate-generation'] : []),
    ...checkBirth(first.record, commit, beacon, genomes as [Genome, Genome], pair),
  ];
}

/** Every commitment named a round not yet published at its `t` (`latest + 2`, ADR 0010). */
function timing(index: BundleIndex): Problem[] {
  const named = firstNamers(index).commit;
  const out: Problem[] = [];
  for (const [id, { commitment }] of index.commits) {
    if (roundTime(commitment.round) > commitment.t) continue;
    const [creature, seq] = whereNamed(index, named.get(id));
    out.push(problem(creature, seq, 'round-not-future'));
  }
  return out;
}

/**
 * How far back the checked graph reaches from the subject. `toGenesis`: every ancestor path ends at
 * a held genesis, through births whose parents are all held. `generations`: the longest such path.
 * `unchecked`: held creatures whose birth names a parent the bundle does not hold.
 */
export function reachOf(
  index: BundleIndex,
): Pick<LineageReport, 'toGenesis' | 'generations' | 'unchecked'> {
  const unchecked = [...index.creatures.keys()].filter(
    (id) => originOf(index, id)?.record.kind === 'birth' && unheldParent(index, id),
  );
  const reach = new Map<string, { toGenesis: boolean; generations: number }>();
  const walk = (id: string): { toGenesis: boolean; generations: number } => {
    const known = reach.get(id);
    if (known) return known;
    reach.set(id, { toGenesis: false, generations: 0 }); // a cycle reaches no genesis
    const first = index.creatures.has(id) ? originOf(index, id) : null;
    const parents = index.parents.get(id);
    let result = { toGenesis: first?.record.kind === 'genesis', generations: 0 };
    if (first?.record.kind === 'birth' && parents && !unheldParent(index, id)) {
      const [a, b] = parents.map(walk) as [typeof result, typeof result];
      result = {
        toGenesis: a.toGenesis && b.toGenesis,
        generations: 1 + Math.max(a.generations, b.generations),
      };
    }
    reach.set(id, result);
    return result;
  };
  return { ...walk(index.bundle.subject), unchecked };
}

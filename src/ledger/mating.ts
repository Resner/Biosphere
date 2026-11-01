import { type Genome, genomeHash } from '../genome/codec';
import { KARYOTYPE_VERSION } from '../genome/karyotype';
import { offspringPair } from '../genome/offspring';
import { type Canonical, canonicalize } from './canonical';
import { type Beacon, randomnessOf } from './drand';
import { beaconProblems, type Commitment, commitmentId } from './genesis';
import { checkMatePair, type MateAsk } from './mate-ask';
import {
  type LedgerRecord,
  type RecordRequest,
  recordHash,
  recordProblems,
  retired,
  type StoredRecord,
} from './record';

export { checkMatePair, type MateAsk, signedBy, signMateAsk } from './mate-ask';

// Birth checks for a mating (ADR 0021). The asks live in `mate-ask.ts`. Pure and shared: no DOM, no Node APIs.

/**
 * The `birth` request for one child of a mating. `mates` are the hashes of the two `mate-commit`
 * records (A's, then B's), `parents` the two creature ids, `slot` the slot byte the child used, and
 * `owner` the player who gets this child.
 */
export function birthRequest(
  rules: number,
  commit: Commitment,
  mates: [string, string],
  slot: number,
  parents: [string, string],
  child: Genome,
  generation: number,
  owner: string,
): RecordRequest {
  return {
    v: 1,
    rules,
    kind: 'birth',
    creature: '',
    seq: 0,
    prev: '',
    owner,
    body: {
      commit: commitmentId(commit),
      round: commit.round,
      slot,
      parents,
      mates,
      genome: genomeHash(child),
      generation,
      karyotype: KARYOTYPE_VERSION,
    },
  };
}

/** What one `mate-commit` must say, given the commitment and the parents' genomes. */
interface MateExpect {
  role: 'a' | 'b';
  owner: string;
  partnerOwner: string;
  creature: string;
  partnerCreature: string;
  genome: string;
  partnerGenome: string;
}

function mateProblems(
  mate: StoredRecord,
  commitId: string,
  round: number,
  want: MateExpect,
): string[] {
  const r = mate.record;
  if (recordProblems(r).length > 0) return ['mate-commit-mismatch'];
  const failures: string[] = [];
  if (mate.hash !== recordHash(r)) failures.push('mate-hash');
  const b = r.body;
  if (
    r.kind !== 'mate-commit' ||
    r.owner !== want.owner ||
    r.creature !== want.creature ||
    b.commit !== commitId ||
    b.round !== round ||
    b.role !== want.role ||
    b.partner !== want.partnerOwner ||
    b.partnerCreature !== want.partnerCreature
  ) {
    failures.push('mate-commit-mismatch');
  }
  if (b.genome !== want.genome || b.partnerGenome !== want.partnerGenome) {
    failures.push('parent-genome-mismatch');
  }
  return failures;
}

/**
 * Why `record` is not the child that `commit`, `beacon` and the two parents produce; empty when it
 * is. The child is recomputed from the committed round and never trusted from the record. The
 * `mates` hashes are checked against the records' contents; their signatures are `checkStored`'s.
 * Never throws.
 */
export function checkBirth(
  record: LedgerRecord,
  commit: Commitment,
  beacon: Beacon,
  parents: [Genome, Genome],
  mates: [StoredRecord, StoredRecord],
): string[] {
  try {
    const shape = recordProblems(record);
    if (shape.length > 0) return shape.map((p) => `invalid-record:${p}`);
    if (retired(record)) return ['rules-retired'];
    if (record.kind !== 'birth') return ['not-birth'];
    if (commit.kind !== 'mate') return ['not-mate'];
    const data = commit.data as { a?: unknown; b?: unknown } | null;
    if (typeof data?.a !== 'object' || data.a === null || typeof data.b !== 'object') {
      return ['bad-commit'];
    }
    const { a: askA, b: askB } = data as { a: MateAsk; b: MateAsk };
    const ownerA = commit.owner;
    const ownerB = askA.partner;
    const failures = checkMatePair(askA, ownerA, askB, ownerB).map((f) => `pair:${f}`);
    if (failures.length > 0) return failures;
    const id = commitmentId(commit);
    const body = record.body;
    const child = record.owner === ownerA ? 0 : record.owner === ownerB ? 1 : null;
    if (child === null) failures.push('owner-mismatch');
    if (body.commit !== id) failures.push('commit-mismatch');
    if (body.round !== commit.round) failures.push('round-mismatch');
    if (mates.some((m) => m.record.rules !== record.rules)) failures.push('rules-mismatch');
    failures.push(...beaconProblems(commit, beacon));
    if (canonicalize(body.parents as Canonical) !== canonicalize([askA.creature, askB.creature])) {
      failures.push('parent-mismatch');
    }
    const [hashA, hashB] = [genomeHash(parents[0]), genomeHash(parents[1])];
    failures.push(
      ...mateProblems(mates[0], id, commit.round, {
        role: 'a',
        owner: ownerA,
        partnerOwner: ownerB,
        creature: askA.creature,
        partnerCreature: askB.creature,
        genome: hashA,
        partnerGenome: hashB,
      }),
      ...mateProblems(mates[1], id, commit.round, {
        role: 'b',
        owner: ownerB,
        partnerOwner: ownerA,
        creature: askB.creature,
        partnerCreature: askA.creature,
        genome: hashB,
        partnerGenome: hashA,
      }),
    );
    if (canonicalize(body.mates as Canonical) !== canonicalize([mates[0].hash, mates[1].hash])) {
      failures.push('mate-hash');
    }
    if (child === null || failures.length > 0) return [...new Set(failures)];
    const { children, slots } = offspringPair(randomnessOf(beacon), id, parents[0], parents[1]);
    const generation =
      Math.max(
        mates[0].record.body.generation as number,
        mates[1].record.body.generation as number,
      ) + 1;
    if (body.slot !== slots[child]) failures.push('slot-mismatch');
    if (body.genome !== genomeHash(children[child])) failures.push('genome-mismatch');
    if (body.generation !== generation) failures.push('generation-mismatch');
    if (body.karyotype !== KARYOTYPE_VERSION) failures.push('karyotype-mismatch');
    return failures;
  } catch {
    return ['invalid-record:unreadable'];
  }
}

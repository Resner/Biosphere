import { type Genome, genomeHash } from '../genome/codec';
import { KARYOTYPE_VERSION } from '../genome/karyotype';
import { offspringPair } from '../genome/offspring';
import { type Canonical, canonicalize } from './canonical';
import { type Beacon, randomnessOf } from './drand';
import { beaconProblems, type Commitment, commitmentId } from './genesis';
import { fromBase64Url, type Identity, isPlayerId, toBase64Url, verify } from './identity';
import {
  HEX64,
  type LedgerRecord,
  REQUEST_DOMAIN,
  type RecordRequest,
  recordHash,
  recordProblems,
  type StoredRecord,
} from './record';

// Mate asks (ADR 0021): one transaction touches two players' creatures, so each player signs an
// ask, as with genesis, instead of both signing one record. Pure and shared: no DOM, no Node APIs.

const NONCE_RE = /^[A-Za-z0-9_-]{22}$/;
const SIG_RE = /^[A-Za-z0-9_-]{86}$/;
const FIELDS = ['v', 'kind', 'creature', 'partner', 'partnerCreature', 'nonce', 'sig'];

/** A player's signed consent to mate: `creature` with `partner`'s `partnerCreature`. */
export interface MateAsk {
  v: 1;
  kind: 'mate';
  creature: string;
  partner: string;
  partnerCreature: string;
  nonce: string;
  sig: string;
}

function askMessage(a: Omit<MateAsk, 'sig'>): Uint8Array {
  return new TextEncoder().encode(canonicalize(a as unknown as Canonical));
}

export function signMateAsk(identity: Identity, a: Omit<MateAsk, 'v' | 'kind' | 'sig'>): MateAsk {
  const { creature, partner, partnerCreature, nonce } = a;
  const ask = { v: 1 as const, kind: 'mate' as const, creature, partner, partnerCreature, nonce };
  return { ...ask, sig: toBase64Url(identity.sign(REQUEST_DOMAIN, askMessage(ask))) };
}

function isAsk(x: unknown): x is MateAsk {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return false;
  const a = x as Record<string, unknown>;
  const str = (k: string, ok: (s: string) => boolean) =>
    typeof a[k] === 'string' && ok(a[k] as string);
  return (
    Object.keys(a).every((k) => FIELDS.includes(k)) &&
    a.v === 1 &&
    a.kind === 'mate' &&
    str('creature', (s) => HEX64.test(s)) &&
    str('partnerCreature', (s) => HEX64.test(s)) &&
    str('partner', isPlayerId) &&
    str('nonce', (s) => NONCE_RE.test(s)) &&
    str('sig', (s) => SIG_RE.test(s))
  );
}

function signedBy(owner: string, a: MateAsk): boolean {
  const { sig, ...rest } = a;
  const bytes = fromBase64Url(sig);
  return bytes !== null && verify(owner, REQUEST_DOMAIN, askMessage(rest), bytes);
}

/** Named failures; empty when each ask names the other and both are signed by their owners. Never throws. */
export function checkMatePair(a: MateAsk, aOwner: string, b: MateAsk, bOwner: string): string[] {
  try {
    if (!isAsk(a) || !isAsk(b)) return ['bad-ask'];
    const failures: string[] = [];
    if (aOwner === bOwner) failures.push('self');
    else if (
      a.partner !== bOwner ||
      b.partner !== aOwner ||
      a.partnerCreature !== b.creature ||
      b.partnerCreature !== a.creature ||
      a.nonce !== b.nonce
    ) {
      failures.push('pair-mismatch');
    }
    if (!signedBy(aOwner, a) || !signedBy(bOwner, b)) failures.push('bad-signature');
    return failures;
  } catch {
    return ['bad-ask'];
  }
}

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
    if (record.kind !== 'birth') return ['not-birth'];
    if (commit.kind !== 'mate') return ['not-mate'];
    const { a: askA, b: askB } = commit.data as unknown as { a: MateAsk; b: MateAsk };
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

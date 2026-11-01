import { type Genome, genomeHash, genomeToBase64url } from '../genome/codec';
import { genesisGenome } from '../genome/genesis';
import { deriveSeed } from '../genome/inherit';
import { KARYOTYPE_VERSION } from '../genome/karyotype';
import type { Seed } from '../sim/prng';
import { type GenesisAsk, verifyGenesisAsk } from './ask';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';
import { type Beacon, randomnessOf, verifyBeacon } from './drand';
import { type LedgerRecord, type RecordRequest, recordProblems, retired } from './record';

// Genesis (ADR 0010, 0019): a creature's first DNA comes from a drand round that did not exist
// when the player asked for it. Everything here is pure, so the client and (from M9) the verifier
// recompute what the authority claims.

const COMMIT_DOMAIN = 'bs/commit/v1';
const GENESIS_DOMAIN = 'bs/genesis/v1';

/** A commitment to a future drand round. `data` is the committed request. */
export interface Commitment {
  v: 1;
  kind: string;
  owner: string;
  round: number;
  /** Hash of the request, so a repeated request finds this commitment. */
  req: string;
  t: number;
  data: Canonical;
}

export function commitmentId(c: Commitment): string {
  return hashWithDomain(COMMIT_DOMAIN, canonicalize(c as unknown as Canonical));
}

/** SHA-256 of the domain, the randomness, the commit id and a zero byte, as four words. */
export function genesisSeed(randomness: Uint8Array, commitId: string): Seed {
  return deriveSeed(GENESIS_DOMAIN, randomness, commitId, 0);
}

/** The genesis DNA of a commitment, under the live rules version (ADR 0040). */
export function genesisFor(randomness: Uint8Array, commitId: string): Genome {
  return genesisGenome(genesisSeed(randomness, commitId));
}

/** The record request that turns a commitment and its beacon into a creature. */
export function genesisRequest(rules: number, commit: Commitment, genome: Genome): RecordRequest {
  return {
    v: 1,
    rules,
    kind: 'genesis',
    creature: '',
    seq: 0,
    prev: '',
    owner: commit.owner,
    body: {
      commit: commitmentId(commit),
      round: commit.round,
      genome: genomeHash(genome),
      generation: 0,
      karyotype: KARYOTYPE_VERSION,
    },
  };
}

/** Why `beacon` cannot decide `commit`: another round, or a signature that does not verify. */
export function beaconProblems(commit: Commitment, beacon: Beacon): string[] {
  if (beacon.round !== commit.round) return ['beacon-round'];
  return verifyBeacon(beacon) ? [] : ['bad-beacon'];
}

/** Why `record` is not the genesis that `commit` and `beacon` produce; empty when it is. Never throws. */
export function checkGenesis(
  record: LedgerRecord,
  commit: Commitment,
  beacon: Beacon,
  genomeText?: string,
): string[] {
  try {
    const shape = recordProblems(record);
    if (shape.length > 0) return shape.map((p) => `invalid-record:${p}`);
    if (retired(record)) return ['rules-retired'];
    const failures: string[] = [];
    const id = commitmentId(commit);
    const ask = commit.data as Partial<GenesisAsk> | null;
    if (commit.kind !== 'genesis' || record.kind !== 'genesis') failures.push('not-genesis');
    if (record.owner !== commit.owner) failures.push('owner-mismatch');
    if (
      typeof ask?.nonce !== 'string' ||
      typeof ask?.sig !== 'string' ||
      !verifyGenesisAsk(commit.owner, { nonce: ask.nonce, sig: ask.sig })
    ) {
      failures.push('bad-ask');
    }
    if (record.body.commit !== id) failures.push('commit-mismatch');
    if (record.body.round !== commit.round) failures.push('round-mismatch');
    failures.push(...beaconProblems(commit, beacon));
    if (failures.length > 0) return failures;
    const genome = genesisFor(randomnessOf(beacon), id);
    const expected = genesisRequest(record.rules, commit, genome);
    if (canonicalize(expected.body) !== canonicalize(record.body)) failures.push('body-mismatch');
    if (genomeText !== undefined && genomeText !== genomeToBase64url(genome)) {
      failures.push('genome-mismatch');
    }
    return failures;
  } catch {
    return ['invalid-record:unreadable'];
  }
}

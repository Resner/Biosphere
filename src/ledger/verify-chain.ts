import { hexToBytes } from '@noble/hashes/utils.js';
import { fromBase64Url, verify } from './identity';
import { type KeyVerify, keyVerifier } from './key-verify';
import type { AuthorityKey } from './proof';
import {
  AUTH_DOMAIN,
  HEX64,
  REQUEST_DOMAIN,
  recordHash,
  recordProblems,
  requestMessage,
  rulesOf,
  type Status,
  type StoredRecord,
  transitionOutcome,
} from './record';
import { settlementHash } from './settlement';
import type { BundleIndex, Family, Problem, VerifyOptions } from './verify';

// The chain and signature families of `verifyLineage` (ADR 0055). Chains: each record's hash, the
// sequence from 0 with no gap or fork, the links, the creature's id, one owner, and the ADR 0021
// status matrix. Signatures: the owner's where only the owner may start a step and nowhere else,
// and the authority's countersignature on every record, commitment and settlement under a key in
// force by then.

const problem = (family: Family, creature: string, seq: number | null, code: string): Problem => ({
  creature,
  seq,
  family,
  code,
});

/** The creature a record belongs to: its chain's, or for a first record, its own hash. */
export const creatureOf = (s: StoredRecord): string =>
  s.record.creature === '' ? s.hash : s.record.creature;

/** The promote role or death cause the status matrix reads for a record. */
const roleOf = (s: StoredRecord): string | null => {
  const { kind, body } = s.record;
  const role = kind === 'promote' ? body.role : kind === 'death' ? body.cause : null;
  return typeof role === 'string' ? role : null;
};

/** The chain family over every held creature, and the records that belong to none. */
export function verifyChain(index: BundleIndex, _opts: VerifyOptions): Problem[] {
  const out: Problem[] = [];
  const subject = index.bundle.subject;
  if (index.bundle.creatures[0]?.id !== subject)
    out.push(problem('chain', subject, null, 'subject'));
  for (const s of index.stray) out.push(problem('chain', creatureOf(s), s.record.seq, 'stray'));
  for (const id of index.creatures.keys()) out.push(...chainOf(id, index.records.get(id) ?? []));
  return out;
}

/** One creature's chain, its records sorted by `seq`. */
function chainOf(id: string, chain: readonly StoredRecord[]): Problem[] {
  const out: Problem[] = [];
  const at = (seq: number | null, code: string) => out.push(problem('chain', id, seq, code));
  if (chain.length === 0) {
    at(null, 'no-records');
    return out;
  }
  for (const s of chain) {
    const seq = s.record.seq;
    const rules = rulesOf(s.record);
    if (rules) at(seq, rules);
    if (recordProblems(s.record).length > 0) at(seq, 'shape');
    else if (s.hash !== recordHash(s.record)) at(seq, 'hash');
  }
  // A first record is filed under its own hash, so a chain without one names an id that no first record hashes to.
  if (chain[0]?.record.seq !== 0) at(0, 'creature-id');
  const owner = chain[0]?.record.owner;
  // The status is known from the first record on, until a record is missing.
  let known = chain[0]?.record.seq === 0;
  let status: Status | null = null;
  let last: StoredRecord | null = null;
  for (const s of chain) {
    const { record } = s;
    if (last && record.seq === last.record.seq) {
      at(record.seq, 'fork');
      continue;
    }
    if (last && record.seq !== last.record.seq + 1) {
      at(last.record.seq + 1, 'seq-gap');
      known = false;
    } else if (last && record.prev !== last.hash) {
      at(record.seq, 'prev');
    }
    if (record.owner !== owner) at(record.seq, 'owner');
    if (known) {
      const outcome = transitionOutcome(record.kind, roleOf(s), status);
      if (outcome.ok) status = outcome.next;
      else at(record.seq, outcome.reason);
    }
    last = s;
  }
  return out;
}

/** Whether `sig` is the countersignature over `hash` (hex) under `key`, through its tabled verifier. Never throws. */
function countersigned(
  verifiers: Map<string, KeyVerify | null>,
  key: AuthorityKey,
  hash: string,
  sig: string,
): boolean {
  if (!verifiers.has(key.id)) verifiers.set(key.id, keyVerifier(key.publicKey));
  const check = verifiers.get(key.id);
  const bytes = typeof sig === 'string' ? fromBase64Url(sig) : null;
  return (
    !!check &&
    bytes !== null &&
    typeof hash === 'string' &&
    HEX64.test(hash) &&
    check(AUTH_DOMAIN, hexToBytes(hash), bytes)
  );
}

/** Steps only the owner starts, so only these carry the owner's signature (ADR 0021). */
const ownerStarted = (s: StoredRecord): boolean =>
  s.record.kind === 'restore' || (s.record.kind === 'promote' && s.record.body.role === 'child');

/** The signature family: owners' signatures, and the countersignatures with the key history. */
export function verifySignatures(index: BundleIndex, _opts: VerifyOptions): Problem[] {
  const out: Problem[] = [];
  const verifiers = new Map<string, KeyVerify | null>();
  const held: StoredRecord[] = [];
  for (const [id, chain] of index.records) {
    for (const s of chain) {
      held.push(s);
      const at = (code: string) => out.push(problem('signature', id, s.record.seq, code));
      if (ownerStarted(s)) {
        if (s.ownerSig === null) at('owner-sig-missing');
        else if (!ownerSigned(s)) at('owner-sig');
      } else if (s.ownerSig !== null) {
        at('owner-sig-refused');
      }
      const code = keyProblem(index, s.keyId, s.record.t, '');
      if (code) at(code);
      else if (
        !countersigned(verifiers, index.keys.get(s.keyId) as AuthorityKey, s.hash, s.authSig)
      )
        at('auth-sig');
    }
  }
  // A document is named by the records that cite it; its problems go on the earliest of them.
  const naming = { commit: new Map<string, StoredRecord>(), enc: new Map<string, StoredRecord>() };
  for (const s of held) {
    for (const field of ['commit', 'enc'] as const) {
      const value = s.record.body[field];
      const first = typeof value === 'string' ? naming[field].get(value) : undefined;
      if (typeof value === 'string' && (!first || s.record.t < first.record.t))
        naming[field].set(value, s);
    }
  }
  const where = (s: StoredRecord | undefined): [string, number | null] =>
    s ? [creatureOf(s), s.record.seq] : [index.bundle.subject, null];
  for (const [id, c] of index.commits) {
    const first = naming.commit.get(id);
    const [creature, seq] = where(first);
    const code =
      keyProblem(index, c.keyId, first?.record.t ?? c.commitment.t, 'commit-') ??
      (countersigned(verifiers, index.keys.get(c.keyId) as AuthorityKey, id, c.authSig)
        ? null
        : 'commit-sig');
    if (code) out.push(problem('signature', creature, seq, code));
  }
  for (const [enc, s] of index.settlements) {
    const [creature, seq] = where(naming.enc.get(enc));
    const code =
      keyProblem(index, s.keyId, s.settlement.t, 'settlement-') ??
      (s.hash === settlementHash(s.settlement) &&
      countersigned(verifiers, index.keys.get(s.keyId) as AuthorityKey, s.hash, s.authSig)
        ? null
        : 'settlement-sig');
    if (code) out.push(problem('signature', creature, seq, code));
  }
  return out;
}

function ownerSigned(s: StoredRecord): boolean {
  try {
    const sig = typeof s.ownerSig === 'string' ? fromBase64Url(s.ownerSig) : null;
    return sig !== null && verify(s.record.owner, REQUEST_DOMAIN, requestMessage(s.record), sig);
  } catch {
    return false; // A record that cannot be checked fails its own signature, not the whole bundle.
  }
}

/**
 * `key-unknown` for a key id not in force, `key-not-yet` for a key whose `from` is after `t` (null:
 * no time to check against), each behind `prefix`; null when the key may sign it.
 */
function keyProblem(
  index: BundleIndex,
  keyId: string,
  t: number | null,
  prefix: string,
): string | null {
  const key = index.keys.get(keyId);
  if (!key) return `${prefix}key-unknown`;
  return t !== null && key.from > t ? `${prefix}key-not-yet` : null;
}

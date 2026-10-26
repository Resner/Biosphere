import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';
import {
  fromBase64Url,
  playerIdOf,
  publicKeyFromSecret,
  signWithSecret,
  toBase64Url,
  verify,
} from './identity';

// Ledger records (ADR 0009, 0019): canonical JSON of integers and strings, hashed with a domain
// tag, countersigned by the authority. Pure functions shared by clients, the Worker and (from M9)
// the verifier.

export const RECORD_DOMAIN = 'bs/rec/v1';
export const REQUEST_DOMAIN = 'bs/req/v1';
export const AUTH_DOMAIN = 'bs/auth/v1';

export type RecordKind = 'genesis' | 'checkpoint' | 'death';
const KINDS: readonly string[] = ['genesis', 'checkpoint', 'death'];

export interface LedgerRecord {
  v: 1;
  rules: number;
  kind: RecordKind;
  creature: string;
  seq: number;
  prev: string;
  owner: string;
  t: number;
  body: { [key: string]: Canonical };
}

export interface StoredRecord {
  record: LedgerRecord;
  hash: string;
  ownerSig: string | null;
  authSig: string;
  keyId: string;
}

/** An authority key as `/v1/pubkeys` lists it: `publicKey` is base64url. */
export interface PubKey {
  id: string;
  publicKey: string;
}

const HEX64 = /^[0-9a-f]{64}$/;
const PLAYER_ID = /^[A-Za-z0-9_-]{43}$/;

/** The one way to put a float in a record body. */
export function hundredths(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`not finite: ${x}`);
  return Math.round(x * 100) || 0;
}

export function recordHash(r: LedgerRecord): string {
  return hashWithDomain(RECORD_DOMAIN, canonicalize(r as unknown as Canonical));
}

/** A record, or the request that becomes one (`t` is the authority's and is ignored). */
export type RecordRequest = Omit<LedgerRecord, 't'> & { t?: number };

function withoutTime(r: RecordRequest): Canonical {
  const { t: _t, ...rest } = r;
  return rest as unknown as Canonical;
}

/** What an owner signs to start a transition: the record without the authority's `t`. */
export function requestMessage(r: RecordRequest): Uint8Array {
  return new TextEncoder().encode(canonicalize(withoutTime(r)));
}

export function requestHash(r: RecordRequest): string {
  return hashWithDomain(REQUEST_DOMAIN, canonicalize(withoutTime(r)));
}

export function creatureId(genesis: LedgerRecord): string {
  return recordHash(genesis);
}

/** Why `value` is not a valid record; empty when it is. Never throws. */
export function recordProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['not-an-object'];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  const uint = (x: unknown): boolean => Number.isSafeInteger(x) && (x as number) >= 0;
  if (r.v !== 1) problems.push('version');
  if (!uint(r.rules)) problems.push('rules');
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) problems.push('kind');
  if (!uint(r.seq)) problems.push('seq');
  if (!uint(r.t)) problems.push('t');
  if (typeof r.owner !== 'string' || !PLAYER_ID.test(r.owner)) problems.push('owner');
  if (typeof r.body !== 'object' || r.body === null || Array.isArray(r.body)) {
    problems.push('body');
  } else {
    try {
      canonicalize(r.body as Canonical);
    } catch {
      problems.push('body');
    }
  }
  if (r.kind === 'genesis') {
    if (r.creature !== '' || r.seq !== 0 || r.prev !== '') problems.push('genesis-shape');
  } else if (
    typeof r.creature !== 'string' ||
    !HEX64.test(r.creature) ||
    typeof r.prev !== 'string' ||
    !HEX64.test(r.prev) ||
    r.seq === 0
  ) {
    problems.push('chain-shape');
  }
  return problems;
}

export function authorityPublicKey(secret: Uint8Array): string {
  return playerIdOf(publicKeyFromSecret(secret));
}

/** First 6 bytes of SHA-256(public key), base64url. */
export function authorityKeyId(publicKey: string): string {
  const bytes = fromBase64Url(publicKey);
  return toBase64Url(sha256(bytes ?? new Uint8Array(0)).slice(0, 6));
}

/** The authority's countersignature over a record hash, base64url. */
export function authoritySign(secret: Uint8Array, hash: string): string {
  return toBase64Url(signWithSecret(secret, AUTH_DOMAIN, hexToBytes(hash)));
}

/** Named failures; empty when the record, hash and signatures all verify. Never throws. */
export function checkStored(s: StoredRecord, keys: readonly PubKey[]): string[] {
  try {
    const shape = recordProblems(s.record);
    if (shape.length > 0) return shape.map((p) => `invalid-record:${p}`);
    const failures: string[] = [];
    if (typeof s.hash !== 'string' || s.hash !== recordHash(s.record))
      failures.push('hash-mismatch');
    const key = keys.find((k) => k.id === s.keyId);
    if (!key) {
      failures.push('unknown-key');
    } else if (
      !HEX64.test(s.hash) ||
      !verifyBase64(key.publicKey, AUTH_DOMAIN, hexToBytes(s.hash), s.authSig)
    ) {
      failures.push('bad-auth-signature');
    }
    if (
      s.ownerSig !== null &&
      !verifyBase64(s.record.owner, REQUEST_DOMAIN, requestMessage(s.record), s.ownerSig)
    ) {
      failures.push('bad-owner-signature');
    }
    return failures;
  } catch {
    return ['invalid-record:unreadable'];
  }
}

function verifyBase64(
  playerId: string,
  domain: string,
  message: Uint8Array,
  sig: unknown,
): boolean {
  const bytes = typeof sig === 'string' ? fromBase64Url(sig) : null;
  return bytes !== null && verify(playerId, domain, message, bytes);
}

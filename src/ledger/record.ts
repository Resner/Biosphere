import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';
import {
  fromBase64Url,
  isPlayerId,
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

export type RecordKind =
  | 'genesis'
  | 'birth'
  | 'checkpoint'
  | 'mate-commit'
  | 'promote'
  | 'restore'
  | 'death';
const KINDS: readonly string[] = [
  'genesis',
  'birth',
  'checkpoint',
  'mate-commit',
  'promote',
  'restore',
  'death',
];

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

export const HEX64 = /^[0-9a-f]{64}$/;

/**
 * The first rules version of the live world (ADR 0040): the reset of v0.7.2 retired every older
 * version, so a record written under one of them no longer verifies (`rules-retired`).
 */
const FIRST_LIVE_RULES = 8;

/** Whether a record's rules version was retired by a world reset. */
export const retired = (r: Pick<LedgerRecord, 'rules'>): boolean => r.rules < FIRST_LIVE_RULES;
const FIELDS = ['v', 'rules', 'kind', 'creature', 'seq', 'prev', 'owner', 't', 'body'];

/** The one way to put a float in a record body. */
export function hundredths(x: number): number {
  if (!Number.isFinite(x)) throw new RangeError(`not finite: ${x}`);
  const scaled = Math.round(x * 100) || 0;
  if (!Number.isSafeInteger(scaled)) throw new RangeError(`out of range: ${x}`);
  return scaled;
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
  return new TextEncoder().encode(requestText(r));
}

function requestText(r: RecordRequest): string {
  return canonicalize(withoutTime(r));
}

export function requestHash(r: RecordRequest): string {
  return hashWithDomain(REQUEST_DOMAIN, requestText(r));
}

export function creatureId(genesis: LedgerRecord): string {
  return recordHash(genesis);
}

/** Why `value` is not a valid record; empty when it is. Never throws. */
export function recordProblems(value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['not-an-object'];
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (Object.keys(r).some((key) => !FIELDS.includes(key))) problems.push('unknown-field');
  const uint = (x: unknown): boolean => Number.isSafeInteger(x) && (x as number) >= 0;
  if (r.v !== 1) problems.push('version');
  if (!uint(r.rules)) problems.push('rules');
  if (typeof r.kind !== 'string' || !KINDS.includes(r.kind)) problems.push('kind');
  if (!uint(r.seq)) problems.push('seq');
  if (!uint(r.t)) problems.push('t');
  if (typeof r.owner !== 'string' || !isPlayerId(r.owner)) problems.push('owner');
  if (typeof r.body !== 'object' || r.body === null || Array.isArray(r.body)) {
    problems.push('body');
  } else {
    try {
      canonicalize(r.body as Canonical);
      if (typeof r.kind === 'string') {
        for (const p of bodyProblems(r.kind as RecordKind, r.body)) problems.push(`body:${p}`);
      }
    } catch {
      problems.push('body');
    }
  }
  if (r.kind === 'genesis' || r.kind === 'birth') {
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

type FieldType = 'uint' | 'hex' | 'player' | 'hexpair' | 'slot' | 'role-ab' | 'promote-role';

const FIELD_TYPES: Record<FieldType, (x: unknown) => boolean> = {
  uint: (x) => Number.isSafeInteger(x) && (x as number) >= 0,
  hex: (x) => typeof x === 'string' && HEX64.test(x),
  player: (x) => typeof x === 'string' && isPlayerId(x),
  hexpair: (x) => Array.isArray(x) && x.length === 2 && x.every((h) => FIELD_TYPES.hex(h)),
  slot: (x) => FIELD_TYPES.uint(x) && (x as number) <= 255,
  'role-ab': (x) => x === 'a' || x === 'b',
  'promote-role': (x) => x === 'child' || x === 'parent',
};

const CONDITION = {
  activeMs: 'uint',
  biomass: 'uint',
  energy: 'uint',
  health: 'uint',
  cooldownUntilMs: 'uint',
} as const;

/** The body of each kind that M5 added; the M4 kinds (genesis, checkpoint, death) keep theirs. */
const BODIES: Partial<Record<RecordKind, Record<string, FieldType>>> = {
  'mate-commit': {
    commit: 'hex',
    round: 'uint',
    role: 'role-ab',
    partner: 'player',
    partnerCreature: 'hex',
    genome: 'hex',
    partnerGenome: 'hex',
    generation: 'uint',
    ...CONDITION,
  },
  birth: {
    commit: 'hex',
    round: 'uint',
    slot: 'slot',
    parents: 'hexpair',
    mates: 'hexpair',
    genome: 'hex',
    generation: 'uint',
    karyotype: 'uint',
  },
  restore: { from: 'hex', ...CONDITION },
};

const PROMOTE_BODIES: Record<string, Record<string, FieldType>> = {
  child: { role: 'promote-role', parent: 'hex' },
  parent: { role: 'promote-role', child: 'hex', ...CONDITION },
};

/** Why `body` is not a valid body for `kind`: `missing:`, `unknown:` or `bad:` plus the field. Never throws. */
export function bodyProblems(kind: RecordKind, body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return ['not-an-object'];
  const b = body as Record<string, unknown>;
  let fields = BODIES[kind];
  if (kind === 'promote') {
    if (!Object.hasOwn(b, 'role')) return ['missing:role'];
    const role = b.role;
    fields =
      typeof role === 'string' && Object.hasOwn(PROMOTE_BODIES, role)
        ? PROMOTE_BODIES[role]
        : undefined;
    if (!fields) return ['bad:role'];
  }
  if (!fields) return [];
  const problems: string[] = [];
  for (const [key, type] of Object.entries(fields)) {
    if (!Object.hasOwn(b, key)) problems.push(`missing:${key}`);
    else if (!FIELD_TYPES[type](b[key])) problems.push(`bad:${key}`);
  }
  for (const key of Object.keys(b)) {
    if (!Object.hasOwn(fields, key)) problems.push(`unknown:${key}`);
  }
  return problems;
}

export type Status = 'pending' | 'active' | 'checkpoint' | 'dead';

type Outcome = { ok: true; next: Status } | { ok: false; reason: string };

/** The ADR 0021 matrix: which statuses (null: no creature yet) a record of this kind may follow. */
const MATRIX: Record<string, Partial<Record<Status | 'none', Status>>> = {
  genesis: { none: 'active' },
  birth: { none: 'pending' },
  checkpoint: { active: 'active' },
  'mate-commit': { active: 'active' },
  'promote:child': { pending: 'active' },
  'promote:parent': { active: 'checkpoint' },
  restore: { checkpoint: 'active' },
  death: { active: 'dead', checkpoint: 'dead' },
};

/** Whether a record of `kind` (and `role`, for promote) may follow a creature in `status`, and the status it leaves. */
export function transitionOutcome(
  kind: RecordKind,
  role: string | null,
  status: Status | null,
): Outcome {
  if (kind === 'promote' && role !== 'child' && role !== 'parent')
    return { ok: false, reason: 'role' };
  const row = MATRIX[kind === 'promote' ? `promote:${role}` : kind];
  const from = status ?? 'none';
  const next = row?.[from];
  return next ? { ok: true, next } : { ok: false, reason: `status:${from}` };
}

export function authorityPublicKey(secret: Uint8Array): string {
  return playerIdOf(publicKeyFromSecret(secret));
}

/** First 6 bytes of SHA-256(public key), base64url. */
export function authorityKeyId(publicKey: string): string {
  const bytes = fromBase64Url(publicKey);
  if (!bytes) throw new RangeError('not a base64url public key');
  return toBase64Url(sha256(bytes).slice(0, 6));
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
    if (retired(s.record)) return ['rules-retired'];
    const failures: string[] = [];
    if (typeof s.hash !== 'string' || s.hash !== recordHash(s.record))
      failures.push('hash-mismatch');
    // An entry only counts when its id is derived from its key.
    const key = keys.find((k) => k.id === s.keyId && authorityKeyId(k.publicKey) === k.id);
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

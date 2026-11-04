import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import { survivedOutcome } from '../sim/encounter/types';
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
import { rulesProblem } from './registry';

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
  | 'death'
  | 'encounter';
const KINDS: readonly string[] = [
  'genesis',
  'birth',
  'checkpoint',
  'mate-commit',
  'promote',
  'restore',
  'death',
  'encounter',
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
 * `rules-retired` or `rules-unknown` when a record (or any document with a `rules` field) is not
 * of a live rules version (the registry, ADR 0055); null when it is, or when it names none.
 */
export function rulesOf(value: unknown): 'rules-retired' | 'rules-unknown' | null {
  const rules = (value as { rules?: unknown } | null)?.rules;
  return typeof value === 'object' && typeof rules === 'number' ? rulesProblem(rules) : null;
}
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
      if (typeof r.kind === 'string' && KINDS.includes(r.kind)) {
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

type FieldType =
  | 'cause'
  | 'uint'
  | 'hex'
  | 'player'
  | 'hexpair'
  | 'slot'
  | 'role-ab'
  | 'promote-role'
  | 'survived';

/** Every way a creature dies (`DeathCause`): the client's hazards, old age and a fight's two. */
const CAUSES: readonly string[] = [
  'starved',
  'toxin',
  'old-age',
  'uv',
  'pressure',
  'killed',
  'eaten',
];

const FIELD_TYPES: Record<FieldType, (x: unknown) => boolean> = {
  cause: (x) => typeof x === 'string' && CAUSES.includes(x),
  uint: (x) => Number.isSafeInteger(x) && (x as number) >= 0,
  hex: (x) => typeof x === 'string' && HEX64.test(x),
  player: (x) => typeof x === 'string' && isPlayerId(x),
  hexpair: (x) => Array.isArray(x) && x.length === 2 && x.every((h) => FIELD_TYPES.hex(h)),
  slot: (x) => FIELD_TYPES.uint(x) && (x as number) <= 255,
  'role-ab': (x) => x === 'a' || x === 'b',
  'promote-role': (x) => x === 'child' || x === 'parent',
  survived: (x) => typeof x === 'string' && survivedOutcome(x),
};

const VITALS = { biomass: 'uint', energy: 'uint', health: 'uint' } as const;
const CONDITION = { activeMs: 'uint', ...VITALS, cooldownUntilMs: 'uint' } as const;

/**
 * The body of every kind but `promote` and `death` (rules 11, ADR 0055): each field typed, and
 * none other allowed, so a later field is a rules bump.
 */
const BODIES: Partial<Record<RecordKind, Record<string, FieldType>>> = {
  genesis: { commit: 'hex', round: 'uint', genome: 'hex', generation: 'uint', karyotype: 'uint' },
  checkpoint: { activeMs: 'uint', ...VITALS },
  /** The condition after the cost, and the condition the cost was paid from (`…Before`). */
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
    biomassBefore: 'uint',
    energyBefore: 'uint',
    healthBefore: 'uint',
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
  /**
   * A fighter that came out of an encounter alive (M7 T13): its outcome, the frames it fought, its
   * condition at the end, the biomass its kills and eaten eggs were worth (hundredths), and its
   * life clock at the end, its locked time included (ADR 0054).
   */
  encounter: {
    enc: 'hex',
    outcome: 'survived',
    frames: 'uint',
    ...VITALS,
    reward: 'uint',
    activeMs: 'uint',
  },
};

/**
 * Death causes only an encounter's settlement writes (ADR 0052): a kill names the killer's
 * creature, an eaten egg its eater's, and both the encounter. Such a death is never owner-signed.
 */
export const FIGHT_CAUSES: readonly string[] = ['killed', 'eaten'];

/** Causes only the hub decides (its clock, or a fight's settlement): a client never reports them. */
export const AUTHORITY_CAUSES: readonly string[] = ['old-age', ...FIGHT_CAUSES];

/**
 * A death is its cause, clock and biomass. One of a fight's causes also names `enc` and `by`, and
 * any other death a settlement wrote (a hazard during the fight) names `enc` alone, so it can be
 * checked against its settlement.
 */
const DEATH: Record<string, FieldType> = { cause: 'cause', activeMs: 'uint', biomass: 'uint' };
const DEATH_IN_FIGHT: Record<string, FieldType> = { ...DEATH, enc: 'hex' };
const FIGHT_DEATH: Record<string, FieldType> = { ...DEATH_IN_FIGHT, by: 'hex' };

const PROMOTE_BODIES: Record<string, Record<string, FieldType>> = {
  child: { role: 'promote-role', parent: 'hex' },
  parent: { role: 'promote-role', child: 'hex', ...CONDITION },
};

/**
 * Why `body` is not a valid body for `kind` (rules 11: every kind typed): `missing:`, `unknown:`
 * or `bad:` plus the field, or `kind` for a kind with no shape. Never throws.
 */
export function bodyProblems(kind: RecordKind, body: unknown): string[] {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return ['not-an-object'];
  const b = body as Record<string, unknown>;
  let fields = Object.hasOwn(BODIES, kind) ? BODIES[kind] : undefined;
  if (kind === 'death') {
    const cause = b.cause;
    fields =
      typeof cause === 'string' && FIGHT_CAUSES.includes(cause)
        ? FIGHT_DEATH
        : Object.hasOwn(b, 'enc')
          ? DEATH_IN_FIGHT
          : DEATH;
  } else if (kind === 'promote') {
    if (!Object.hasOwn(b, 'role')) return ['missing:role'];
    const role = b.role;
    fields =
      typeof role === 'string' && Object.hasOwn(PROMOTE_BODIES, role)
        ? PROMOTE_BODIES[role]
        : undefined;
    if (!fields) return ['bad:role'];
  }
  if (!fields) return ['kind'];
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
  // ADR 0052: a pending child dies only of an egg eaten in a settled encounter.
  'death:eaten': { pending: 'dead' },
  encounter: { active: 'active' },
};

/**
 * Whether a record of `kind` may follow a creature in `status`, and the status it leaves. `role` is
 * the promote role, or a death's cause (`eaten` has its own row).
 */
export function transitionOutcome(
  kind: RecordKind,
  role: string | null,
  status: Status | null,
): Outcome {
  if (kind === 'promote' && role !== 'child' && role !== 'parent')
    return { ok: false, reason: 'role' };
  const name =
    kind === 'promote'
      ? `promote:${role}`
      : kind === 'death' && role === 'eaten'
        ? 'death:eaten'
        : kind;
  const row = MATRIX[name];
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
    const rules = rulesOf(s.record);
    if (rules) return [rules];
    const shape = recordProblems(s.record);
    if (shape.length > 0) return shape.map((p) => `invalid-record:${p}`);
    const failures: string[] = [];
    // A fight's results are the authority's alone: never signed by an owner.
    if (s.ownerSig !== null && authorityOnly(s.record)) failures.push('not-attested');
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

/** Records only the authority starts: an encounter's result, and a death a fight decided. */
export const authorityOnly = (r: Pick<LedgerRecord, 'kind' | 'body'>): boolean =>
  r.kind === 'encounter' || (r.kind === 'death' && FIGHT_CAUSES.includes(r.body.cause as string));

function verifyBase64(
  playerId: string,
  domain: string,
  message: Uint8Array,
  sig: unknown,
): boolean {
  const bytes = typeof sig === 'string' ? fromBase64Url(sig) : null;
  return bytes !== null && verify(playerId, domain, message, bytes);
}

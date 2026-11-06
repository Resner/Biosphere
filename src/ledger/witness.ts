import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { SIGNATURE_BYTES } from '../net/protocol-defs';
import { createRng, seedFromBytes } from '../sim/prng';
import { canonicalize } from './canonical';
import { QUICKNET, roundTime } from './drand-time';
import { fromBase64Url, type Identity, isPlayerId, toBase64Url } from './identity';
import { type KeyVerify, keyVerifier } from './key-verify';
import { HEX64 } from './record';
import { frameLeaf } from './settlement';

// Witness documents (ADR 0058): who may witness an event, the drand round that orders them, the
// order itself, an auditor's attestation, and the signatures on a fighter's input to a witness and
// on a witness's frame. All pure and shared by the authority, the page and the verifier.

export const POOL_MAX = 16;
/** A witness commitment's round is due at least this long after the commitment. */
export const WITNESS_MARGIN_MS = 500;

export type DutyKind = 'enc' | 'mating' | 'genesis';
export type DutyRole = 'referee' | 'auditor';

const POOL_DOMAIN = 'bs/pool/v1';
const ORDER_DOMAIN = 'bs/witness/v1';
const ATTEST_DOMAIN = 'bs/attest/v1';
const INPUT_DOMAIN = 'bs/input/v1';
const WFRAME_DOMAIN = 'bs/wframe/v1';
const BIRTH_DOMAIN = 'bs/attest/birth/v1';

const CODE = /^[a-z0-9:_-]{1,64}$/;
const EVENT = /^(enc|mating|genesis):([0-9a-f]{64})$/;
const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

const isHex64 = (v: unknown): v is string => typeof v === 'string' && HEX64.test(v);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (v: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(v).every((k) => keys.includes(k));

/** The event a duty serves: `'enc:<64 hex>'`, `'mating:…'` or `'genesis:…'`. */
export function dutyEvent(kind: DutyKind, id: string): string {
  const event = `${kind}:${id}`;
  if (!EVENT.test(event)) throw new RangeError(`not a duty event: ${event}`);
  return event;
}

export function parseDutyEvent(s: unknown): { kind: DutyKind; id: string } | null {
  const m = typeof s === 'string' ? EVENT.exec(s) : null;
  return m ? { kind: m[1] as DutyKind, id: m[2] as string } : null;
}

/** A `witness` commitment's data (`Beacons.commit('witness', '', data, { round })`). */
export interface WitnessData {
  event: string;
  /** Player ids, sorted, unique, 1 to `POOL_MAX` of them. */
  pool: string[];
}

/** Why `v` is no witness commitment's data; empty when it is one. Never throws. */
export function witnessDataProblems(v: unknown): string[] {
  if (!isRecord(v)) return ['data'];
  const problems = Object.keys(v)
    .filter((k) => k !== 'event' && k !== 'pool')
    .map((k) => `unknown:${k}`);
  if (!parseDutyEvent(v.event)) problems.push('event');
  const pool = v.pool;
  if (!Array.isArray(pool)) return [...problems, 'pool'];
  if (pool.length === 0 || pool.length > POOL_MAX) return [...problems, 'pool-size'];
  if (!pool.every((id) => typeof id === 'string' && isPlayerId(id))) problems.push('pool-id');
  else if (!pool.every((id, i) => i === 0 || (pool[i - 1] as string) < id))
    problems.push('pool-order');
  return problems;
}

/** The `POOL_MAX` ids with the lowest SHA-256('bs/pool/v1' ‖ event ‖ id), sorted by id. Duplicates count once. */
export function poolOf(eligible: readonly string[], event: string): string[] {
  const keyed = [...new Set(eligible)].map((id) => ({
    id,
    key: bytesToHex(sha256(utf8(`${POOL_DOMAIN}${event}${id}`))),
  }));
  // Ids are unique, so keys differ unless SHA-256 collides.
  keyed.sort((a, b) => (a.key < b.key ? -1 : 1));
  return keyed
    .slice(0, POOL_MAX)
    .map((k) => k.id)
    .sort();
}

/** The first round due at or after `t + WITNESS_MARGIN_MS`: still unpublished when committed at `t`. */
export function witnessRound(t: number): number {
  if (!Number.isFinite(t)) throw new RangeError(`not a time: ${t}`);
  const period = QUICKNET.period * 1000;
  const r = Math.ceil((t + WITNESS_MARGIN_MS - QUICKNET.genesis * 1000) / period) + 1;
  const round = Math.max(1, r);
  // Guards the float division at the boundary: the round must be due at or after the margin.
  return roundTime(round) < t + WITNESS_MARGIN_MS ? round + 1 : round;
}

/**
 * The pool in the order the round draws: a Fisher–Yates shuffle through the sim's PRNG, seeded by
 * SHA-256('bs/witness/v1' ‖ the randomness ‖ the commit id's 32 bytes). Throws RangeError for a
 * commit id that is not 64 hex.
 */
export function witnessOrder(
  pool: readonly string[],
  randomness: Uint8Array,
  commitId: string,
): string[] {
  if (!isHex64(commitId)) throw new RangeError(`not a commit id: ${commitId}`);
  const digest = sha256(concatBytes(utf8(ORDER_DOMAIN), randomness, hexToBytes(commitId)));
  const rng = createRng(seedFromBytes(digest), 'witness-order');
  const out = [...pool];
  for (let i = out.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    [out[i], out[j]] = [out[j] as string, out[i] as string];
  }
  return out;
}

/** Where a role's first offer sits in the order: an encounter's referee 0 and auditor 1; a mating's or a genesis's auditor 0. */
export function firstPosition(kind: DutyKind, role: DutyRole): number | null {
  if (kind === 'enc') return role === 'referee' ? 0 : 1;
  return role === 'auditor' ? 0 : null;
}

// Player keys, each tabled once (`key-verify.ts`): a fighter checks every frame of its witness, and
// the authority every attestation. A small cache, dropping the oldest key when full.
const KEY_CACHE_MAX = 64;
const keys = new Map<string, KeyVerify | null>();

function playerKey(playerId: string): KeyVerify | null {
  if (keys.has(playerId)) return keys.get(playerId) ?? null;
  const key = isPlayerId(playerId) ? keyVerifier(playerId) : null;
  if (keys.size >= KEY_CACHE_MAX) keys.delete(keys.keys().next().value as string);
  keys.set(playerId, key);
  return key;
}

function sigBytes(sig: unknown): Uint8Array | null {
  const bytes = typeof sig === 'string' ? fromBase64Url(sig) : null;
  return bytes?.length === SIGNATURE_BYTES ? bytes : null;
}

/** True when `key()` verifies `sig` over `bytes()` under `domain`. A missing key, a bad signature text or any throw is false. */
function sigOk(
  key: () => KeyVerify | null,
  domain: string,
  bytes: () => Uint8Array,
  sig: unknown,
): boolean {
  try {
    const raw = sigBytes(sig);
    const verify = raw ? key() : null;
    return !!verify && !!raw && verify(domain, bytes(), raw);
  } catch {
    return false;
  }
}

export interface Attestation {
  v: 1;
  kind: 'attest';
  /** `dutyEvent(…)` */
  event: string;
  /** The witness commitment's id. */
  duty: string;
  /** The witness's place in `witnessOrder`. */
  position: number;
  /** Its player id. */
  witness: string;
  /** The settlement's hash, the genesis record's hash, or `birthSubject(slot 0, slot 1)`. */
  subject: string;
  agree: boolean;
  /** The auditor's first problem; only when `agree` is false. */
  code?: string;
}

/** Ed25519 by the witness, domain `bs/attest/v1`, base64url. */
export interface SignedAttestation {
  attestation: Attestation;
  sig: string;
}

const ATTEST_KEYS = [
  'v',
  'kind',
  'event',
  'duty',
  'position',
  'witness',
  'subject',
  'agree',
  'code',
];

/** What an attestation signs: its canonical JSON, with `agree` as 1 or 0 (canonical JSON has no booleans). */
function attestationBytes(a: Attestation): Uint8Array {
  const { agree, code, ...rest } = a;
  return utf8(
    canonicalize({ ...rest, agree: agree ? 1 : 0, ...(code === undefined ? {} : { code }) }),
  );
}

export function signAttestation(identity: Identity, a: Attestation): SignedAttestation {
  return { attestation: a, sig: toBase64Url(identity.sign(ATTEST_DOMAIN, attestationBytes(a))) };
}

/** A signed attestation rebuilt from untrusted JSON, or null. Refuses unknown fields; never throws. */
export function parseSignedAttestation(v: unknown): SignedAttestation | null {
  try {
    if (!isRecord(v) || !onlyKeys(v, ['attestation', 'sig'])) return null;
    const a = v.attestation;
    if (!isRecord(a) || !onlyKeys(a, ATTEST_KEYS) || !sigBytes(v.sig)) return null;
    const { position, agree, code } = a;
    if (a.v !== 1 || a.kind !== 'attest' || !parseDutyEvent(a.event)) return null;
    if (!isHex64(a.duty)) return null;
    if (!isHex64(a.subject)) return null;
    if (typeof a.witness !== 'string' || !isPlayerId(a.witness)) return null;
    if (!Number.isInteger(position) || (position as number) < 0) return null;
    if ((position as number) >= POOL_MAX || typeof agree !== 'boolean') return null;
    if (code !== undefined && (agree || typeof code !== 'string' || !CODE.test(code))) return null;
    const attestation: Attestation = {
      v: 1,
      kind: 'attest',
      event: a.event as string,
      duty: a.duty,
      position: position as number,
      witness: a.witness,
      subject: a.subject,
      agree,
    };
    if (code !== undefined) attestation.code = code as string;
    return { attestation, sig: v.sig as string };
  } catch {
    return null;
  }
}

/** True when the attestation's own witness signed it. Never throws. */
export function attestationSigned(s: SignedAttestation): boolean {
  return sigOk(
    () => playerKey(s.attestation.witness),
    ATTEST_DOMAIN,
    () => attestationBytes(s.attestation),
    s.sig,
  );
}

/** A mating's subject: SHA-256 of both birth hashes in slot order, as hex. */
export function birthSubject(slot0: string, slot1: string): string {
  if (!isHex64(slot0) || !isHex64(slot1)) throw new RangeError('not a record hash');
  return bytesToHex(sha256(concatBytes(utf8(BIRTH_DOMAIN), hexToBytes(slot0), hexToBytes(slot1))));
}

function encBytes(enc: string): Uint8Array {
  if (!isHex64(enc)) throw new RangeError(`not an encounter id: ${enc}`);
  return hexToBytes(enc);
}

/** `'bs/input/v1' ‖ enc (32 bytes) ‖ u16 f ‖ u32 code`, 49 bytes. Throws RangeError outside those ranges. */
export function inputBytes(enc: string, f: number, code: number): Uint8Array {
  if (!Number.isInteger(f) || f < 0 || f > 0xffff) throw new RangeError(`bad frame ${f}`);
  if (!Number.isInteger(code) || code < 0 || code > 0xffffffff)
    throw new RangeError(`bad input ${code}`);
  const tag = utf8(INPUT_DOMAIN);
  const out = new Uint8Array(tag.length + 38);
  out.set(tag);
  out.set(encBytes(enc), tag.length);
  const view = new DataView(out.buffer);
  view.setUint16(tag.length + 32, f);
  view.setUint32(tag.length + 34, code);
  return out;
}

/** A fighter's signature on its input for frame `f`, base64url. */
export function signInput(identity: Identity, enc: string, f: number, code: number): string {
  return toBase64Url(identity.sign(INPUT_DOMAIN, inputBytes(enc, f, code)));
}

/** True when `sig` is the key's signature on that input. Never throws. */
export function inputSigned(
  verify: KeyVerify,
  enc: string,
  f: number,
  code: number,
  sig: string,
): boolean {
  return sigOk(
    () => verify,
    INPUT_DOMAIN,
    () => inputBytes(enc, f, code),
    sig,
  );
}

/** `'bs/wframe/v1' ‖ enc ‖ frameLeaf(f, inputs)`: a null input and a code 0 differ. */
export function witnessFrameBytes(
  enc: string,
  f: number,
  inputs: readonly (number | null)[],
): Uint8Array {
  return concatBytes(utf8(WFRAME_DOMAIN), encBytes(enc), frameLeaf(f, inputs));
}

/** A witness's signature on its final frame `f`, base64url. */
export function signWitnessFrame(
  identity: Identity,
  enc: string,
  f: number,
  inputs: readonly (number | null)[],
): string {
  return toBase64Url(identity.sign(WFRAME_DOMAIN, witnessFrameBytes(enc, f, inputs)));
}

/** True when the player `witness` signed that frame. Never throws. */
export function witnessFrameSigned(
  witness: string,
  enc: string,
  f: number,
  inputs: readonly (number | null)[],
  sig: string,
): boolean {
  return sigOk(
    () => playerKey(witness),
    WFRAME_DOMAIN,
    () => witnessFrameBytes(enc, f, inputs),
    sig,
  );
}

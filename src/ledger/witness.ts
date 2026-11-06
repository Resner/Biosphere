import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { createRng, seedFromBytes } from '../sim/prng';
import { canonicalize } from './canonical';
import { QUICKNET, roundTime } from './drand-time';
import { type Identity, isPlayerId, toBase64Url, verify } from './identity';
import { type KeyVerify, keyVerifier } from './key-verify';
import { frameLeaf } from './settlement';
import {
  type Attestation,
  type DutyKind,
  type DutyRole,
  isHex64,
  POOL_MAX,
  type SignedAttestation,
  sigBytes,
} from './witness-doc';

export {
  type Attestation,
  type DutyKind,
  type DutyRole,
  dutyEvent,
  POOL_MAX,
  parseDutyEvent,
  parseSignedAttestation,
  type SignedAttestation,
  type WitnessData,
  witnessDataProblems,
} from './witness-doc';

// Witness documents (ADR 0058): who may witness an event, the drand round that orders them, the
// order itself, an auditor's attestation, and the signatures on a fighter's input to a witness and
// on a witness's frame. All pure and shared by the authority, the page and the verifier. The shapes
// and parsers that need no key live in `witness-doc.ts`, which the wire's parsers load alone.

/** A witness commitment's round is due at least this long after the commitment. */
export const WITNESS_MARGIN_MS = 500;

const POOL_DOMAIN = 'bs/pool/v1';
const ORDER_DOMAIN = 'bs/witness/v1';
const ATTEST_DOMAIN = 'bs/attest/v1';
const INPUT_DOMAIN = 'bs/input/v1';
const WFRAME_DOMAIN = 'bs/wframe/v1';
const BIRTH_DOMAIN = 'bs/attest/birth/v1';

const encoder = new TextEncoder();
const utf8 = (text: string): Uint8Array => encoder.encode(text);

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

/** True when the attestation's own witness signed it. Never throws. A witness signs a few of these, so its key isn't tabled. */
export function attestationSigned(s: SignedAttestation): boolean {
  const raw = sigBytes(s.sig);
  return (
    !!raw && verify(s.attestation.witness, ATTEST_DOMAIN, attestationBytes(s.attestation), raw)
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

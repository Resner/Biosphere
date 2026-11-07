import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
import type { PeerEvent, Pos } from '../net/protocol-defs';
import { type Canonical, canonicalize, hashWithDomain } from './canonical';
import { fromBase64Url, type Identity, toBase64Url, verify } from './identity';
import { type KeyVerify, keyVerifier } from './key-verify';
import {
  AUTH_DOMAIN,
  authorityKeyId,
  authorityPublicKey,
  authoritySign,
  type PubKey,
} from './record';
import { parseSignedSeat, type Seat, type SignedSeat } from './seat-doc';

// Seat tickets and signed signals (M11 T7, ADR 0062). A ticket is countersigned as a record is:
// the authority's `bs/auth/v1` signature over its hash, `SHA-256('bs/seat/v1' ‖ canonical JSON)`,
// so the ledger's one `countersign` signs it and writes no row. A relayed signal (`relay`, T9) is
// signed by its sender over `signalBytes`, so a peer passing it on can change nothing in it. The
// checks load `@noble/curves` (the authority's key is tabled once, `key-verify.ts`); the wire's
// parsers import `seat-doc.ts` alone.

export * from './seat-doc';

export const SEAT_DOMAIN = 'bs/seat/v1';
export const SIGNAL_DOMAIN = 'bs/signal/v1';
/** A ticket dated this far past a peer's clock still counts: the clocks of two machines differ. */
export const SEAT_SKEW_MS = 30_000;

/** The hash the authority countersigns: `SHA-256('bs/seat/v1' ‖ canonical JSON)`, hex. */
export function seatHash(seat: Seat): string {
  return hashWithDomain(SEAT_DOMAIN, canonicalize(seat as unknown as Canonical));
}

/** A ticket countersigned with a bare authority secret (the ledger signs through `countersign`). */
export function signSeat(secret: Uint8Array, seat: Seat): SignedSeat {
  return {
    seat,
    authSig: authoritySign(secret, seatHash(seat)),
    keyId: authorityKeyId(authorityPublicKey(secret)),
  };
}

// Each authority key's verifier, tabled once: the keys are never rotated, so a few suffice.
const VERIFIERS_MAX = 8;
const verifiers = new Map<string, KeyVerify | null>();
function verifierOf(publicKey: string): KeyVerify | null {
  if (verifiers.has(publicKey)) return verifiers.get(publicKey) ?? null;
  if (verifiers.size >= VERIFIERS_MAX) verifiers.delete(verifiers.keys().next().value as string);
  const v = keyVerifier(publicKey);
  verifiers.set(publicKey, v);
  return v;
}

/**
 * Whether a ticket holds for `want`: countersigned under a key of `keys` (`/v1/pubkeys`) whose id
 * derives from it, for that world and player, dated no later than `SEAT_SKEW_MS` past `now`, and
 * not expired. Takes untrusted values; never throws.
 */
export function seatValid(
  s: SignedSeat,
  keys: readonly PubKey[],
  want: { world: string; player: string; now: number },
): boolean {
  try {
    const t = parseSignedSeat(s);
    if (!t) return false;
    const { seat } = t;
    if (seat.world !== want.world || seat.player !== want.player) return false;
    if (!(seat.t <= want.now + SEAT_SKEW_MS && seat.until > want.now)) return false;
    const key = keys.find((k) => k.id === t.keyId);
    if (!key || authorityKeyId(key.publicKey) !== key.id) return false;
    const sig = fromBase64Url(t.authSig);
    const check = verifierOf(key.publicKey);
    return sig !== null && check !== null && check(AUTH_DOMAIN, hexToBytes(seatHash(seat)), sig);
  } catch {
    return false;
  }
}

const KINDS = { offer: 0, answer: 1 } as const;

function playerBytes(id: string): Uint8Array {
  const bytes = fromBase64Url(id);
  if (bytes?.length !== 32 || id.length !== 43) throw new RangeError('not a player id');
  return bytes;
}

/**
 * What a signal's sender signs: `'bs/signal/v1' ‖ from (32 bytes) ‖ to (32) ‖ kind (1, offer 0 and
 * answer 1) ‖ u64 at ‖ 3 × f64 pos ‖ SHA-256(sdp)`, big-endian. Throws for malformed input.
 */
export function signalBytes(
  from: string,
  to: string,
  kind: 'offer' | 'answer',
  at: number,
  pos: Pos,
  sdp: string,
): Uint8Array {
  if (!Object.hasOwn(KINDS, kind)) throw new RangeError('bad kind');
  if (!Number.isSafeInteger(at) || at < 0) throw new RangeError('bad time');
  if (!Array.isArray(pos) || pos.length !== 3 || !pos.every(Number.isFinite))
    throw new RangeError('bad position');
  if (typeof sdp !== 'string') throw new RangeError('bad sdp');
  const tag = new TextEncoder().encode(SIGNAL_DOMAIN);
  const out = new Uint8Array(tag.length + 129);
  out.set(tag);
  let o = tag.length;
  out.set(playerBytes(from), o);
  out.set(playerBytes(to), o + 32);
  o += 64;
  const view = new DataView(out.buffer);
  view.setUint8(o, KINDS[kind]);
  view.setBigUint64(o + 1, BigInt(at));
  o += 9;
  for (const [i, v] of pos.entries()) view.setFloat64(o + 8 * i, v);
  out.set(sha256(new TextEncoder().encode(sdp)), o + 24);
  return out;
}

/** The sender's signature on a signal to `to`, base64url. */
export function signSignal(
  identity: Identity,
  to: string,
  kind: 'offer' | 'answer',
  at: number,
  pos: Pos,
  sdp: string,
): string {
  const bytes = signalBytes(identity.playerId, to, kind, at, pos, sdp);
  return toBase64Url(identity.sign(SIGNAL_DOMAIN, bytes));
}

/** True when a relayed signal carries its sender's (`from`) signature over every field. Never throws. */
export function signalSigned(m: Extract<PeerEvent, { t: 'relay' }>): boolean {
  try {
    const sig = typeof m.sig === 'string' ? fromBase64Url(m.sig) : null;
    if (!sig) return false;
    return verify(
      m.from,
      SIGNAL_DOMAIN,
      signalBytes(m.from, m.to, m.kind, m.at, m.pos, m.sdp),
      sig,
    );
  } catch {
    return false;
  }
}

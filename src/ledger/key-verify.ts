import { ed25519 } from '@noble/curves/ed25519.js';
import { bytesToNumberLE, concatBytes } from '@noble/curves/utils.js';
import { sha512 } from '@noble/hashes/sha2.js';
import { fromBase64Url, signedBytes } from './identity';

// Ed25519 verification under one key many times over (ADR 0055): a proof bundle holds hundreds of
// countersignatures by one or two authority keys, so the key's point is decoded and its
// multiples tabled once. The equation is `verify`'s in `identity.ts` (RFC 8032, strict: canonical
// encodings, s < L, no small-order key, the cofactored check), and `key-verify.test.ts` holds the
// two to the same answers. Loaded by the verifier, and by the witness documents (`witness.ts`), which
// table each player key whose inputs, frames or attestations they check.

const { Point } = ed25519;
const L = Point.Fn.ORDER;

/** Checks signatures under `domain` by one key; false for anything that does not verify. Never throws. */
export type KeyVerify = (domain: string, message: Uint8Array, sig: Uint8Array) => boolean;

/** A verifier for the base64url public key `publicKey`, or null when it is no usable key. Never throws. */
export function keyVerifier(publicKey: string): KeyVerify | null {
  const bytes = fromBase64Url(publicKey);
  if (bytes?.length !== 32) return null;
  let A: InstanceType<typeof Point>;
  try {
    A = Point.fromBytes(bytes, false);
    if (A.isSmallOrder()) return null;
    A.precompute(8, false);
  } catch {
    return null;
  }
  return (domain, message, sig) => {
    if (sig.length !== 64) return false;
    try {
      const r = sig.subarray(0, 32);
      const R = Point.fromBytes(r, false);
      // Throws for s ≥ L.
      const SB = Point.BASE.multiplyUnsafe(bytesToNumberLE(sig.subarray(32)));
      const k = bytesToNumberLE(sha512(concatBytes(r, bytes, signedBytes(domain, message)))) % L;
      return R.add(A.multiplyUnsafe(k)).subtract(SB).clearCofactor().is0();
    } catch {
      return false;
    }
  };
}

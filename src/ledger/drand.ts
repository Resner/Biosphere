import { pippenger } from '@noble/curves/abstract/curve.js';
import { bls12_381 } from '@noble/curves/bls12-381.js';
import { bytesToNumberBE } from '@noble/curves/utils.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { concatBytes, hexToBytes } from '@noble/hashes/utils.js';
import { QUICKNET } from './drand-time';

// drand quicknet client (ADR 0010): verified beacons only. BLS12-381 is heavy, so the game loads
// this module lazily, when the first genesis arrives; nothing else in the shell imports it.

export { QUICKNET, roundAt, roundTime } from './drand-time';

export const DRAND_HOSTS: readonly string[] = [
  'https://api.drand.sh',
  'https://api2.drand.sh',
  'https://api3.drand.sh',
  'https://drand.cloudflare.com',
];

/** The hash-to-curve tag of the `bls-unchained-g1-rfc9380` scheme. */
export const DST = 'BLS_SIG_BLS12381G1_XMD:SHA-256_SSWU_RO_NUL_';
const SIGNATURE_HEX = /^[0-9a-f]{96}$/;
const FETCH_TIMEOUT_MS = 5000;

export interface Beacon {
  round: number;
  signature: string;
}

export function roundMessage(round: number): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(round));
  return sha256(out);
}

const wellFormed = (b: Beacon) =>
  Number.isSafeInteger(b.round) &&
  b.round >= 1 &&
  typeof b.signature === 'string' &&
  SIGNATURE_HEX.test(b.signature);

/** True when the beacon's signature verifies for its round under the pinned chain key. Never throws. */
export function verifyBeacon(b: Beacon): boolean {
  try {
    if (!wellFormed(b)) return false;
    const sigs = bls12_381.shortSignatures;
    return sigs.verify(
      hexToBytes(b.signature),
      sigs.hash(roundMessage(b.round), DST),
      hexToBytes(QUICKNET.publicKey),
    );
  } catch {
    return false;
  }
}

const BATCH_DOMAIN = new TextEncoder().encode('bs/beacon-batch/v1');

/**
 * Whether each beacon verifies, as `verifyBeacon` answers, at the cost of one pairing check for the
 * lot (a beacon alone costs two pairings, about 25 ms in Node). It checks
 * `e(Σ rᵢ·Sᵢ, G2) = e(Σ rᵢ·H(roundᵢ), pk)` with 128-bit coefficients drawn from SHA-256 of every
 * signature (Fiat–Shamir), so signatures forged to cancel out fail it; when it fails, each beacon
 * is checked alone. Never throws.
 */
export function verifyBeacons(beacons: readonly Beacon[]): boolean[] {
  if (beacons.length < 2) return beacons.map(verifyBeacon);
  try {
    if (!beacons.every(wellFormed)) return beacons.map(verifyBeacon);
    const sigs = bls12_381.shortSignatures;
    const all = sha256(concatBytes(BATCH_DOMAIN, ...beacons.map((b) => hexToBytes(b.signature))));
    const scalars = beacons.map((_, i) => {
      const index = new Uint8Array(4);
      new DataView(index.buffer).setUint32(0, i);
      return bytesToNumberBE(sha256(concatBytes(all, index)).subarray(0, 16)) | 1n;
    });
    const G1 = bls12_381.G1.Point;
    const points = pippenger(
      G1,
      beacons.map((b) => sigs.Signature.fromBytes(hexToBytes(b.signature))),
      scalars,
    );
    const hashes = pippenger(
      G1,
      beacons.map((b) => sigs.hash(roundMessage(b.round), DST)),
      scalars,
    );
    const pk = bls12_381.G2.Point.fromBytes(hexToBytes(QUICKNET.publicKey));
    const { Fp12 } = bls12_381.fields;
    const one = bls12_381.pairingBatch([
      { g1: hashes, g2: pk.negate() },
      { g1: points, g2: bls12_381.G2.Point.BASE },
    ]);
    if (Fp12.eql(one, Fp12.ONE)) return beacons.map(() => true);
  } catch {
    // A beacon that does not decode fails alone below.
  }
  return beacons.map(verifyBeacon);
}

/** The beacon's randomness: SHA-256 of the signature bytes. Call it only on a verified beacon. */
export function randomnessOf(b: Beacon): Uint8Array {
  return sha256(hexToBytes(b.signature));
}

async function fetchFrom(
  host: string,
  round: number | 'latest',
  f: typeof fetch,
  timeoutMs: number,
): Promise<Beacon | null> {
  try {
    const res = await f(`${host}/${QUICKNET.chain}/public/${round}`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) return null;
    const { round: got, signature } = body as { round?: unknown; signature?: unknown };
    if (typeof got !== 'number' || typeof signature !== 'string') return null;
    if (round !== 'latest' && got !== round) return null;
    const beacon = { round: got, signature };
    return verifyBeacon(beacon) ? beacon : null;
  } catch {
    return null;
  }
}

/**
 * A verified beacon from the first host that serves one; throws when none does. A host can answer
 * 'latest' with an old but genuine round, so callers that need freshness compare it with `roundAt`.
 */
export async function fetchBeacon(
  round: number | 'latest',
  f: typeof fetch,
  hosts: readonly string[] = DRAND_HOSTS,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Beacon> {
  for (const host of hosts) {
    const beacon = await fetchFrom(host, round, f, timeoutMs);
    if (beacon) return beacon;
  }
  throw new Error(`no drand host served a verified beacon for round ${round}`);
}

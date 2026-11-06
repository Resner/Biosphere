import { bls12_381 } from '@noble/curves/bls12-381.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hexToBytes } from '@noble/hashes/utils.js';
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

/** True when the beacon's signature verifies for its round under the pinned chain key. Never throws. */
export function verifyBeacon(b: Beacon): boolean {
  try {
    if (!Number.isSafeInteger(b.round) || b.round < 1) return false;
    if (typeof b.signature !== 'string' || !SIGNATURE_HEX.test(b.signature)) return false;
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

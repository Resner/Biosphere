import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import type { Seed } from '../sim/prng';
import { canonicalize, hashWithDomain } from './canonical';

// An encounter's id and seed (ADR 0050). The id names the participants' chain heads and the lock
// time; the seed mixes in the newest beacon the authority already held, so nothing waits on drand.

export const ENC_ID_DOMAIN = 'bs/enc/v1/id';
export const ENC_SEED_DOMAIN = 'bs/enc/v1';

/** `SHA-256('bs/enc/v1/id\n' ‖ JCS({ heads, t }))`, the heads sorted, `t` the lock time in ms. */
export function encounterId(heads: readonly string[], t: number): string {
  return hashWithDomain(ENC_ID_DOMAIN, canonicalize({ heads: [...heads].sort(), t }));
}

/** `SHA-256('bs/enc/v1' ‖ randomness ‖ id bytes)` as hex; empty randomness when no beacon is known. */
export function encounterSeed(randomness: Uint8Array, id: string): string {
  const tag = new TextEncoder().encode(ENC_SEED_DOMAIN);
  const idBytes = hexToBytes(id);
  const input = new Uint8Array(tag.length + randomness.length + idBytes.length);
  input.set(tag);
  input.set(randomness, tag.length);
  input.set(idBytes, tag.length + randomness.length);
  return bytesToHex(sha256(input));
}

/** The simulation's seed from the hex seed: its first four big-endian words. */
export function seedWords(seed: string): Seed {
  const bytes = hexToBytes(seed);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(0), view.getUint32(4), view.getUint32(8), view.getUint32(12)];
}

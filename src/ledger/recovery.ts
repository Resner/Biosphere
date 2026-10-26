import { sha256 } from '@noble/hashes/sha2.js';

// The recovery code (ADR 0009): the identity seed and a 2-byte checksum as Crockford base32, so a
// player can move to another browser without an account. 34 bytes = 272 bits, shown as 55
// characters (275 bits, the last 3 always zero) in 11 groups of 5. Browsers, Node and workerd.

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SEED_BYTES = 32;
const SUM_BYTES = 2;
const CHARS = 55;
const SPARE_BITS = 3;
const SUM_DOMAIN = new TextEncoder().encode('bs/recovery/v1\n');

function checksum(seed: Uint8Array): Uint8Array {
  const input = new Uint8Array(SUM_DOMAIN.length + seed.length);
  input.set(SUM_DOMAIN);
  input.set(seed, SUM_DOMAIN.length);
  return sha256(input).slice(0, SUM_BYTES);
}

/** The 32-byte seed as 11 dash-separated groups of 5 characters. */
export function encodeRecoveryCode(seed: Uint8Array): string {
  if (seed.length !== SEED_BYTES) throw new RangeError('a seed is 32 bytes');
  const bytes = [...seed, ...checksum(seed)];
  let bits = 0;
  let held = 0;
  let out = '';
  for (const byte of bytes) {
    held = (held << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(held >> (bits - 5)) & 31];
      bits -= 5;
    }
    held &= (1 << bits) - 1;
  }
  out += ALPHABET[(held << (5 - bits)) & 31];
  return out.match(/.{5}/g)?.join('-') ?? '';
}

/** The seed a code names, or null for anything that is not exactly one of our codes. */
export function decodeRecoveryCode(text: string): Uint8Array | null {
  const chars = text.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
  if (chars.length !== CHARS) return null;
  const bytes: number[] = [];
  let bits = 0;
  let held = 0;
  for (const c of chars) {
    const value = ALPHABET.indexOf(c);
    if (value < 0) return null;
    held = (held << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bytes.push((held >> (bits - 8)) & 255);
      bits -= 8;
      held &= (1 << bits) - 1;
    }
  }
  // What is left are the spare bits, and they must be zero.
  if (bits !== SPARE_BITS || held !== 0) return null;
  const seed = Uint8Array.from(bytes.slice(0, SEED_BYTES));
  const sum = checksum(seed);
  return bytes[SEED_BYTES] === sum[0] && bytes[SEED_BYTES + 1] === sum[1] ? seed : null;
}

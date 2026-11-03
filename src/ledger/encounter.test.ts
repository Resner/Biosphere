import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { canonicalize } from './canonical';
import { ENC_ID_DOMAIN, ENC_SEED_DOMAIN, encounterId, encounterSeed, seedWords } from './encounter';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);

describe('encounterId', () => {
  it('hashes the sorted head hashes and the lock time under its domain', () => {
    const expected = bytesToHex(
      sha256(
        new TextEncoder().encode(`${ENC_ID_DOMAIN}\n${canonicalize({ heads: [A, B], t: 7 })}`),
      ),
    );
    expect(encounterId([B, A], 7)).toBe(expected);
    expect(encounterId([A, B], 7)).toBe(expected);
    expect(encounterId([A, B], 8)).not.toBe(expected);
  });
});

describe('encounterSeed', () => {
  it('is SHA-256 of the domain, the randomness and the id bytes', () => {
    const id = encounterId([A, B], 1);
    const randomness = new Uint8Array(32).fill(9);
    const tag = new TextEncoder().encode(ENC_SEED_DOMAIN);
    const input = new Uint8Array([...tag, ...randomness, ...hexToBytes(id)]);
    expect(encounterSeed(randomness, id)).toBe(bytesToHex(sha256(input)));
  });

  it('takes empty randomness when no beacon is known', () => {
    const id = encounterId([A, B], 1);
    const tag = new TextEncoder().encode(ENC_SEED_DOMAIN);
    const input = new Uint8Array([...tag, ...hexToBytes(id)]);
    expect(encounterSeed(new Uint8Array(0), id)).toBe(bytesToHex(sha256(input)));
    expect(encounterSeed(new Uint8Array(0), id)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('gives the simulation four words from the first 16 bytes', () => {
    expect(seedWords(`0000000100000002ffffffff80000000${'0'.repeat(32)}`)).toEqual([
      1, 2, 0xffffffff, 0x80000000,
    ]);
  });
});

import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { decodeRecoveryCode, encodeRecoveryCode } from './recovery';

const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const text = (s: string) => new TextEncoder().encode(s);

const zeroSeed = new Uint8Array(32);
const counterSeed = Uint8Array.from({ length: 32 }, (_, i) => i);
// A fixed pseudo-random seed (an LCG), so the golden is stable without any entropy.
const randomSeed = (() => {
  let x = 0x2545f491;
  return Uint8Array.from({ length: 32 }, () => {
    x = (Math.imul(x, 1664525) + 1013904223) >>> 0;
    return x >>> 24;
  });
})();

/** An independent reference: the checksummed bytes as one big number, five bits at a time. */
function reference(seed: Uint8Array): string {
  const sum = sha256(new Uint8Array([...text('bs/recovery/v1\n'), ...seed])).slice(0, 2);
  let n = 0n;
  for (const b of [...seed, ...sum]) n = (n << 8n) | BigInt(b);
  n <<= 3n;
  let out = '';
  for (let i = 54; i >= 0; i--) out += ALPHABET[Number((n >> BigInt(i * 5)) & 31n)];
  return out.match(/.{5}/g)?.join('-') ?? '';
}

const GOLDEN: [string, Uint8Array, string][] = [
  ['zero', zeroSeed, '00000-00000-00000-00000-00000-00000-00000-00000-00000-00000-07P2R'],
  ['counter', counterSeed, '000G4-0R40M-30E20-9185G-R38E1-W8124-GK2GA-HC5RR-34D1P-70X3R-FGTRG'],
  ['random', randomSeed, 'WA6HQ-62XBS-6XTPC-RWDK5-ZA50S-Y83MG-MHRJP-NQGG9-JMYYX-KZEDD-9DWD8'],
];

describe('recovery code', () => {
  it('is 11 groups of 5 Crockford characters', () => {
    const code = encodeRecoveryCode(counterSeed);
    expect(code).toMatch(/^([0-9A-HJKMNP-TV-Z]{5}-){10}[0-9A-HJKMNP-TV-Z]{5}$/);
    expect(code.replaceAll('-', '')).toHaveLength(55);
  });

  for (const [name, seed, golden] of GOLDEN) {
    it(`matches the reference and the golden for the ${name} seed`, () => {
      const code = encodeRecoveryCode(seed);
      expect(code).toBe(reference(seed));
      expect(code).toBe(golden);
      expect(decodeRecoveryCode(code)).toEqual(seed);
    });

    it(`rejects every single-character change of the ${name} code`, () => {
      const plain = encodeRecoveryCode(seed).replaceAll('-', '');
      let tried = 0;
      for (let i = 0; i < plain.length; i++) {
        for (const c of ALPHABET) {
          if (c === plain[i]) continue;
          tried++;
          const changed = plain.slice(0, i) + c + plain.slice(i + 1);
          // A change that passed the 16-bit checksum would mean this golden seed is unlucky.
          expect(decodeRecoveryCode(changed), `${i}:${c}`).toBeNull();
        }
      }
      expect(tried).toBe(55 * 31);
    });
  }

  it('reads lower case, extra spaces and dashes, and I, L and O for 1 and 0', () => {
    const seed = randomSeed;
    const code = encodeRecoveryCode(seed);
    expect(decodeRecoveryCode(code.toLowerCase())).toEqual(seed);
    expect(decodeRecoveryCode(` ${code.replaceAll('-', ' - ')}  `)).toEqual(seed);
    expect(decodeRecoveryCode(code.replaceAll('-', ''))).toEqual(seed);
    const confusable = code.replaceAll('1', 'I').replaceAll('0', 'O');
    expect(decodeRecoveryCode(confusable)).toEqual(seed);
    expect(decodeRecoveryCode(code.replaceAll('1', 'l').replaceAll('0', 'o'))).toEqual(seed);
  });

  it('ignores typographic dashes and invisible characters from pasted text', () => {
    const code = encodeRecoveryCode(randomSeed);
    expect(decodeRecoveryCode(code.replaceAll('-', '\u2013'))).toEqual(randomSeed);
    expect(decodeRecoveryCode(code.replaceAll('-', '\u200b-'))).toEqual(randomSeed);
  });

  it('round-trips many seeds', () => {
    for (let i = 0; i < 200; i++) {
      const seed = sha256(text(`seed-${i}`));
      expect(decodeRecoveryCode(encodeRecoveryCode(seed))).toEqual(seed);
    }
  });

  it('rejects spare bits, a missing group, an extra group, other lengths and bad characters', () => {
    const groups = encodeRecoveryCode(counterSeed).split('-');
    const last = groups[10] as string;
    // The last character's low 3 bits are spare: setting one is not a code, whatever the checksum.
    const spare = ALPHABET[ALPHABET.indexOf(last.slice(-1)) | 1];
    expect(
      decodeRecoveryCode([...groups.slice(0, 10), last.slice(0, 4) + spare].join('-')),
    ).toBeNull();
    expect(decodeRecoveryCode(groups.slice(0, 10).join('-'))).toBeNull();
    expect(decodeRecoveryCode([...groups, 'AAAAA'].join('-'))).toBeNull();
    expect(decodeRecoveryCode(groups.join('-').slice(0, -1))).toBeNull();
    expect(decodeRecoveryCode(`${groups.join('-')}0`)).toBeNull();
    expect(decodeRecoveryCode('')).toBeNull();
    expect(decodeRecoveryCode(groups.join('-').replace('-', '+'))).toBeNull();
    expect(decodeRecoveryCode(groups.join('-').replace(/^./, 'U'))).toBeNull();
    expect(decodeRecoveryCode(groups.join('-').replace(/^./, 'é'))).toBeNull();
  });

  it('throws on a seed of the wrong length', () => {
    expect(() => encodeRecoveryCode(new Uint8Array(31))).toThrow(RangeError);
  });
});

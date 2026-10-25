// Seeded randomness (ADR 0005): xoshiro128** streams, one per purpose, plus a stateless integer hash.

import { fmix } from './hash';

export type Seed = readonly [number, number, number, number]; // four u32

export interface Rng {
  nextU32(): number;
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [lo, hi). */
  range(lo: number, hi: number): number;
  /** Uniform integer in [lo, hi], both inclusive. */
  int(lo: number, hi: number): number;
}

const encoder = new TextEncoder();
const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

/** Stateless murmur3-style hash of any number of integers. */
export function hashU32(...values: number[]): number {
  let h = 0x9e3779b9;
  for (const v of values) {
    let k = Math.imul(v | 0, 0xcc9e2d51);
    k = Math.imul(rotl(k, 15), 0x1b873593);
    h ^= k;
    h = (Math.imul(rotl(h, 13), 5) + 0xe6546b64) | 0;
  }
  return fmix(h ^ values.length);
}

export function seedFromBytes(bytes: Uint8Array): Seed {
  // Four FNV-1a lanes with distinct offset bases, finalised through the integer hash.
  const lanes = [0x811c9dc5, 0x9747b28c, 0x2545f491, 0xc2b2ae3d];
  for (const byte of bytes) {
    for (let i = 0; i < 4; i++) {
      lanes[i] = Math.imul((lanes[i] as number) ^ (byte + i), 0x01000193);
    }
  }
  const n = bytes.length;
  return [
    hashU32(lanes[0] as number, n, 0),
    hashU32(lanes[1] as number, n, 1),
    hashU32(lanes[2] as number, n, 2),
    hashU32(lanes[3] as number, n, 3),
  ];
}

export function seedFromString(text: string): Seed {
  return seedFromBytes(encoder.encode(text));
}

export function createRng(seed: Seed, purpose: string): Rng {
  const purposeHash = seedFromString(purpose);
  let sm = hashU32(...seed, purposeHash[0], purposeHash[1]);
  const splitmix32 = (): number => {
    sm = (sm + 0x9e3779b9) | 0;
    return fmix(sm);
  };
  let s0 = splitmix32();
  let s1 = splitmix32();
  let s2 = splitmix32();
  let s3 = splitmix32();
  if ((s0 | s1 | s2 | s3) === 0) s0 = 1;

  const nextU32 = (): number => {
    const result = Math.imul(rotl(Math.imul(s1, 5), 7), 9) >>> 0;
    const t = s1 << 9;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= t;
    s3 = rotl(s3, 11);
    return result;
  };
  const next = (): number => nextU32() / 4294967296;
  return {
    nextU32,
    next,
    range: (lo, hi) => lo + next() * (hi - lo),
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
  };
}

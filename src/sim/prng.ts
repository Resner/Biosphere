// Seeded randomness (ADR 0005): xoshiro128** streams, one per purpose, plus a stateless integer hash.

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

const rotl = (x: number, k: number): number => (x << k) | (x >>> (32 - k));

function fmix(h0: number): number {
  let h = h0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x85ebca6b);
  h ^= h >>> 13;
  h = Math.imul(h, 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

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
  return seedFromBytes(new TextEncoder().encode(text));
}

function splitmix32(state: { s: number }): number {
  state.s = (state.s + 0x9e3779b9) | 0;
  let z = state.s;
  z = Math.imul(z ^ (z >>> 16), 0x85ebca6b);
  z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35);
  return (z ^ (z >>> 16)) >>> 0;
}

export function createRng(seed: Seed, purpose: string): Rng {
  const purposeHash = seedFromString(purpose);
  const sm = { s: hashU32(seed[0], seed[1], seed[2], seed[3], purposeHash[0], purposeHash[1]) };
  let s0 = splitmix32(sm);
  let s1 = splitmix32(sm);
  let s2 = splitmix32(sm);
  let s3 = splitmix32(sm);
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

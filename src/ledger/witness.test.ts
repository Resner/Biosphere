import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { PINNED_ORDER, PINNED_POOL, pinnedOrder } from '../../tests/witness-order-table';
import { createRng, seedFromString } from '../sim/prng';
import { roundTime } from './drand-time';
import {
  createIdentity,
  fromBase64Url,
  type Identity,
  memoryKeyStore,
  toBase64Url,
} from './identity';
import { keyVerifier } from './key-verify';
import {
  type Attestation,
  attestationSigned,
  birthSubject,
  dutyEvent,
  firstPosition,
  inputBytes,
  inputSigned,
  POOL_MAX,
  parseDutyEvent,
  parseSignedAttestation,
  poolOf,
  signAttestation,
  signInput,
  signWitnessFrame,
  WITNESS_MARGIN_MS,
  witnessDataProblems,
  witnessFrameBytes,
  witnessFrameSigned,
  witnessOrder,
  witnessRound,
} from './witness';

const rng = createRng(seedFromString('witness-docs'), 'cases');
const hex = (n = 32) => bytesToHex(Uint8Array.from({ length: n }, () => rng.int(0, 255)));
const seeded = (n: number) => createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)));
const ids = (n: number, tag = 'id') =>
  Array.from({ length: n }, (_, i) => toBase64Url(sha256(new TextEncoder().encode(`${tag}${i}`))));

const ENC = 'c3'.repeat(32);

describe('duty events', () => {
  it('names a kind and a 64-hex id, and parses back', () => {
    const id = hex();
    expect(dutyEvent('enc', id)).toBe(`enc:${id}`);
    for (const kind of ['enc', 'mating', 'genesis'] as const)
      expect(parseDutyEvent(dutyEvent(kind, id))).toEqual({ kind, id });
    expect(() => dutyEvent('enc', 'xyz')).toThrow(RangeError);
    for (const bad of ['', 'enc', `fight:${id}`, `enc:${id.toUpperCase()}`, `enc:${id}0`, 7, null])
      expect(parseDutyEvent(bad)).toBeNull();
  });
});

describe('poolOf', () => {
  const event = dutyEvent('enc', ENC);
  it('cuts 40 eligible to 16, sorted, the same per event and different for another', () => {
    const all = ids(40);
    const pool = poolOf(all, event);
    expect(pool).toHaveLength(POOL_MAX);
    expect(pool).toEqual([...pool].sort());
    expect(new Set(pool).size).toBe(16);
    expect(poolOf([...all].reverse(), event)).toEqual(pool);
    expect(poolOf(all, dutyEvent('enc', 'd4'.repeat(32)))).not.toEqual(pool);
  });
  it('keeps the 16 with the lowest pool hash', () => {
    const all = ids(40);
    const key = (id: string) =>
      bytesToHex(sha256(new TextEncoder().encode(`bs/pool/v1${event}${id}`)));
    const lowest = [...all].sort((a, b) => (key(a) < key(b) ? -1 : 1)).slice(0, 16);
    expect(poolOf(all, event)).toEqual(lowest.sort());
  });
  it('gives all of 5, sorted, and counts duplicates once', () => {
    const five = ids(5);
    expect(poolOf(five, event)).toEqual([...five].sort());
    expect(poolOf([...five, ...five, five[0] as string], event)).toEqual([...five].sort());
    expect(poolOf([], event)).toEqual([]);
  });
});

describe('witnessRound', () => {
  it('names the first round due at least 500 ms ahead', () => {
    expect(WITNESS_MARGIN_MS).toBe(500);
    for (let n = 0; n < 200; n++) {
      const t = roundTime(33_409_837) + rng.int(-10_000, 10_000);
      const r = witnessRound(t);
      expect(roundTime(r)).toBeGreaterThanOrEqual(t + 500);
      expect(roundTime(r - 1)).toBeLessThan(t + 500);
    }
  });
  it('takes a round exactly 500 ms ahead, and the next at 499', () => {
    const r = 33_409_900;
    expect(witnessRound(roundTime(r) - 500)).toBe(r);
    expect(witnessRound(roundTime(r) - 499)).toBe(r + 1);
  });
});

describe('witnessOrder', () => {
  const pool = ids(16).sort();
  it('is a permutation, the same for the same inputs, different for another beacon or commit', () => {
    const randomness = sha256(new Uint8Array([1]));
    const commit = hex();
    const order = witnessOrder(pool, randomness, commit);
    expect([...order].sort()).toEqual(pool);
    expect(witnessOrder(pool, randomness, commit)).toEqual(order);
    expect(witnessOrder(pool, sha256(new Uint8Array([2])), commit)).not.toEqual(order);
    expect(witnessOrder(pool, randomness, hex())).not.toEqual(order);
    expect(witnessOrder([], randomness, commit)).toEqual([]);
    expect(witnessOrder(pool.slice(0, 1), randomness, commit)).toEqual(pool.slice(0, 1));
    expect(() => witnessOrder(pool, randomness, 'not hex')).toThrow(RangeError);
  });
  it('puts each of 16 first 6.25% ± 0.8% of the time over 10,000 beacons', () => {
    const firsts = new Map<string, number>();
    const commit = hex();
    for (let n = 0; n < 10_000; n++) {
      const randomness = sha256(new TextEncoder().encode(`beacon-${n}`));
      const first = witnessOrder(pool, randomness, commit)[0] as string;
      firsts.set(first, (firsts.get(first) ?? 0) + 1);
    }
    expect(firsts.size).toBe(16);
    for (const count of firsts.values()) {
      expect(count / 10_000).toBeGreaterThanOrEqual(0.0625 - 0.008);
      expect(count / 10_000).toBeLessThanOrEqual(0.0625 + 0.008);
    }
  });
  it('matches the pinned order for the first recorded beacon', () => {
    expect(PINNED_POOL).toHaveLength(16);
    expect(PINNED_ORDER).toHaveLength(16);
    expect(pinnedOrder()).toEqual(PINNED_ORDER);
  });
});

describe('firstPosition', () => {
  it('gives an encounter referee 0 and auditor 1, and births and hatches auditor 0 alone', () => {
    expect(firstPosition('enc', 'referee')).toBe(0);
    expect(firstPosition('enc', 'auditor')).toBe(1);
    for (const kind of ['mating', 'genesis'] as const) {
      expect(firstPosition(kind, 'auditor')).toBe(0);
      expect(firstPosition(kind, 'referee')).toBeNull();
    }
  });
});

describe('witnessDataProblems', () => {
  const event = dutyEvent('enc', ENC);
  const pool = ids(16).sort();
  it('accepts a sorted, unique pool of at most 16 player ids', () => {
    expect(witnessDataProblems({ event, pool })).toEqual([]);
    expect(
      witnessDataProblems({ event: dutyEvent('mating', ENC), pool: pool.slice(0, 1) }),
    ).toEqual([]);
  });
  it('refuses a bad event, an unsorted, repeated, long or empty pool, a bad id and other fields', () => {
    const bad: unknown[] = [
      null,
      7,
      [],
      { pool },
      { event: 'enc:zz', pool },
      { event },
      { event, pool: 'x' },
      { event, pool: [...pool].reverse() },
      { event, pool: [pool[0], pool[0]] },
      { event, pool: [...ids(17).sort()] },
      { event, pool: [] },
      { event, pool: ['not-an-id'] },
      { event, pool: [3] },
      { event, pool, extra: 1 },
    ];
    for (const v of bad) expect(witnessDataProblems(v), JSON.stringify(v)).not.toEqual([]);
  });
});

describe('attestations', () => {
  let witness: Identity;
  const base = async (): Promise<Attestation> => {
    witness = await seeded(9);
    return {
      v: 1,
      kind: 'attest',
      event: dutyEvent('enc', ENC),
      duty: 'b7'.repeat(32),
      position: 1,
      witness: witness.playerId,
      subject: 'e1'.repeat(32),
      agree: true,
    };
  };

  it('signs and verifies, and a changed field or a flipped signature byte fails', async () => {
    const a = await base();
    const signed = signAttestation(witness, a);
    expect(attestationSigned(signed)).toBe(true);
    expect(parseSignedAttestation(JSON.parse(JSON.stringify(signed)))).toEqual(signed);
    const changes: Partial<Attestation>[] = [
      { event: dutyEvent('enc', 'c4'.repeat(32)) },
      { duty: 'b8'.repeat(32) },
      { position: 2 },
      { witness: (await seeded(10)).playerId },
      { subject: 'e2'.repeat(32) },
      { agree: false },
    ];
    for (const change of changes)
      expect(attestationSigned({ ...signed, attestation: { ...a, ...change } })).toBe(false);
    const sig = fromBase64Url(signed.sig) as Uint8Array;
    sig[5] = (sig[5] as number) ^ 1;
    expect(attestationSigned({ ...signed, sig: toBase64Url(sig) })).toBe(false);
  });

  it('carries a code only beside a disagreement', async () => {
    const a = { ...(await base()), agree: false, code: 'root' };
    const signed = signAttestation(witness, a);
    expect(attestationSigned(signed)).toBe(true);
    expect(parseSignedAttestation(signed)).toEqual(signed);
    expect(parseSignedAttestation({ ...signed, attestation: { ...a, agree: true } })).toBeNull();
  });

  it('refuses unknown fields, non-hex ids, a position above 15 and a bad signature', async () => {
    const a = await base();
    const signed = signAttestation(witness, a);
    const bad: unknown[] = [
      { ...signed, extra: 1 },
      { ...signed, attestation: { ...a, extra: 1 } },
      { ...signed, attestation: { ...a, v: 2 } },
      { ...signed, attestation: { ...a, kind: 'settlement' } },
      { ...signed, attestation: { ...a, duty: 'B7'.repeat(32) } },
      { ...signed, attestation: { ...a, subject: 'e1' } },
      { ...signed, attestation: { ...a, event: 'enc:nothex' } },
      { ...signed, attestation: { ...a, witness: 'not-a-player' } },
      { ...signed, attestation: { ...a, position: 16 } },
      { ...signed, attestation: { ...a, position: -1 } },
      { ...signed, attestation: { ...a, position: 1.5 } },
      { ...signed, attestation: { ...a, agree: 1 } },
      { ...signed, attestation: { ...a, agree: false, code: '' } },
      { ...signed, attestation: { ...a, agree: false, code: 'x'.repeat(65) } },
      { ...signed, sig: 'abc' },
      { attestation: a },
      { sig: signed.sig },
      null,
      'attest',
    ];
    for (const v of bad) expect(parseSignedAttestation(v), JSON.stringify(v)).toBeNull();
  });

  it('never throws on 10,000 fuzzed values', async () => {
    const signed = signAttestation(witness, await base());
    const pick = <T>(xs: readonly T[]): T => xs[rng.int(0, xs.length - 1)] as T;
    const atoms: unknown[] = [null, undefined, 0, -1, 16, 1e300, Number.NaN, '', 'x', true, [], {}];
    const mutate = (v: unknown, depth: number): unknown => {
      if (depth > 3 || rng.next() < 0.2) return pick(atoms);
      if (v && typeof v === 'object' && !Array.isArray(v)) {
        const out: Record<string, unknown> = { ...(v as Record<string, unknown>) };
        const keys = Object.keys(out);
        const key = keys.length && rng.next() < 0.8 ? pick(keys) : `k${rng.int(0, 3)}`;
        if (rng.next() < 0.2) delete out[key];
        else out[key] = mutate(out[key], depth + 1);
        return out;
      }
      return pick(atoms);
    };
    for (let n = 0; n < 10_000; n++) {
      const v = mutate(signed, 0);
      expect(() => parseSignedAttestation(v)).not.toThrow();
      const parsed = parseSignedAttestation(v);
      if (parsed) expect(() => attestationSigned(parsed)).not.toThrow();
    }
  });

  it('subjects a birth by both hashes in slot order', () => {
    const [a, b] = ['01'.repeat(32), '02'.repeat(32)];
    expect(birthSubject(a, b)).toMatch(/^[0-9a-f]{64}$/);
    expect(birthSubject(a, b)).not.toBe(birthSubject(b, a));
    expect(() => birthSubject(a, 'nope')).toThrow(RangeError);
  });
});

describe('signed inputs', () => {
  it('pins inputBytes at 49 bytes: the tag, the encounter, u16 frame, u32 code', () => {
    const bytes = inputBytes(ENC, 0x0102, 0x0a0b0c0d);
    expect(bytes).toHaveLength(49);
    expect(new TextDecoder().decode(bytes.subarray(0, 11))).toBe('bs/input/v1');
    expect(bytesToHex(bytes.subarray(11))).toBe(`${ENC}01020a0b0c0d`);
    expect(() => inputBytes('zz', 1, 1)).toThrow(RangeError);
    expect(() => inputBytes(ENC, 65_536, 1)).toThrow(RangeError);
    expect(() => inputBytes(ENC, 1, 2 ** 32)).toThrow(RangeError);
  });

  it('verifies, and another frame, code, encounter or key fails', async () => {
    const fighter = await seeded(3);
    const other = await seeded(4);
    const key = keyVerifier(fighter.playerId);
    const otherKey = keyVerifier(other.playerId);
    if (!key || !otherKey) throw new Error('real keys');
    const sig = signInput(fighter, ENC, 40, 77);
    expect(inputSigned(key, ENC, 40, 77, sig)).toBe(true);
    expect(inputSigned(key, ENC, 41, 77, sig)).toBe(false);
    expect(inputSigned(key, ENC, 40, 78, sig)).toBe(false);
    expect(inputSigned(key, 'c4'.repeat(32), 40, 77, sig)).toBe(false);
    expect(inputSigned(otherKey, ENC, 40, 77, sig)).toBe(false);
    expect(inputSigned(key, ENC, 40, 77, 'not base64!')).toBe(false);
    expect(inputSigned(key, 'zz', 40, 77, sig)).toBe(false);
    expect(inputSigned(key, ENC, -1, 77, sig)).toBe(false);
  });
});

describe('witness frames', () => {
  it('tells a null from a code 0, and verifies and fails as inputs do', async () => {
    const w = await seeded(6);
    const other = await seeded(7);
    expect(witnessFrameBytes(ENC, 5, [null, 1])).not.toEqual(witnessFrameBytes(ENC, 5, [0, 1]));
    expect(new TextDecoder().decode(witnessFrameBytes(ENC, 5, [1]).subarray(0, 12))).toBe(
      'bs/wframe/v1',
    );
    const sig = signWitnessFrame(w, ENC, 5, [null, 1]);
    expect(witnessFrameSigned(w.playerId, ENC, 5, [null, 1], sig)).toBe(true);
    expect(witnessFrameSigned(w.playerId, ENC, 5, [0, 1], sig)).toBe(false);
    expect(witnessFrameSigned(w.playerId, ENC, 6, [null, 1], sig)).toBe(false);
    expect(witnessFrameSigned(w.playerId, 'c4'.repeat(32), 5, [null, 1], sig)).toBe(false);
    expect(witnessFrameSigned(other.playerId, ENC, 5, [null, 1], sig)).toBe(false);
    expect(witnessFrameSigned('nobody', ENC, 5, [null, 1], sig)).toBe(false);
    expect(witnessFrameSigned(w.playerId, ENC, 5, [1.5], sig)).toBe(false);
  });
});

describe('speed', () => {
  speedTest('checks 40 input signatures through one tabled key in under 40 ms', async () => {
    const fighter = await seeded(11);
    const key = keyVerifier(fighter.playerId);
    if (!key) throw new Error('a real key');
    const sigs = Array.from({ length: 40 }, (_, f) => signInput(fighter, ENC, f, f * 7));
    inputSigned(key, ENC, 0, 0, sigs[0] as string);
    const t0 = performance.now();
    for (let f = 0; f < 40; f++)
      expect(inputSigned(key, ENC, f, f * 7, sigs[f] as string)).toBe(true);
    expect(performance.now() - t0).toBeLessThan(40);
  });
});

import { sha256 } from '@noble/hashes/sha2.js';
import { describe, expect, it } from 'vitest';
import { heavyTest, speedTest } from '../../tests/heavy';
import type { PeerEvent, Pos } from '../net/protocol-defs';
import { createRng, seedFromString } from '../sim/prng';
import {
  createIdentity,
  fromBase64Url,
  type Identity,
  memoryKeyStore,
  toBase64Url,
} from './identity';
import { authorityKeyId, authorityPublicKey, type PubKey } from './record';
import {
  SEAT_SKEW_MS,
  SEAT_TTL_MS,
  type Seat,
  SIGNAL_DOMAIN,
  type SignedSeat,
  seatValid,
  signalBytes,
  signalSigned,
  signSeat,
  signSignal,
} from './seat';

// Seat tickets and signed signals (M11 T7, ADR 0062): what a peer checks in a `hello` and a `relay`.

const secret = new Uint8Array(32).fill(7);
const other = new Uint8Array(32).fill(9);
const keyOf = (s: Uint8Array): PubKey => {
  const publicKey = authorityPublicKey(s);
  return { id: authorityKeyId(publicKey), publicKey };
};
const keys = [keyOf(secret)];
const T = 1_700_000_000_000;
const PLAYER = authorityPublicKey(new Uint8Array(32).fill(3));
const seat: Seat = {
  v: 1,
  kind: 'seat',
  player: PLAYER,
  name: 'Alice_9',
  world: 'w0rldSeed_123456',
  t: T,
  until: T + SEAT_TTL_MS,
};
const want = { world: seat.world, player: PLAYER, now: T + 1000 };
const flip = (sig: string, at: number): string => {
  const b = fromBase64Url(sig) as Uint8Array;
  b[at] = (b[at] as number) ^ 1;
  return toBase64Url(b);
};

describe('seat tickets', () => {
  const signed = signSeat(secret, seat);

  it('a signed ticket verifies under its key', () => {
    expect(signed.keyId).toBe(keys[0]?.id);
    expect(seatValid(signed, keys, want)).toBe(true);
    // Through JSON, as a peer gets it.
    expect(seatValid(JSON.parse(JSON.stringify(signed)) as SignedSeat, keys, want)).toBe(true);
  });

  it('a changed field, another world or player, an expired ticket or a flipped byte fails', () => {
    for (const over of [
      { name: 'Mallory' },
      { player: authorityPublicKey(other) },
      { t: T - 1 },
      { until: T + SEAT_TTL_MS + 1 },
      { world: 'elsewhere' },
    ]) {
      expect(
        seatValid({ ...signed, seat: { ...seat, ...over } }, keys, want),
        JSON.stringify(over),
      ).toBe(false);
    }
    expect(seatValid(signed, keys, { ...want, world: 'elsewhere' })).toBe(false);
    expect(seatValid(signed, keys, { ...want, player: authorityPublicKey(other) })).toBe(false);
    expect(seatValid(signed, keys, { ...want, now: seat.until })).toBe(false);
    expect(seatValid(signed, keys, { ...want, now: seat.until - 1 })).toBe(true);
    for (const at of [0, 31, 32, 63])
      expect(seatValid({ ...signed, authSig: flip(signed.authSig, at) }, keys, want)).toBe(false);
  });

  it('a ticket dated more than 30 s ahead of the clock fails', () => {
    expect(seatValid(signed, keys, { ...want, now: T - SEAT_SKEW_MS })).toBe(true);
    expect(seatValid(signed, keys, { ...want, now: T - SEAT_SKEW_MS - 1 })).toBe(false);
  });

  it('needs a listed key whose id derives from it', () => {
    expect(seatValid(signed, [], want)).toBe(false);
    expect(seatValid(signed, [keyOf(other)], want)).toBe(false);
    // Another key listed under this key's id.
    expect(seatValid(signed, [{ ...keyOf(other), id: signed.keyId }], want)).toBe(false);
    // Signed by another key that names this one's id.
    expect(seatValid({ ...signSeat(other, seat), keyId: signed.keyId }, keys, want)).toBe(false);
    expect(seatValid(signSeat(other, seat), [...keys, keyOf(other)], want)).toBe(true);
  });

  it('never throws on 10,000 fuzzed values', () => {
    const rng = createRng(seedFromString('fuzz-seat-valid'), 'net');
    const atoms = [0, -1, 1.5, '', 'x', PLAYER, signed.authSig, null, true, [], {}, 1e308, T];
    const pick = <X>(xs: readonly X[]): X => xs[rng.int(0, xs.length - 1)] as X;
    let passed = 0;
    for (let i = 0; i < 10_000; i++) {
      const v = structuredClone(signed) as unknown as Record<string, Record<string, unknown>>;
      const at = rng.int(0, 1) ? v : (v.seat as Record<string, unknown>);
      const key = pick([...Object.keys(at), 'extra']);
      const r = rng.int(0, 4);
      if (r === 0) delete at[key];
      else if (r === 1) (at as Record<string, unknown>)[key] = pick(atoms);
      const input = r === 3 ? pick(atoms) : v;
      const ks =
        r === 4 ? ([pick(atoms), { id: pick(atoms), publicKey: pick(atoms) }] as PubKey[]) : keys;
      if (seatValid(input as unknown as SignedSeat, ks, want)) passed++;
    }
    expect(passed).toBeGreaterThan(0);
    for (const v of [undefined, null, 'x', [], Object.create(null)])
      expect(seatValid(v as SignedSeat, keys, want)).toBe(false);
    expect(seatValid(signed, null as unknown as PubKey[], want)).toBe(false);
  });
});

const alice: Identity = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(1)));
const bob: Identity = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(2)));

describe('signed signals', () => {
  const pos: Pos = [131_072.5, 99_000.125, 12.5];
  const sdp = 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n';
  const relay = (over: Partial<Extract<PeerEvent, { t: 'relay' }>> = {}) => ({
    t: 'relay' as const,
    from: alice.playerId,
    to: bob.playerId,
    kind: 'offer' as const,
    sdp,
    cls: 2 as const,
    at: T,
    pos,
    sig: signSignal(alice, bob.playerId, 'offer', 2, T, pos, sdp),
    ...over,
  });

  it('pins the signed bytes: 32 + 32 + 1 + 1 + 8 + 24 + 32 after the domain', () => {
    const bytes = signalBytes(alice.playerId, bob.playerId, 'answer', 3, T, pos, sdp);
    const tag = new TextEncoder().encode(SIGNAL_DOMAIN);
    expect(bytes.length).toBe(tag.length + 32 + 32 + 1 + 1 + 8 + 24 + 32);
    expect(bytes.subarray(0, tag.length)).toEqual(tag);
    let o = tag.length;
    expect(bytes.subarray(o, o + 32)).toEqual(fromBase64Url(alice.playerId));
    expect(bytes.subarray(o + 32, o + 64)).toEqual(fromBase64Url(bob.playerId));
    o += 64;
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    expect(view.getUint8(o)).toBe(1);
    expect(view.getUint8(o + 1)).toBe(3);
    expect(view.getBigUint64(o + 2)).toBe(BigInt(T));
    expect([0, 1, 2].map((i) => view.getFloat64(o + 10 + 8 * i))).toEqual(pos);
    expect(bytes.subarray(o + 34)).toEqual(sha256(new TextEncoder().encode(sdp)));
    expect(signalBytes(alice.playerId, bob.playerId, 'offer', 3, T, pos, sdp)[o]).toBe(0);
    expect(signalBytes(alice.playerId, bob.playerId, 'refuse', 3, T, pos, '')[o]).toBe(2);
    expect(() => signalBytes(alice.playerId, bob.playerId, 'offer', 5 as 0, T, pos, sdp)).toThrow(
      RangeError,
    );
  });

  it('a signature verifies; another to, kind, class, at, pos, sdp byte or key fails', () => {
    expect(signalSigned(relay())).toBe(true);
    expect(signalSigned(relay({ to: alice.playerId }))).toBe(false);
    expect(signalSigned(relay({ kind: 'answer' }))).toBe(false);
    expect(signalSigned(relay({ cls: 1 }))).toBe(false);
    expect(signalSigned(relay({ at: T + 1 }))).toBe(false);
    expect(signalSigned(relay({ pos: [pos[0], pos[1], 12.75] }))).toBe(false);
    expect(signalSigned(relay({ pos: [pos[0] + 0.125, pos[1], pos[2]] }))).toBe(false);
    expect(signalSigned(relay({ sdp: sdp.replace('127', '128') }))).toBe(false);
    expect(signalSigned(relay({ from: bob.playerId }))).toBe(false);
    expect(signalSigned(relay({ sig: signSignal(bob, bob.playerId, 'offer', 2, T, pos, sdp) }))).toBe(
      false,
    );
    const sig = relay().sig;
    expect(signalSigned(relay({ sig: flip(sig, 5) }))).toBe(false);
  });

  // About 3,000 of them verify a signature: seconds.
  heavyTest('never throws on 10,000 fuzzed values', () => {
    const rng = createRng(seedFromString('fuzz-signal'), 'net');
    const base = relay();
    const atoms = [
      0,
      -1,
      1.5,
      '',
      'x',
      alice.playerId,
      base.sig,
      null,
      [],
      {},
      NaN,
      2 ** 64,
      [1, 2],
    ];
    const pick = <X>(xs: readonly X[]): X => xs[rng.int(0, xs.length - 1)] as X;
    let passed = 0;
    for (let i = 0; i < 10_000; i++) {
      const v: Record<string, unknown> = { ...base };
      const key = pick(Object.keys(v));
      const r = rng.int(0, 2);
      if (r === 0) delete v[key];
      else if (r === 1) v[key] = pick(atoms);
      if (signalSigned((r === 2 && rng.int(0, 3) === 0 ? pick(atoms) : v) as typeof base)) passed++;
    }
    expect(passed).toBeGreaterThan(0);
    expect(() => signalBytes('x', bob.playerId, 'offer', 2, T, pos, sdp)).toThrow(RangeError);
  });

  // A signal is checked under its sender's key, which nobody tables (about 1.3 ms in Node, the
  // cost of one plain Ed25519 check), and a ticket under the authority's tabled one (about 0.4 ms).
  speedTest('20 ticket checks and 20 signal checks take under 60 ms', () => {
    const tickets = Array.from({ length: 20 }, (_, i) =>
      signSeat(secret, { ...seat, player: authorityPublicKey(new Uint8Array(32).fill(i + 10)) }),
    );
    const signals = Array.from({ length: 20 }, (_, i) =>
      relay({ at: T + i, sig: signSignal(alice, bob.playerId, 'offer', 2, T + i, pos, sdp) }),
    );
    const checkAll = () =>
      tickets.every((s) => seatValid(s, keys, { ...want, player: s.seat.player })) &&
      signals.every(signalSigned);
    // Warm, as a page in play is: it tables the authority's key at its first ticket, and its
    // checks are compiled by then. The budget is for one round of 40, on average over 5.
    for (let i = 0; i < 3; i++) expect(checkAll()).toBe(true);
    const runs = 5;
    const started = performance.now();
    for (let i = 0; i < runs; i++) expect(checkAll()).toBe(true);
    const ms = (performance.now() - started) / runs;
    expect(ms).toBeLessThan(60);
  });
});

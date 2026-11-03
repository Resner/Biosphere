import { describe, expect, it } from 'vitest';
import { encodeSnapshot, SIGNED_FRAME_BYTES, SNAPSHOT_BYTES, type Snapshot } from '../net/protocol';
import { createRng, seedFromString } from '../sim/prng';
import { createIdentity, fromBase64Url, memoryKeyStore, toBase64Url, verify } from './identity';
import {
  decodeStateFrame,
  encodeSignedFrame,
  SNAP_DOMAIN,
  signSnap,
  verifySnap,
} from './snapshot-sig';

const POND = 'p1';
const snap: Snapshot = {
  seq: 9,
  tick: 4321,
  x: 4100.5,
  y: 3900.25,
  heading: 1.5,
  vx: 12,
  vy: -4,
  biomass: 420,
  energy: 0.6,
  health: 0.9,
  alive: true,
  dashing: false,
  ready: false,
  egg: true,
  spawnProtected: true,
  fighting: false,
  genomeRef: 0xcafe,
};

const seeded = (n: number) => createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)));
const flip = (text: string, bit: number): string => {
  const bytes = fromBase64Url(text) as Uint8Array;
  bytes[bit >> 3] = (bytes[bit >> 3] as number) ^ (1 << (bit & 7));
  return toBase64Url(bytes);
};

describe('signed snapshots (bs/snap/v1)', () => {
  it('signs the pond id, a newline and the 25 bytes under the snapshot domain', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    const signed = signSnap(me, POND, bytes);
    expect(signed.snap).toBe(toBase64Url(bytes));
    expect(signed.sig).toMatch(/^[A-Za-z0-9_-]{86}$/);
    const message = new Uint8Array([...new TextEncoder().encode(POND), 0x0a, ...bytes]);
    expect(SNAP_DOMAIN).toBe('bs/snap/v1');
    expect(verify(me.playerId, SNAP_DOMAIN, message, fromBase64Url(signed.sig) as Uint8Array)).toBe(
      true,
    );
  });

  it('verifies to the decoded snapshot', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    const got = verifySnap(me.playerId, POND, signSnap(me, POND, bytes));
    expect(got).not.toBeNull();
    expect(got?.tick).toBe(4321);
    expect(got?.genomeRef).toBe(0xcafe);
    expect(got?.spawnProtected).toBe(true);
    expect(got?.egg).toBe(true);
  });

  it('gives null for any flipped bit in the snapshot or the signature', async () => {
    const me = await seeded(1);
    const signed = signSnap(me, POND, encodeSnapshot(snap));
    for (let bit = 0; bit < SNAPSHOT_BYTES * 8; bit++) {
      expect(verifySnap(me.playerId, POND, { ...signed, snap: flip(signed.snap, bit) })).toBeNull();
    }
    for (let bit = 0; bit < 64 * 8; bit += 7) {
      expect(verifySnap(me.playerId, POND, { ...signed, sig: flip(signed.sig, bit) })).toBeNull();
    }
  });

  it('gives null for another pond id or another player key', async () => {
    const me = await seeded(1);
    const other = await seeded(2);
    const signed = signSnap(me, POND, encodeSnapshot(snap));
    expect(verifySnap(me.playerId, 'p2', signed)).toBeNull();
    expect(verifySnap(me.playerId, `${POND}x`, signed)).toBeNull();
    expect(verifySnap(other.playerId, POND, signed)).toBeNull();
    expect(verifySnap(me.playerId, POND, signSnap(other, POND, encodeSnapshot(snap)))).toBeNull();
  });

  it('drops a v3 snapshot even when its signature is good', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    bytes[24] = 3;
    bytes[11] = (bytes[11] as number) & 15;
    expect(verifySnap(me.playerId, POND, signSnap(me, POND, bytes))).toBeNull();
  });

  it('never throws on malformed input', async () => {
    const me = await seeded(1);
    const signed = signSnap(me, POND, encodeSnapshot(snap));
    for (const bad of [
      null,
      undefined,
      1,
      'x',
      [],
      {},
      { snap: signed.snap },
      { sig: signed.sig },
      { snap: 5, sig: signed.sig },
      { snap: `${signed.snap}A`, sig: signed.sig },
      { snap: signed.snap.slice(1), sig: signed.sig },
      { snap: signed.snap, sig: signed.sig.slice(2) },
      { snap: '!!!', sig: '???' },
    ]) {
      expect(verifySnap(me.playerId, POND, bad as never)).toBeNull();
    }
    expect(verifySnap('not-a-player', POND, signed)).toBeNull();
    expect(verifySnap(me.playerId, 5 as unknown as string, signed)).toBeNull();
  });
});

describe('state-channel frames', () => {
  it('packs the snapshot and its signature into 89 bytes and back', async () => {
    const me = await seeded(1);
    const signed = signSnap(me, POND, encodeSnapshot(snap));
    const frame = encodeSignedFrame(signed);
    expect(SIGNED_FRAME_BYTES).toBe(89);
    expect(frame.length).toBe(89);
    const got = decodeStateFrame(frame);
    expect(got?.signed).toEqual(signed);
    expect(got?.snapshot.genomeRef).toBe(0xcafe);
    expect(verifySnap(me.playerId, POND, got?.signed ?? signed)).not.toBeNull();
  });

  it('takes a plain 25-byte snapshot with no signature', () => {
    const got = decodeStateFrame(encodeSnapshot(snap));
    expect(got?.signed).toBeNull();
    expect(got?.snapshot.tick).toBe(4321);
  });

  it('drops a v3 snapshot, signed or not', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    bytes[24] = 3;
    expect(decodeStateFrame(bytes)).toBeNull();
    const frame = encodeSignedFrame(signSnap(me, POND, encodeSnapshot(snap)));
    frame[24] = 3;
    expect(decodeStateFrame(frame)).toBeNull();
  });

  it('refuses to frame a malformed signed snapshot', () => {
    expect(() => encodeSignedFrame({ snap: 'AAAA', sig: 'A'.repeat(86) })).toThrow(RangeError);
  });

  it('never throws on 10,000 random byte strings, and decodes only 25 or 89 bytes of v4', async () => {
    const KEY = (await seeded(3)).playerId;
    const rng = createRng(seedFromString('fuzz-state-frame'), 'net');
    let decoded = 0;
    for (let i = 0; i < 10_000; i++) {
      const len = [0, 1, 24, 25, 26, 88, 89, 90, 120][rng.int(0, 8)] as number;
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = rng.int(0, 255);
      if (len >= 25 && rng.int(0, 1) === 1) {
        b[24] = 4;
        b[11] = (b[11] as number) & 63;
      }
      const got = decodeStateFrame(b);
      if (got) {
        decoded++;
        expect([25, 89]).toContain(len);
        expect(b[24]).toBe(4);
        expect(got.signed === null).toBe(len === 25);
        // A random signature never verifies; a few hundred checks keep the test quick.
        if (got.signed && decoded < 200) expect(verifySnap(KEY, POND, got.signed)).toBeNull();
      }
    }
    expect(decoded).toBeGreaterThan(0);
    expect(decodeStateFrame(null as unknown as Uint8Array)).toBeNull();
    expect(decodeStateFrame([] as unknown as Uint8Array)).toBeNull();
  });
});

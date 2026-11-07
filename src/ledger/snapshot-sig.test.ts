import { describe, expect, it } from 'vitest';
import {
  encodeSnapshot,
  PROXY_FRAME_BYTES,
  SIGNED_FRAME_BYTES,
  SNAPSHOT_BYTES,
  type Snapshot,
} from '../net/protocol';
import { createRng, seedFromString } from '../sim/prng';
import { createIdentity, fromBase64Url, memoryKeyStore, toBase64Url, verify } from './identity';
import {
  decodeStateFrame,
  encodeProxyFrame,
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
  it('signs the pond id, a newline and the 29 bytes under the snapshot domain', async () => {
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

  it('drops a v4 snapshot even when its signature is good', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    bytes[28] = 4;
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
  it('packs the snapshot and its signature into 93 bytes and back', async () => {
    const me = await seeded(1);
    const signed = signSnap(me, POND, encodeSnapshot(snap));
    const frame = encodeSignedFrame(signed);
    expect(SIGNED_FRAME_BYTES).toBe(93);
    expect(frame.length).toBe(93);
    const got = decodeStateFrame(frame);
    expect(got?.signed).toEqual(signed);
    expect(got?.proxyFor).toBeNull();
    expect(got?.snapshot.genomeRef).toBe(0xcafe);
    expect(verifySnap(me.playerId, POND, got?.signed ?? signed)).not.toBeNull();
  });

  it('fails a 93-byte frame whose signature covers other bytes', async () => {
    const me = await seeded(1);
    const other = encodeSnapshot({ ...snap, x: snap.x + 1 });
    const frame = encodeSignedFrame({
      snap: toBase64Url(encodeSnapshot(snap)),
      sig: signSnap(me, POND, other).sig,
    });
    const got = decodeStateFrame(frame);
    expect(got?.signed).not.toBeNull();
    expect(verifySnap(me.playerId, POND, got?.signed ?? { snap: '', sig: '' })).toBeNull();
  });

  it('takes a plain 29-byte snapshot with no signature', () => {
    const got = decodeStateFrame(encodeSnapshot(snap));
    expect(got?.signed).toBeNull();
    expect(got?.proxyFor).toBeNull();
    expect(got?.snapshot.tick).toBe(4321);
  });

  it('drops a v4 snapshot, signed or not', async () => {
    const me = await seeded(1);
    const bytes = encodeSnapshot(snap);
    bytes[28] = 4;
    expect(decodeStateFrame(bytes)).toBeNull();
    expect(decodeStateFrame(bytes.subarray(0, 25))).toBeNull();
    const frame = encodeSignedFrame(signSnap(me, POND, encodeSnapshot(snap)));
    frame[28] = 4;
    expect(decodeStateFrame(frame)).toBeNull();
  });

  it('refuses to frame a malformed signed snapshot', () => {
    expect(() => encodeSignedFrame({ snap: 'AAAA', sig: 'A'.repeat(86) })).toThrow(RangeError);
  });

  it('never throws on 10,000 random byte strings, and decodes only 29, 61 or 93 bytes of v5', async () => {
    const KEY = (await seeded(3)).playerId;
    const rng = createRng(seedFromString('fuzz-state-frame'), 'net');
    const decoded = { 29: 0, 61: 0, 93: 0 } as Record<number, number>;
    for (let i = 0; i < 10_000; i++) {
      const len = [0, 1, 25, 28, 29, 30, 57, 60, 61, 62, 89, 92, 93, 94, 120][
        rng.int(0, 14)
      ] as number;
      const b = new Uint8Array(len);
      for (let j = 0; j < len; j++) b[j] = rng.int(0, 255);
      // A proxy frame's snapshot follows the 32-byte key.
      const at = len === PROXY_FRAME_BYTES ? 32 : 0;
      if (len >= 29 && rng.int(0, 1) === 1) {
        b[at + 28] = 5;
        b[at + 15] = (b[at + 15] as number) & 63;
      }
      const got = decodeStateFrame(b);
      if (got) {
        expect([29, 61, 93]).toContain(len);
        decoded[len] = (decoded[len] as number) + 1;
        expect(b[at + 28]).toBe(5);
        expect(got.signed === null).toBe(len !== 93);
        expect(got.proxyFor === null).toBe(len !== 61);
        if (got.proxyFor) expect(got.proxyFor).toBe(toBase64Url(b.subarray(0, 32)));
        // A random signature never verifies; a few hundred checks keep the test quick.
        if (got.signed && (decoded[93] as number) < 200)
          expect(verifySnap(KEY, POND, got.signed)).toBeNull();
      }
    }
    expect(decoded[29]).toBeGreaterThan(0);
    expect(decoded[61]).toBeGreaterThan(0);
    expect(decoded[93]).toBeGreaterThan(0);
    expect(decodeStateFrame(null as unknown as Uint8Array)).toBeNull();
    expect(decodeStateFrame([] as unknown as Uint8Array)).toBeNull();
  });
});

describe('proxy frames (ADR 0053)', () => {
  it('packs an away player key and its snapshot into 61 bytes and back', async () => {
    const away = await seeded(2);
    const bytes = encodeSnapshot({ ...snap, fighting: true });
    const frame = encodeProxyFrame(away.playerId, bytes);
    expect(PROXY_FRAME_BYTES).toBe(61);
    expect(frame.length).toBe(61);
    expect(toBase64Url(frame.subarray(0, 32))).toBe(away.playerId);
    expect(frame.subarray(32)).toEqual(bytes);
    const got = decodeStateFrame(frame);
    expect(got?.proxyFor).toBe(away.playerId);
    expect(got?.signed).toBeNull();
    expect(got?.snapshot).toEqual(decodeStateFrame(bytes)?.snapshot);
    expect(got?.snapshot.fighting).toBe(true);
  });

  it('gives null for 60 or 62 bytes', async () => {
    const frame = encodeProxyFrame((await seeded(2)).playerId, encodeSnapshot(snap));
    expect(decodeStateFrame(frame.subarray(0, 60))).toBeNull();
    expect(decodeStateFrame(new Uint8Array([...frame, 0]))).toBeNull();
  });

  it('gives null for a key that is no player key, and for a bad snapshot', async () => {
    const frame = encodeProxyFrame((await seeded(2)).playerId, encodeSnapshot(snap));
    // y = 2^255 - 1 is past the field prime: no canonical key encodes it.
    const outOfField = frame.slice();
    outOfField.fill(0xff, 0, 31);
    outOfField[31] = 0x7f;
    expect(decodeStateFrame(outOfField)).toBeNull();
    // y = 2 is in the field, but no curve point has it.
    const offCurve = frame.slice();
    offCurve.fill(0, 0, 32);
    offCurve[0] = 2;
    expect(decodeStateFrame(offCurve)).toBeNull();
    const v4 = frame.slice();
    v4[60] = 4;
    expect(decodeStateFrame(v4)).toBeNull();
  });

  it('refuses to frame a bad player id or snapshot', async () => {
    const id = (await seeded(2)).playerId;
    const bytes = encodeSnapshot(snap);
    expect(() => encodeProxyFrame('short', bytes)).toThrow(RangeError);
    expect(() => encodeProxyFrame(id, bytes.subarray(1))).toThrow(RangeError);
    expect(() => encodeProxyFrame(toBase64Url(new Uint8Array(32).fill(0xff)), bytes)).toThrow(
      RangeError,
    );
  });
});

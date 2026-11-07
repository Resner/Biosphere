import { describe, expect, it } from 'vitest';
import { speedTest } from '../../tests/heavy';
import { createIdentity, fromBase64Url, memoryKeyStore, toBase64Url } from '../ledger/identity';
import { decodeStateFrame, encodeSignedFrame, signSnap, verifySnap } from '../ledger/snapshot-sig';
import { encodeSnapshot, type SignedSnap, type Snapshot } from './protocol';
import { HELD, SEEN_MS, SignedSnaps, VERIFY_PER_SECOND } from './signed-snaps';

const POND = 'p1';

const snap = (tick: number): Snapshot => ({
  seq: tick % 0x10000,
  tick,
  x: 4100,
  y: 3900,
  heading: 0.5,
  vx: 10,
  vy: 0,
  biomass: 400,
  energy: 0.8,
  health: 1,
  alive: true,
  dashing: false,
  ready: false,
  egg: false,
  spawnProtected: false,
  fighting: false,
  genomeRef: 0xbeef,
});

const seeded = (n: number) => createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)));

async function setup() {
  const peer = await seeded(1);
  const other = await seeded(2);
  const snaps = new SignedSnaps((id, s) => verifySnap(id, POND, s));
  const signed = (tick: number, by = peer): SignedSnap =>
    signSnap(by, POND, encodeSnapshot(snap(tick)));
  return { peer, other, snaps, signed };
}

describe('SignedSnaps', () => {
  it('keeps the newest verified frame of each peer, forwardable as it came', async () => {
    const { peer, snaps, signed } = await setup();
    expect(snaps.latest(peer.playerId)).toBeNull();
    const first = signed(100);
    expect(snaps.receive(peer.playerId, snap(100), first, 0)).toBe(true);
    expect(snaps.latest(peer.playerId)).toEqual(first);
    expect(snaps.tickOf(peer.playerId)).toBe(100);
    const next = signed(106);
    expect(snaps.receive(peer.playerId, snap(106), next, 200)).toBe(true);
    expect(snaps.latest(peer.playerId)).toEqual(next);
    // The stored frame verifies again wherever it is forwarded (the authority, M7 T8).
    expect(verifySnap(peer.playerId, POND, next)?.tick).toBe(106);
  });

  it('ignores a frame no newer than the stored one, without verifying it', async () => {
    const { peer, snaps, signed } = await setup();
    let calls = 0;
    const counting = new SignedSnaps((id, s) => {
      calls++;
      return verifySnap(id, POND, s);
    });
    counting.receive(peer.playerId, snap(200), signed(200), 0);
    expect(counting.receive(peer.playerId, snap(200), signed(200), 100)).toBe(false);
    expect(counting.receive(peer.playerId, snap(194), signed(194), 200)).toBe(false);
    expect(calls).toBe(1);
    expect(counting.tickOf(peer.playerId)).toBe(200);
    expect(snaps.badSignatures).toBe(0);
  });

  it('drops and counts a forged frame: a flipped bit, another key, another pond', async () => {
    const { peer, other, snaps, signed } = await setup();
    snaps.receive(peer.playerId, snap(10), signed(10), 0);
    const good = signed(20);
    const sig = fromBase64Url(good.sig) as Uint8Array;
    sig[5] = (sig[5] as number) ^ 1;
    const forged = [
      { ...good, sig: toBase64Url(sig) },
      signed(21, other),
      signSnap(peer, 'p2', encodeSnapshot(snap(22))),
    ];
    forged.forEach((s, i) => {
      expect(snaps.receive(peer.playerId, snap(20 + i), s, 100 * (i + 1))).toBe(false);
    });
    expect(snaps.badSignatures).toBe(3);
    expect(snaps.tickOf(peer.playerId)).toBe(10);
    // A forged frame claiming a later tick does not hold back the genuine one.
    expect(snaps.receive(peer.playerId, snap(23), signed(23), 400)).toBe(true);
  });

  it('trusts the signed bytes, not the snapshot it was told about', async () => {
    const { peer, snaps, signed } = await setup();
    expect(snaps.receive(peer.playerId, snap(900), signed(30), 0)).toBe(true);
    expect(snaps.tickOf(peer.playerId)).toBe(30);
  });

  it('verifies at most 10 frames a second per peer, and counts the rest', async () => {
    const { peer, other, snaps, signed } = await setup();
    let taken = 0;
    for (let i = 0; i < 25; i++) {
      if (snaps.receive(peer.playerId, snap(i + 1), signed(i + 1), i * 20)) taken++;
    }
    expect(taken).toBe(VERIFY_PER_SECOND);
    expect(snaps.limited).toBe(15);
    // Another peer has its own allowance, and the next second starts afresh.
    expect(snaps.receive(other.playerId, snap(5), signed(5, other), 499)).toBe(true);
    expect(snaps.receive(peer.playerId, snap(40), signed(40), 1000)).toBe(true);
  });

  it('forgets a peer, or every peer at a pond change', async () => {
    const { peer, other, snaps, signed } = await setup();
    snaps.receive(peer.playerId, snap(10), signed(10), 0);
    snaps.receive(other.playerId, snap(10), signed(10, other), 0);
    expect(snaps.size).toBe(2);
    snaps.remove(peer.playerId);
    expect(snaps.latest(peer.playerId)).toBeNull();
    expect(snaps.size).toBe(1);
    expect(snaps.latest(other.playerId)).not.toBeNull();
    snaps.clear();
    expect(snaps.latest(other.playerId)).toBeNull();
  });

  it('keeps the last 5 verified frames, and gives those received in the last 2 s oldest first (M10 T11)', async () => {
    const { peer, other, snaps, signed } = await setup();
    expect(HELD).toBe(5);
    expect(SEEN_MS).toBe(2000);
    expect(snaps.recent(peer.playerId, 0)).toEqual([]);
    const frames = [10, 16, 22, 28, 34, 40, 46].map((tick) => signed(tick));
    // Received 200 ms apart: the first two fall out of the 5 held.
    frames.forEach((f, i) => {
      snaps.receive(peer.playerId, snap(10 + 6 * i), f, 200 * i);
    });
    expect(snaps.latest(peer.playerId)).toEqual(frames[6]);
    expect(snaps.recent(peer.playerId, 1200)).toEqual(frames.slice(2));
    // Only those received in the 2 s before now.
    expect(snaps.recent(peer.playerId, 2000 + 800)).toEqual(frames.slice(4));
    expect(snaps.recent(peer.playerId, 2000 + 1201)).toEqual([]);
    // A forged or older frame changes nothing held; another peer's are its own.
    snaps.receive(peer.playerId, snap(52), signed(52, other), 1300);
    snaps.receive(peer.playerId, snap(30), signed(30), 1300);
    expect(snaps.recent(peer.playerId, 1300)).toEqual(frames.slice(2));
    expect(snaps.recent(other.playerId, 1300)).toEqual([]);
    snaps.remove(peer.playerId);
    expect(snaps.recent(peer.playerId, 1300)).toEqual([]);
  });

  it('never throws on what the state channel delivers', async () => {
    const { peer, snaps } = await setup();
    const junk: SignedSnap[] = [
      { snap: '', sig: '' },
      { snap: 'not base64!', sig: '@@' },
      null as unknown as SignedSnap,
      { snap: 1, sig: 2 } as unknown as SignedSnap,
    ];
    for (const [i, s] of junk.entries()) {
      expect(() => snaps.receive(peer.playerId, snap(i + 1), s, i * 200)).not.toThrow();
    }
    expect(snaps.badSignatures).toBe(junk.length);
  });
});

describe('signing cost', () => {
  speedTest('signs one snapshot as a 93-byte frame in under 1 ms in Node', async () => {
    const me = await seeded(3);
    const bytes = encodeSnapshot(snap(1000));
    for (let i = 0; i < 20; i++) encodeSignedFrame(signSnap(me, POND, bytes));
    const runs = 200;
    const start = performance.now();
    for (let i = 0; i < runs; i++) encodeSignedFrame(signSnap(me, POND, bytes));
    const each = (performance.now() - start) / runs;
    expect(each).toBeLessThan(1);
    expect(decodeStateFrame(encodeSignedFrame(signSnap(me, POND, bytes)))?.signed).not.toBeNull();
  });
});

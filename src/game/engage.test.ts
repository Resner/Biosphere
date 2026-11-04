import { describe, expect, it } from 'vitest';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { decodeStateFrame, verifySnap } from '../ledger/snapshot-sig';
import { RemoteSet } from '../net/pond-sync';
import { encodeSnapshot, SIGNED_FRAME_BYTES, type Snapshot } from '../net/protocol';
import { ProxyReceiver } from '../net/proxy-snaps';
import { RULES } from '../sim/rules';
import {
  CANDIDATE_RADII,
  CandidateSigner,
  candidates,
  lockState,
  offered,
  SpawnShield,
} from './engage';

const snap: Snapshot = {
  seq: 3,
  tick: 777,
  x: 1000,
  y: 1000,
  heading: 0,
  vx: 0,
  vy: 0,
  biomass: 400,
  energy: 1,
  health: 1,
  alive: true,
  dashing: false,
  ready: false,
  egg: false,
  spawnProtected: false,
  fighting: false,
  genomeRef: 1,
};

// Radius 20 (biomass 400) is tier 0; radius 40 tier 1; radius 200 tier 2.
const self = { x: 1000, y: 1000, biomass: 400 };

describe('engage candidates', () => {
  it('takes pond peers within ±1 tier and 8 × the larger radius', () => {
    const reach = CANDIDATE_RADII * 40;
    const ids = candidates(self, [
      { id: 'near', x: 1100, y: 1000, radius: 20 },
      { id: 'far', x: 1000 + CANDIDATE_RADII * 20 + 1, y: 1000, radius: 20 },
      // A tier bigger: its own radius sets the range.
      { id: 'bigger', x: 1000, y: 1000 + reach - 1, radius: 40 },
      { id: 'beyond', x: 1000, y: 1000 - reach - 1, radius: 40 },
      { id: 'giant', x: 1010, y: 1000, radius: 200 },
    ]);
    expect([...ids].sort()).toEqual(['bigger', 'near']);
    expect(RULES.encounter.maxTierGap).toBe(1);
  });

  it('refills the set it is given', () => {
    const into = new Set(['stale']);
    candidates(self, [{ id: 'near', x: 1000, y: 1010, radius: 20 }], into);
    expect([...into]).toEqual(['near']);
  });
});

describe('CandidateSigner', () => {
  it('signs only when there is a candidate, and for the pond it names', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(4)));
    const signer = new CandidateSigner(() => ({ identity: me, pondId: 'p1' }));
    const plain = encodeSnapshot(snap);
    expect(signer.sign(plain, self, [])).toBeNull();
    expect(signer.ids.size).toBe(0);
    const frame = signer.sign(plain, self, [{ id: 'near', x: 1000, y: 1010, radius: 20 }]);
    expect(frame?.length).toBe(SIGNED_FRAME_BYTES);
    expect([...signer.ids]).toEqual(['near']);
    const signed = decodeStateFrame(frame as Uint8Array)?.signed;
    expect(signed && verifySnap(me.playerId, 'p1', signed)?.tick).toBe(777);
  });

  it('signs nothing without an identity or a pond', () => {
    const signer = new CandidateSigner(() => null);
    expect(
      signer.sign(encodeSnapshot(snap), self, [{ id: 'n', x: 1000, y: 1000, radius: 20 }]),
    ).toBeNull();
  });
});

describe('lockState', () => {
  it('answers a lock ask with the snapshot signed for the pond', async () => {
    const me = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(5)));
    const msg = lockState('ab'.repeat(8), encodeSnapshot(snap), me, 'p1');
    expect(msg.t).toBe('lock-state');
    expect(msg.lock).toBe('ab'.repeat(8));
    expect(verifySnap(me.playerId, 'p1', msg.mine)?.tick).toBe(777);
  });
});

describe('SpawnShield', () => {
  const ms = RULES.encounter.protectionSeconds * 1000;

  it('protects for 15 s from a start, and not before or after', () => {
    const shield = new SpawnShield();
    expect(shield.active(0)).toBe(false);
    shield.start(10_000);
    expect(shield.active(10_000)).toBe(true);
    expect(shield.active(10_000 + ms - 1)).toBe(true);
    expect(shield.active(10_000 + ms)).toBe(false);
  });

  it('ends at the first engage, and at a life that gives none', () => {
    const shield = new SpawnShield();
    shield.start(0);
    shield.end();
    expect(shield.active(1)).toBe(false);
  });
});

describe('proxied remotes (M8 T11)', () => {
  it('a forged proxy never yields an engage candidate', async () => {
    const [me, relay, forged] = await Promise.all(
      [7, 8, 9].map(
        async (n) => (await createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)))).playerId,
      ),
    );
    const remotes = new RemoteSet();
    const receiver = new ProxyReceiver(() => me as string, remotes);
    remotes.receive(relay as string, { ...snap, fighting: true, x: 5000 }, 0);
    // A proxy that claims a creature not fighting, right beside this player.
    const bait = { ...snap, tick: 60, x: 1005, y: 1000, fighting: false };
    expect(receiver.receive(relay as string, forged as string, bait, 2000)).toBe(true);
    const views = remotes.sample(2000, 2000);
    expect(views.find((r) => r.id === forged)?.away).toBe(true);
    expect(candidates(self, views).has(forged as string)).toBe(false);
    expect(views.filter(offered).map((r) => r.id)).toEqual([relay]);
  });
});

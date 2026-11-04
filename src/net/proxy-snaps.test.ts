import { beforeAll, describe, expect, it } from 'vitest';
import { createIdentity, memoryKeyStore } from '../ledger/identity';
import { decodeStateFrame } from '../ledger/snapshot-sig';
import { RemoteSet, type SnapshotFields } from './pond-sync';
import { PROXY_FRAME_BYTES, type Snapshot } from './protocol';
import {
  PROXY_INTERVAL_MS,
  PROXY_QUIET_MS,
  ProxyReceiver,
  ProxyRelay,
  type RelayFight,
} from './proxy-snaps';

const TICK_MS = 1000 / 30;
const FPS_MS = 1000 / 60;

/** Real player keys: a proxy frame carries one, and a key that is no Ed25519 point is dropped. */
let ids: string[] = [];
beforeAll(async () => {
  ids = await Promise.all(
    [1, 2, 3, 4, 5, 6].map(
      async (n) => (await createIdentity(memoryKeyStore(new Uint8Array(32).fill(n)))).playerId,
    ),
  );
});

function fields(over: Partial<SnapshotFields> = {}): SnapshotFields {
  return {
    tick: 0,
    x: 1000,
    y: 500,
    heading: 0,
    vx: 0,
    vy: 0,
    biomass: 100,
    energy: 1,
    health: 1,
    alive: true,
    dashing: false,
    ready: false,
    egg: false,
    spawnProtected: false,
    fighting: true,
    genomeRef: 0,
    ...over,
  };
}

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return { seq: 0, ...fields(), ...over };
}

/** A fight of `players` (by slot) whose fighters swim east, sampled at `ms`. */
function fightOf(players: string[], at: () => number, id = 'enc-1'): RelayFight {
  return {
    id,
    players,
    snapshot: (slot) => {
      const ms = at();
      return fields({ tick: Math.round(ms / TICK_MS), x: 1000 + slot * 20 + ms / 100 });
    },
  };
}

interface Client {
  relay: ProxyRelay;
  sent: { to: string; bytes: Uint8Array }[];
  shown: { player: string; snapshot: Snapshot }[];
}

/** One client of the pond: `present` are the players its roster holds (and itself). */
function client(self: string, present: Set<string>, peers: () => string[]): Client {
  const sent: Client['sent'] = [];
  const shown: Client['shown'] = [];
  const relay = new ProxyRelay({
    self,
    present: (p) => p === self || present.has(p),
    peers: () => peers().filter((p) => p !== self),
    send: (to, bytes) => sent.push({ to, bytes }),
    show: (player, snapshot) => shown.push({ player, snapshot }),
  });
  return { relay, sent, shown };
}

describe('ProxyRelay', () => {
  it('only the connected fighter with the lowest slot relays, at 5 Hz, to the peers outside the fight, and stops after the end', () => {
    const [f0, f1, f2, s1, s2] = ids as [string, string, string, string, string];
    // f1 has left the pond: f0 and f2 still play, s1 and s2 watch.
    const pond = new Set([f0, f2, s1, s2]);
    const peers = () => [...pond];
    const players = [f0, f1, f2];
    let now = 0;
    const fight = fightOf(players, () => now);
    const c0 = client(f0, pond, peers);
    const c2 = client(f2, pond, peers);
    for (now = 0; now < 10_000; now += FPS_MS) {
      c0.relay.update(now, fight);
      c2.relay.update(now, fight);
    }
    expect(c2.sent).toHaveLength(0);
    const to = (who: string) => c0.sent.filter((s) => s.to === who);
    for (const peer of [s1, s2]) {
      expect(to(peer).length).toBeGreaterThanOrEqual(49);
      expect(to(peer).length).toBeLessThanOrEqual(51);
    }
    // Never to a fighter, and every frame is a proxy of the away fighter.
    expect(to(f2)).toHaveLength(0);
    for (const { bytes } of c0.sent) {
      expect(bytes.length).toBe(PROXY_FRAME_BYTES);
      expect(decodeStateFrame(bytes)?.proxyFor).toBe(f1);
    }
    // Both fighters still draw their away opponent from the same snapshots.
    expect(c0.shown.every((s) => s.player === f1)).toBe(true);
    expect(c2.shown.length).toBe(c0.shown.length);

    // The end: one last frame per peer, carrying the result's alive flag, then nothing more.
    const before = c0.sent.length;
    c0.relay.end(fight, (slot) => slot !== 1);
    c2.relay.end(fight, (slot) => slot !== 1);
    expect(c0.sent.length - before).toBe(2);
    const last = c0.sent.map((s) => decodeStateFrame(s.bytes)?.snapshot.alive);
    expect(last.slice(before)).toEqual([false, false]);
    expect(c2.shown[c2.shown.length - 1]?.snapshot.alive).toBe(false);
    for (now = 10_000; now < 12_000; now += FPS_MS) {
      c0.relay.update(now, fight);
      c2.relay.update(now, fight);
    }
    expect(c0.sent.length - before).toBe(2);
    expect(c2.sent).toHaveLength(0);
  });

  it('hands the relay to the next connected fighter when the lowest one leaves too', () => {
    const [f0, f1, f2, s1] = ids as [string, string, string, string];
    const pond = new Set([f2, s1]);
    const c2 = client(f2, pond, () => [...pond]);
    let now = 0;
    const fight = fightOf([f0, f1, f2], () => now);
    for (now = 0; now < 1000; now += FPS_MS) c2.relay.update(now, fight);
    const away = new Set(c2.sent.map((s) => decodeStateFrame(s.bytes)?.proxyFor));
    expect(away).toEqual(new Set([f0, f1]));
    expect(c2.sent.every((s) => s.to === s1)).toBe(true);
  });

  it('sends nothing while every fighter is connected', () => {
    const [f0, f1, s1] = ids as [string, string, string];
    const pond = new Set([f1, s1]);
    const c0 = client(f0, pond, () => [...pond]);
    let now = 0;
    const fight = fightOf([f0, f1], () => now);
    for (now = 0; now < 2000; now += FPS_MS) c0.relay.update(now, fight);
    c0.relay.end(fight, () => true);
    expect(c0.sent).toHaveLength(0);
    expect(c0.shown).toHaveLength(0);
  });

  it('keeps the traffic per away fighter per peer at or under 300 B/s over 10 s', () => {
    const [f0, f1, f2, s1] = ids as [string, string, string, string];
    // Two away fighters in a three-way fight; frame timing jitters between 8 and 40 ms.
    const pond = new Set([f0, s1]);
    const c0 = client(f0, pond, () => [...pond]);
    let now = 0;
    const fight = fightOf([f0, f1, f2], () => now);
    let jitter = 7;
    while (now < 10_000) {
      c0.relay.update(now, fight);
      jitter = (jitter * 31 + 11) % 33;
      now += 8 + jitter;
    }
    for (const away of [f1, f2]) {
      const bytes = c0.sent
        .filter((s) => s.to === s1 && decodeStateFrame(s.bytes)?.proxyFor === away)
        .reduce((n, s) => n + s.bytes.length, 0);
      expect(bytes / 10).toBeLessThanOrEqual(300);
      expect(bytes / 10).toBeGreaterThan(200);
    }
  });
});

describe('ProxyReceiver', () => {
  /** A pond of remotes as spectator `self` sees it, with `relay` fighting and `away` gone quiet. */
  function pond(self: string) {
    const remotes = new RemoteSet();
    const receiver = new ProxyReceiver(() => self, remotes);
    return { remotes, receiver };
  }

  it('takes a proxy from a fighting peer for a player gone quiet, and draws it faded and away', () => {
    const [self, relay, away] = ids as [string, string, string];
    const { remotes, receiver } = pond(self);
    remotes.setMember(relay, 'Ann');
    remotes.setMember(away, 'Bob');
    remotes.receive(relay, snap({ fighting: true }), 0);
    remotes.receive(away, snap({ fighting: true, x: 900 }), 0);
    expect(remotes.removeMember(away)).toBe(true);
    for (let k = 0; k < 10; k++) {
      const ms = PROXY_QUIET_MS + k * PROXY_INTERVAL_MS;
      remotes.receive(
        relay,
        snap({ seq: k + 1, tick: Math.round(ms / TICK_MS), fighting: true }),
        ms,
      );
      const moved = snap({ seq: k, tick: Math.round(ms / TICK_MS), x: 900 + k * 10 });
      expect(receiver.receive(relay, away, moved, ms)).toBe(true);
    }
    expect(receiver.dropped).toBe(0);
    const ms = PROXY_QUIET_MS + 10 * PROXY_INTERVAL_MS;
    const drawn = remotes.sample(ms, ms).find((r) => r.id === away);
    expect(drawn).toMatchObject({ away: true, name: 'Bob' });
    expect(drawn?.alpha).toBeCloseTo(0.6, 5);
    expect(drawn?.x).toBeGreaterThan(950);
  });

  it('drops and counts a proxy from a peer that is not fighting', () => {
    const [self, peer, other] = ids as [string, string, string];
    const { remotes, receiver } = pond(self);
    remotes.receive(peer, snap({ fighting: false }), 0);
    expect(receiver.receive(peer, other, snap(), 5000)).toBe(false);
    // Nor from a peer never heard from at all.
    expect(receiver.receive(ids[4] as string, other, snap(), 5000)).toBe(false);
    expect(receiver.dropped).toBe(2);
    expect(remotes.sample(5000, 5000).some((r) => r.id === other)).toBe(false);
  });

  it('drops and counts a proxy for a player still sending its own snapshots', () => {
    const [self, relay, live] = ids as [string, string, string];
    const { remotes, receiver } = pond(self);
    remotes.receive(relay, snap({ fighting: true }), 0);
    remotes.receive(live, snap({ x: 700, tick: 30 }), 1000);
    const forged = snap({ x: 1500, tick: 33, seq: 9 });
    expect(receiver.receive(relay, live, forged, 1000 + PROXY_QUIET_MS - 1)).toBe(false);
    // A proxy for itself, or for the sender, is never taken.
    expect(receiver.receive(relay, self, forged, 5000)).toBe(false);
    expect(receiver.receive(relay, relay, forged, 5000)).toBe(false);
    expect(receiver.dropped).toBe(3);
    const drawn = remotes.sample(1100, 1100).find((r) => r.id === live);
    expect(drawn?.away).toBe(false);
    expect(drawn?.x).toBeLessThan(800);
  });

  it('takes proxies for at most three players from one peer', () => {
    const [self, relay, ...away] = ids as string[];
    const { remotes, receiver } = pond(self as string);
    remotes.receive(relay as string, snap({ fighting: true }), 0);
    const took = away.map((p) => receiver.receive(relay as string, p, snap({ tick: 60 }), 2000));
    expect(took).toEqual([true, true, true, false]);
    expect(receiver.dropped).toBe(1);
  });
});

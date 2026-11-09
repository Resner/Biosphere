import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeToBase64url } from '../src/genome/codec';
import { genesisGenome } from '../src/genome/genesis';
import { createIdentity, memoryKeyStore } from '../src/ledger/identity';
import { signMateAsk } from '../src/ledger/mate-ask';
import { signSnap, verifySnap } from '../src/ledger/snapshot-sig';
import type { SocketLike } from '../src/net/hub-client';
import { type ClientMsg, encodeSnapshot, type HubMsg, type Snapshot } from '../src/net/protocol';
import { seedFromString } from '../src/sim/prng';
import { RULES } from '../src/sim/rules';
import { LifeClient, lifeSeedOf, SnapBus } from './life-client';

const HEX = 'a'.repeat(64);
const OTHER = 'B'.repeat(43);
const GENOME = genomeToBase64url(genesisGenome(seedFromString('life-client-test')));
const CENTRE = RULES.world.size / 2;
const SCALES = { lifespan: 0.1, mating: 0.05 };
const WORLD = {
  id: 'world-1',
  seed: 'seed',
  epoch: 0,
  centre: { x: CENTRE, y: CENTRE },
  size: RULES.world.size,
};
/** A grown, rested creature that may mate. */
const LIFE = {
  creature: HEX,
  seq: 0,
  genome: GENOME,
  biomass: 30_000,
  energy: 40_000,
  health: 30_000,
  activeMs: 600_000,
  lifespanMs: 900_000,
  matureAtMs: 1000,
  cooldownUntilMs: 0,
};

/** A hub that signs the client in, gives it its creature, places it and shows it one peer. */
class FakeHub implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: ClientMsg[] = [];
  closed = false;
  constructor(private readonly hello: (hub: FakeHub) => void) {
    queueMicrotask(() => this.say({ t: 'challenge', nonce: `${'d'.repeat(21)}Q` }));
  }
  say(msg: HubMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string) {
    const msg = JSON.parse(data) as ClientMsg;
    this.sent.push(msg);
    if (msg.t === 'hello') {
      this.say({ t: 'welcome', world: WORLD, ice: [], turn: false, now: Date.now() });
      this.hello(this);
    } else if (msg.t === 'spawn') {
      this.say({ t: 'spawn', x: CENTRE, y: CENTRE, why: 'placed', protect: false });
    } else if (msg.t === 'where') {
      this.say({
        t: 'near',
        leaf: { x: 0, y: 0, size: 1024 },
        peers: [{ id: OTHER, name: 'Other', x: CENTRE + 20, y: CENTRE, r: 10, age: 5, n: 0 }],
        swarm: [],
      });
    }
  }
  close() {
    this.closed = true;
  }
  find<T extends ClientMsg['t']>(t: T) {
    return this.sent.find((m) => m.t === t) as Extract<ClientMsg, { t: T }> | undefined;
  }
}

let hubs: FakeHub[];
let hello: (hub: FakeHub) => void;
beforeEach(() => {
  hubs = [];
  hello = (hub) => hub.say({ t: 'life', life: LIFE, genesisIn: 0 });
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const make = (over: Partial<ConstructorParameters<typeof LifeClient>[0]> = {}) => {
  const bus = new SnapBus();
  const client = new LifeClient({
    url: 'ws://localhost:1/v1/hub',
    index: 1,
    bus,
    scales: SCALES,
    dropEveryMs: 0,
    createSocket: () => {
      const hub = new FakeHub((h) => hello(h));
      hubs.push(hub);
      return hub;
    },
    ...over,
  });
  return { client, bus };
};

const run = async (client: LifeClient) => {
  const started = client.start();
  await vi.advanceTimersByTimeAsync(50);
  await started;
};

describe('the life client', () => {
  it('has an identity of its own that is the same every run', () => {
    expect([...lifeSeedOf(3)]).toEqual([...lifeSeedOf(3)]);
    expect([...lifeSeedOf(3)]).not.toEqual([...lifeSeedOf(4)]);
  });

  it('signs in, enters the water at the hub place and reports where it is', async () => {
    const { client } = make();
    await run(client);
    await vi.advanceTimersByTimeAsync(1000);
    const hub = hubs[0] as FakeHub;
    expect(client.inWater).toBe(true);
    expect(hub.find('spawn')).toBeDefined();
    expect(hub.find('where')).toMatchObject({ t: 'where' });
    client.stop();
  });

  it('accepts a court with its own signed ask', async () => {
    const { client } = make();
    await run(client);
    const hub = hubs[0] as FakeHub;
    const partner = await createIdentity(memoryKeyStore(lifeSeedOf(99)));
    const ask = signMateAsk(partner, {
      creature: 'c'.repeat(64),
      partner: (await createIdentity(memoryKeyStore(lifeSeedOf(1)))).playerId,
      partnerCreature: HEX,
      nonce: 'n'.repeat(22),
    });
    hub.say({ t: 'invite', from: partner.playerId, ask, kinship: 0, generation: 1 });
    await vi.advanceTimersByTimeAsync(2500);
    const accepted = hub.find('accept');
    expect(accepted?.ask).toMatchObject({
      creature: HEX,
      partner: partner.playerId,
      partnerCreature: 'c'.repeat(64),
      nonce: 'n'.repeat(22),
    });
    expect(accepted?.ask.sig).not.toBe(ask.sig);
    expect(client.mateState).toBe('signing');
    client.stop();
  });

  it('drops during a beacon wait and finds its egg waiting when it signs in again', async () => {
    const { client } = make({ dropEveryMs: 1, absenceMs: [1000, 1000] });
    // The second sign-in names the mating in flight, as the hub does (ADR 0076).
    let signIns = 0;
    hello = (hub) => {
      signIns++;
      hub.say({
        t: 'life',
        life: LIFE,
        genesisIn: 0,
        ...(signIns > 1
          ? { mating: { commit: 'e'.repeat(64), round: 5, partner: 'Other' } as never }
          : {}),
      });
    };
    await run(client);
    await vi.advanceTimersByTimeAsync(2000);
    expect(client.stats.drops).toBeGreaterThan(0);
    expect(hubs[0]?.closed).toBe(true);
    await vi.advanceTimersByTimeAsync(3000);
    expect(hubs.length).toBeGreaterThan(1);
    expect(client.mateState).toBe('awaiting');
    client.stop();
  });

  it('engages with both signed snapshots', async () => {
    const { client, bus } = make({ huntPerSecond: 1 });
    const partner = await createIdentity(memoryKeyStore(lifeSeedOf(98)));
    // The peer the hub shows is hunting too, beside the spawn point.
    const snap: Snapshot = {
      seq: 1,
      tick: 0,
      x: CENTRE + 20,
      y: CENTRE,
      heading: 0,
      vx: 0,
      vy: 0,
      biomass: 100,
      energy: 0.5,
      health: 0.5,
      alive: true,
      dashing: false,
      ready: false,
      egg: false,
      spawnProtected: false,
      fighting: false,
      genomeRef: 0,
    };
    const signed = signSnap(partner, WORLD.id, encodeSnapshot(snap));
    await run(client);
    const refresh = setInterval(() => {
      bus.post(OTHER, signed, snap, Date.now());
      bus.hunt(OTHER, Date.now() + 60_000);
    }, 100);
    await vi.advanceTimersByTimeAsync(20_000);
    clearInterval(refresh);
    const engage = hubs[0]?.find('engage');
    expect(engage?.target).toBe(OTHER);
    expect(engage?.theirs).toEqual(signed);
    const me = await createIdentity(memoryKeyStore(lifeSeedOf(1)));
    expect(verifySnap(me.playerId, WORLD.id, engage?.mine as never)).toMatchObject({ alive: true });
    expect(client.stats.engages).toBeGreaterThan(0);
    client.stop();
  });

  it('answers a lock-ask with its own fresh snapshot', async () => {
    const { client } = make();
    await run(client);
    const hub = hubs[0] as FakeHub;
    hub.say({ t: 'lock-ask', lock: 'f'.repeat(64), by: OTHER });
    await vi.advanceTimersByTimeAsync(10);
    const answer = hub.find('lock-state');
    expect(answer?.lock).toBe('f'.repeat(64));
    const me = await createIdentity(memoryKeyStore(lifeSeedOf(1)));
    expect(verifySnap(me.playerId, WORLD.id, answer?.mine as never)).not.toBeNull();
    client.stop();
  });
});

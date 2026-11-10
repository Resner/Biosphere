import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeToBase64url } from '../src/genome/codec';
import { genesisGenome } from '../src/genome/genesis';
import { createIdentity, memoryKeyStore } from '../src/ledger/identity';
import { signMateAsk } from '../src/ledger/mate-ask';
import { signSnap, verifySnap } from '../src/ledger/snapshot-sig';
import type { SocketLike } from '../src/net/hub-client';
import {
  type ClientMsg,
  encodeSnapshot,
  type HubMsg,
  type SignedSnap,
  type Snapshot,
} from '../src/net/protocol';
import { ENC_MAX_FRAME } from '../src/net/protocol-defs';
import { FRAME_MS } from '../src/net/referee';
import { seedFromString } from '../src/sim/prng';
import { RULES, TICK_HZ } from '../src/sim/rules';
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
  /** When each message in `sent` arrived (the fake clock). */
  readonly at: number[] = [];
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
    this.at.push(Date.now());
    if (msg.t === 'hello') {
      this.say({ t: 'welcome', world: WORLD, ice: [], turn: false, now: Date.now() + hubAhead });
      this.hello(this);
    } else if (msg.t === 'ping') {
      this.say({ t: 'pong', id: msg.id, now: Date.now() + hubAhead });
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
/** How far the hub's clock is ahead of the page's at the welcome (ms). */
let hubAhead = 0;
let hello: (hub: FakeHub) => void;
beforeEach(() => {
  hubs = [];
  hubAhead = 0;
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
    const posted: SignedSnap[] = [];
    await run(client);
    // The peer's snapshots are of the pond's present, as the hub takes them (`fresh`).
    const refresh = setInterval(() => {
      const fresh = { ...snap, tick: Math.floor((Date.now() * TICK_HZ) / 1000) };
      const signed = signSnap(partner, WORLD.id, encodeSnapshot(fresh));
      posted.push(signed);
      bus.post(OTHER, signed, fresh, Date.now());
      bus.hunt(OTHER, Date.now() + 60_000);
    }, 100);
    await vi.advanceTimersByTimeAsync(20_000);
    clearInterval(refresh);
    const engage = hubs[0]?.find('engage');
    expect(engage?.target).toBe(OTHER);
    expect(posted).toContainEqual(engage?.theirs);
    const me = await createIdentity(memoryKeyStore(lifeSeedOf(1)));
    expect(verifySnap(me.playerId, WORLD.id, engage?.mine as never)).toMatchObject({ alive: true });
    expect(client.stats.engages).toBeGreaterThan(0);
    client.stop();
  });

  it('does not engage with a snapshot the hub would call stale', async () => {
    const { client, bus } = make({ huntPerSecond: 1 });
    const partner = await createIdentity(memoryKeyStore(lifeSeedOf(97)));
    const snap = {
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
    } satisfies Snapshot;
    // Tick 0 is a long way behind the pond's clock.
    const old = signSnap(partner, WORLD.id, encodeSnapshot(snap));
    await run(client);
    const stale = setInterval(() => {
      bus.post(OTHER, old, snap, Date.now());
      bus.hunt(OTHER, Date.now() + 60_000);
    }, 100);
    await vi.advanceTimersByTimeAsync(20_000);
    clearInterval(stale);
    expect(hubs[0]?.find('engage')).toBeUndefined();
    expect(client.stats.engages).toBe(0);
    client.stop();
  });

  it('claims no more ticks than the time since it entered the water', async () => {
    const { client } = make();
    await run(client);
    const hub = hubs[0] as FakeHub;
    await vi.advanceTimersByTimeAsync(5000);
    // A later clock sample puts the hub's clock 20 s ahead of the page's: the pond clock jumps and
    // the creature plays up to it, but that time did not pass.
    hubAhead = 20_000;
    await vi.advanceTimersByTimeAsync(60_000);
    const reports = hub.sent.filter((m) => m.t === 'progress');
    expect(reports.length).toBeGreaterThan(0);
    const last = reports.at(-1) as Extract<ClientMsg, { t: 'progress' }>;
    expect(last.ticks).toBeGreaterThan(0);
    expect(last.ticks).toBeLessThanOrEqual(66 * TICK_HZ);
    client.stop();
  });

  it('holds its periodic reports back while the hub rate window is nearly full', async () => {
    const { client } = make();
    const socket = (client as unknown as { socket(url: string): SocketLike }).socket('ws://x');
    const hub = hubs[0] as FakeHub;
    const types = () => hub.sent.map((m) => m.t);
    socket.send(JSON.stringify({ t: 'where', x: 1, y: 1, r: 10, aoi: 233 }));
    expect(types()).toEqual(['where']);
    // 15 sends inside the window (a reconnect's burst): the periodic reports wait, the rest go.
    for (let i = 0; i < 14; i++) socket.send(JSON.stringify({ t: 'ping', id: i, now: 0 }));
    socket.send(JSON.stringify({ t: 'where', x: 2, y: 2, r: 10, aoi: 233 }));
    socket.send(JSON.stringify({ t: 'gone' }));
    expect(types().filter((t) => t === 'where')).toHaveLength(1);
    expect(types().at(-1)).toBe('gone');
    await vi.advanceTimersByTimeAsync(10_001);
    socket.send(JSON.stringify({ t: 'where', x: 3, y: 3, r: 10, aoi: 233 }));
    expect(types().filter((t) => t === 'where')).toHaveLength(2);
  });

  it('does not send the inputs a starved loop missed', () => {
    const { client } = make({ scripted: true });
    const sent: ClientMsg[] = [];
    const inner = client as unknown as {
      fight: { enc: string; at: number; sentTo: number; heard: number };
      hub: { send(m: ClientMsg): void };
      fightInputs(t: number): void;
    };
    inner.hub = { send: (m) => sent.push(m) };
    inner.fight = { enc: 'e'.repeat(64), at: 0, sentTo: 3, heard: 10_000 };
    // 20 s later (about 200 frames behind): only the frames near the clock go out.
    inner.fightInputs(20_000);
    inner.fightInputs(20_000);
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.length).toBeLessThanOrEqual(8);
    const frames = sent.map((m) => (m as Extract<ClientMsg, { t: 'input' }>).f);
    expect(Math.min(...frames)).toBeGreaterThan(Math.floor(20_000 / FRAME_MS) - 8);
  });

  it('sends no input far ahead of the last frame it heard', () => {
    const { client } = make({ scripted: true });
    const sent: ClientMsg[] = [];
    const inner = client as unknown as {
      fight: { enc: string; at: number; sentTo: number; heard: number };
      hub: { send(m: ClientMsg): void };
      fightInputs(t: number): void;
      identity: { playerId: string };
      onFight(m: { t: 'enc-frame'; enc: string; f: number; i: (number | null)[] }): void;
    };
    inner.hub = { send: (m) => sent.push(m) };
    inner.identity = { playerId: 'p' };
    const enc = 'e'.repeat(64);
    inner.fight = { enc, at: 0, sentTo: -1, heard: -1 };
    // A minute on the clock, nothing heard: the stream is behind, so the inputs wait for it.
    for (let i = 0; i < 20; i++) inner.fightInputs(60_000 + i * 100);
    const frames = () => sent.map((m) => (m as Extract<ClientMsg, { t: 'input' }>).f);
    expect(Math.max(...frames())).toBeLessThanOrEqual(12);
    // Frames heard from another fight don't count; its own do.
    inner.onFight({ t: 'enc-frame', enc: 'd'.repeat(64), f: 500, i: [] });
    for (let i = 0; i < 20; i++) inner.fightInputs(60_000 + i * 100);
    expect(Math.max(...frames())).toBeLessThanOrEqual(12);
    inner.onFight({ t: 'enc-frame', enc, f: 40, i: [] });
    for (let i = 0; i < 20; i++) inner.fightInputs(60_000 + i * 100);
    expect(Math.max(...frames())).toBe(52);
  });

  it('sends no input past the last frame the protocol names', () => {
    const { client } = make({ scripted: true });
    const sent: ClientMsg[] = [];
    const inner = client as unknown as {
      fight: { enc: string; at: number; sentTo: number; heard: number };
      hub: { send(m: ClientMsg): void };
      fightInputs(t: number): void;
    };
    inner.hub = { send: (m) => sent.push(m) };
    inner.fight = { enc: 'e'.repeat(64), at: 0, sentTo: ENC_MAX_FRAME - 2, heard: 10_000 };
    for (let i = 0; i < 5; i++) inner.fightInputs(200_000 + i * 100);
    const frames = sent.map((m) => (m as Extract<ClientMsg, { t: 'input' }>).f);
    expect(frames.length).toBeGreaterThan(0);
    expect(Math.max(...frames)).toBe(ENC_MAX_FRAME);
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

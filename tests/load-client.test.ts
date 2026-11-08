import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SocketLike } from '../src/net/hub-client';
import type { ClientMsg, HubMsg } from '../src/net/protocol';
import { LoadClient, seedOf } from './load-client';

const HEX = 'a'.repeat(64);
/** A player id as the wire has it: 43 base64url characters. */
const OTHER = 'B'.repeat(43);
const THIRD = 'C'.repeat(43);
const LIFE = {
  creature: HEX,
  seq: 0,
  genome: 'Ab-_09'.repeat(100),
  biomass: 40_000,
  energy: 9_000,
  health: 5_000,
  activeMs: 600_000,
  lifespanMs: 4_500_000,
  matureAtMs: 900_000,
  cooldownUntilMs: 0,
};

/** A hub that signs the client in, gives it a creature, places it and answers each `where`. */
class FakeHub implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly sent: ClientMsg[] = [];
  closed = false;
  constructor() {
    queueMicrotask(() => this.say({ t: 'challenge', nonce: `${'d'.repeat(21)}Q` }));
  }
  say(msg: HubMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  send(data: string) {
    const msg = JSON.parse(data) as ClientMsg;
    this.sent.push(msg);
    if (msg.t === 'hello') {
      this.say({
        t: 'welcome',
        world: { id: 'p1', seed: 'seed', epoch: 0, centre: { x: 0, y: 0 }, size: 24 },
        ice: [],
        turn: false,
        now: 1_000_000,
      });
      this.say({ t: 'life', life: LIFE, genesisIn: 0 });
    } else if (msg.t === 'spawn') {
      this.say({ t: 'spawn', x: 5000, y: 6000, why: 'placed', protect: true });
    } else if (msg.t === 'where') {
      this.say({
        t: 'near',
        leaf: { x: 0, y: 0, size: 1024 },
        peers: [{ id: OTHER, name: 'Other', x: 5100, y: 6000, r: 10, age: 5, n: 0 }],
        swarm: [],
      });
    } else if (msg.t === 'signal' && msg.kind === 'offer') {
      this.say({ t: 'signal', from: msg.to, kind: 'answer', sdp: msg.sdp });
    }
  }
  close() {
    this.closed = true;
  }
  count(t: ClientMsg['t']) {
    return this.sent.filter((m) => m.t === t).length;
  }
}

let hubs: FakeHub[];
beforeEach(() => {
  hubs = [];
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

const make = (index = 1, offersPerMinute = 6, answerOffers = true) =>
  new LoadClient({
    url: 'ws://hub.test/v1/hub',
    index,
    offersPerMinute,
    answerOffers,
    createSocket: () => {
      const hub = new FakeHub();
      hubs.push(hub);
      return hub;
    },
  });

describe('the load client', () => {
  it('has an identity of its own that is the same every run', () => {
    expect([...seedOf(3)]).toEqual([...seedOf(3)]);
    expect([...seedOf(3)]).not.toEqual([...seedOf(4)]);
    expect(seedOf(0).length).toBe(32);
  });

  it('signs in, spawns, offers itself as a witness and reports where it is, counting what it sends', async () => {
    const client = make();
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const hub = hubs[0] as FakeHub;
    expect(client.inWater).toBe(true);
    expect(hub.sent.map((m) => m.t).slice(0, 2)).toEqual(['hello', 'ping']);
    expect(hub.sent.find((m) => m.t === 'spawn')).toEqual({ t: 'spawn', r: 10, aoi: 233 });
    expect(hub.sent.find((m) => m.t === 'avail')).toEqual({ t: 'avail', on: true });
    // The first step reports at once, from the hub's spawn point.
    const where = hub.sent.find((m) => m.t === 'where');
    expect(where).toMatchObject({ t: 'where', r: 10, aoi: 233 });
    expect(client.stats.sent.hello).toBe(1);
    expect(client.stats.sent.where).toBe(1);
    expect(client.stats.received.near).toBe(1);
    expect(client.stats.nearRtt).toHaveLength(1);
    client.leave();
  });

  it('keeps a steady cadence: a where every 30 s, a progress every 30 s and its offers, each answered', async () => {
    const client = make(2, 6);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const hub = hubs[0] as FakeHub;
    await vi.advanceTimersByTimeAsync(60_000);
    // At 6 offers a minute: about 6 in a minute.
    expect(client.stats.offers).toBeGreaterThanOrEqual(5);
    expect(client.stats.offers).toBeLessThanOrEqual(7);
    expect(client.stats.answers).toBe(client.stats.offers);
    const progress = hub.sent.filter((m) => m.t === 'progress');
    expect(progress).toHaveLength(2);
    // The ticks stay under the wall time, and the condition is the creature's own.
    const [first, second] = progress as Extract<ClientMsg, { t: 'progress' }>[];
    expect(first?.n).toBe(1);
    expect(second?.n).toBe(2);
    expect(second?.biomass).toBe(LIFE.biomass);
    expect((second?.ticks ?? 0) <= 60 * 30).toBe(true);
    expect((second?.ticks ?? 0) > (first?.ticks ?? 0)).toBe(true);
    // Never two wheres within 2 s, and one at least every 30 s.
    expect(hub.count('where')).toBeGreaterThanOrEqual(2);
    expect(hub.count('where')).toBeLessThanOrEqual(4);
    client.leave();
  });

  it('answers an offer it is sent', async () => {
    const client = make(3, 0);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const hub = hubs[0] as FakeHub;
    hub.say({ t: 'signal', from: THIRD, kind: 'offer', sdp: 'x' });
    expect(hub.sent.at(-1)).toEqual({
      t: 'signal',
      to: THIRD,
      kind: 'answer',
      sdp: 'v=0 load',
    });
    client.leave();
  });

  it('stays silent to an offer when it is told not to answer', async () => {
    const client = make(3, 0, false);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const hub = hubs[0] as FakeHub;
    const before = hub.sent.length;
    hub.say({ t: 'signal', from: THIRD, kind: 'offer', sdp: 'x' });
    expect(hub.sent).toHaveLength(before);
    client.leave();
  });

  it('leaves with a gone and a close, once, and sends nothing after', async () => {
    const client = make(4);
    const started = client.start();
    await vi.advanceTimersByTimeAsync(10);
    await started;
    const hub = hubs[0] as FakeHub;
    client.leave();
    client.leave();
    expect(hub.count('gone')).toBe(1);
    expect(hub.closed).toBe(true);
    expect(client.inWater).toBe(false);
    const before = hub.sent.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(hub.sent.length).toBe(before);
    // A close it asked for is not a close it suffered.
    expect(client.stats.closes).toEqual({});
  });
});

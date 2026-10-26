import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIdentity,
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  type Identity,
  memoryKeyStore,
  verify,
} from '../ledger/identity';
import { HubClient, type HubClientOptions, type HubStatus, type SocketLike } from './hub-client';
import { CLOSE_BAD_HELLO, CLOSE_REPLACED, type ClientMsg, type HubMsg } from './protocol';

const NONCE = `${'d'.repeat(21)}Q`;
const NAME = 'Tester_1';
const OFFSET = 5000;

class FakeSocket implements SocketLike {
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  sent: ClientMsg[] = [];
  closed = false;
  constructor(readonly url: string) {}
  send(data: string) {
    this.sent.push(JSON.parse(data) as ClientMsg);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  receive(msg: HubMsg) {
    this.onmessage?.({ data: JSON.stringify(msg) });
  }
  drop(code = 1006) {
    this.onclose?.({ code });
  }
}

const welcome = (now = 1_000_000): HubMsg => ({
  t: 'welcome',
  pond: { id: 'p1', seed: 'seed', epoch: 0, centre: { x: 0, y: 0 }, size: 24 },
  you: { spawnHint: { x: 1, y: 2 } },
  members: [],
  ice: [],
  turn: false,
  now,
});

let sockets: FakeSocket[];
let identity: Identity;
let statuses: HubStatus[];

const make = (fetchHealth?: HubClientOptions['fetchHealth']) => {
  const client = new HubClient({
    fetchHealth,
    url: 'ws://hub.test/v1/ws',
    identity,
    name: NAME,
    createSocket: (url) => {
      const s = new FakeSocket(url);
      sockets.push(s);
      return s;
    },
    seed: 'test',
  });
  client.onStatus((s) => statuses.push(s));
  return client;
};
const last = () => sockets[sockets.length - 1] as FakeSocket;

/** Opens the latest socket, answers the challenge and the welcome. */
async function handshake() {
  const s = last();
  s.open();
  s.receive({ t: 'challenge', nonce: NONCE });
  s.receive(welcome());
  await vi.advanceTimersByTimeAsync(0);
  return s;
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1_000_000);
  sockets = [];
  statuses = [];
  identity = await createIdentity(memoryKeyStore(new Uint8Array(32).fill(7)));
});
afterEach(() => vi.useRealTimers());

describe('HubClient connect', () => {
  it('answers the challenge with a verifiable hello and resolves with the welcome', async () => {
    const client = make();
    const p = client.connect();
    expect(client.status).toBe('connecting');
    const s = last();
    s.open();
    s.receive({ t: 'challenge', nonce: NONCE });
    const hello = s.sent[0];
    expect(hello?.t).toBe('hello');
    if (hello?.t !== 'hello') throw new Error('no hello');
    expect(hello.playerId).toBe(identity.playerId);
    expect(hello.name).toBe(NAME);
    const msg = helloMessage(NONCE, NAME);
    const sig = fromBase64Url(hello.sig);
    expect(msg && sig && verify(identity.playerId, HELLO_DOMAIN, msg, sig)).toBe(true);
    s.receive(welcome());
    const w = await p;
    expect(w.pond.id).toBe('p1');
    expect(w.you.spawnHint).toEqual({ x: 1, y: 2 });
    expect(client.status).toBe('online');
  });

  it('ignores malformed and binary messages', async () => {
    const client = make();
    void client.connect().catch(() => {});
    const s = last();
    s.open();
    s.onmessage?.({ data: 'not json' });
    s.onmessage?.({ data: new ArrayBuffer(8) });
    expect(client.dropped).toBe(2);
    expect(client.status).toBe('connecting');
  });

  it('forwards signals and member events', async () => {
    const client = make();
    const signals: unknown[] = [];
    const members: unknown[] = [];
    client.onSignal((m) => signals.push(m));
    client.onMember((op, m) => members.push([op, m.name]));
    void client.connect().catch(() => {});
    const s = await handshake();
    const from = 'A'.repeat(43);
    s.receive({ t: 'signal', from, kind: 'offer', sdp: 'v=0' });
    s.receive({ t: 'member', op: 'join', member: { playerId: from, name: 'Other' } });
    expect(signals).toEqual([{ t: 'signal', from, kind: 'offer', sdp: 'v=0' }]);
    expect(members).toEqual([['join', 'Other']]);
    client.send({ t: 'leave' });
    expect(s.sent.at(-1)).toEqual({ t: 'leave' });
  });
});

describe('HubClient listeners', () => {
  it('forwards the hub’s word about the creature, and sends the player’s own messages', async () => {
    const client = make();
    const heard: unknown[] = [];
    client.onLife((m) => heard.push(m));
    void client.connect().catch(() => {});
    const s = await handshake();
    s.receive({ t: 'life', life: null, genesisIn: 0 });
    s.receive({ t: 'ack', n: 1, activeMs: 30_000, lifespanMs: 4_500_000 });
    s.receive({ t: 'refused', reason: 'limit', genesisIn: 5 });
    expect(heard).toEqual([
      { t: 'life', life: null, genesisIn: 0 },
      { t: 'ack', n: 1, activeMs: 30_000, lifespanMs: 4_500_000 },
      { t: 'refused', reason: 'limit', genesisIn: 5 },
    ]);
    client.send({ t: 'progress', n: 1, ticks: 900, biomass: 1, energy: 1, health: 1 });
    expect(s.sent.at(-1)).toEqual({
      t: 'progress',
      n: 1,
      ticks: 900,
      biomass: 1,
      energy: 1,
      health: 1,
    });
  });

  it('a throwing listener does not stop the others or the receive path', async () => {
    const client = make();
    const signals: unknown[] = [];
    const welcomes: unknown[] = [];
    client.onSignal(() => {
      throw new Error('boom');
    });
    client.onSignal((m) => signals.push(m));
    client.onWelcome(() => {
      throw new Error('boom');
    });
    client.onWelcome((m) => welcomes.push(m.t));
    void client.connect().catch(() => {});
    const s = await handshake();
    s.receive({ t: 'signal', from: 'A'.repeat(43), kind: 'offer', sdp: 'v=0' });
    expect(signals).toHaveLength(1);
    expect(welcomes).toEqual(['welcome']);
  });
});

describe('HubClient reconnect', () => {
  it('backs off 1, 2, 4, 8, 16, 30, 30 s with ±20% jitter', async () => {
    const client = make();
    void client.connect().catch(() => {});
    const expected = [1, 2, 4, 8, 16, 30, 30];
    for (const sec of expected) {
      const before = sockets.length;
      last().drop();
      expect(client.status).toBe('offline');
      await vi.advanceTimersByTimeAsync(sec * 1000 * 0.8 - 1);
      expect(sockets.length).toBe(before);
      await vi.advanceTimersByTimeAsync(sec * 1000 * 0.4 + 2);
      expect(sockets.length).toBe(before + 1);
    }
  });

  it('is deterministic for a given seed', async () => {
    const delays = async () => {
      sockets = [];
      const client = make();
      void client.connect().catch(() => {});
      const out: number[] = [];
      for (let i = 0; i < 4; i++) {
        last().drop();
        const t0 = Date.now();
        const n = sockets.length;
        while (sockets.length === n) await vi.advanceTimersByTimeAsync(10);
        out.push(Date.now() - t0);
      }
      client.close();
      return out;
    };
    expect(await delays()).toEqual(await delays());
  });

  it('resets the backoff after a welcome', async () => {
    const client = make();
    void client.connect().catch(() => {});
    last().drop();
    await vi.advanceTimersByTimeAsync(1500);
    last().drop();
    await vi.advanceTimersByTimeAsync(2500);
    await handshake();
    expect(client.status).toBe('online');
    last().drop();
    const n = sockets.length;
    await vi.advanceTimersByTimeAsync(1300);
    expect(sockets.length).toBe(n + 1);
  });

  it('does not reconnect after 4001 and reports replaced', async () => {
    const client = make();
    const p = client.connect();
    p.catch(() => {});
    await handshake();
    const n = sockets.length;
    last().drop(CLOSE_REPLACED);
    expect(client.status).toBe('replaced');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(n);
  });

  it('reports outdated on a version error and does not reconnect', async () => {
    const client = make();
    const p = client.connect();
    p.catch(() => {});
    const s = last();
    s.open();
    s.receive({ t: 'challenge', nonce: NONCE });
    s.receive({ t: 'error', code: 'version' });
    s.drop(CLOSE_BAD_HELLO);
    expect(client.status).toBe('outdated');
    await expect(p).rejects.toThrow('outdated');
    const n = sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(n);
  });

  it('keeps retrying after a 4002 that is not a version error', async () => {
    const client = make();
    void client.connect().catch(() => {});
    last().open();
    last().drop(CLOSE_BAD_HELLO);
    const n = sockets.length;
    await vi.advanceTimersByTimeAsync(1500);
    expect(sockets.length).toBe(n + 1);
  });

  it('reports outdated when the health check names another protocol', async () => {
    const urls: string[] = [];
    const client = make(async (url) => {
      urls.push(url);
      return { ok: true, version: '9.9.9', protocol: 2 };
    });
    void client.connect().catch(() => {});
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls).toEqual(['http://hub.test/v1/health']);
    expect(client.status).toBe('outdated');
    const n = sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(n);
  });

  it('keeps retrying when the health check agrees or fails', async () => {
    let calls = 0;
    const client = make(async () => {
      calls++;
      if (calls === 1) throw new Error('offline');
      return { protocol: 1 };
    });
    void client.connect().catch(() => {});
    last().open();
    last().drop();
    await vi.advanceTimersByTimeAsync(1500);
    last().drop();
    await vi.advanceTimersByTimeAsync(2500);
    expect(client.status).toBe('connecting');
    expect(sockets.length).toBe(3);
  });

  it('reports each status change once', async () => {
    const client = make();
    void client.connect().catch(() => {});
    await handshake();
    last().drop();
    await vi.advanceTimersByTimeAsync(1500);
    last().drop();
    expect(statuses).toEqual(['connecting', 'online', 'offline', 'connecting', 'offline']);
  });

  it('connect() while online resolves with the last welcome, without a new socket', async () => {
    const client = make();
    void client.connect().catch(() => {});
    await handshake();
    const n = sockets.length;
    expect((await client.connect()).pond.id).toBe('p1');
    expect(sockets.length).toBe(n);
  });

  it('connect() while offline reconnects at once', async () => {
    const client = make();
    void client.connect().catch(() => {});
    last().drop();
    const n = sockets.length;
    void client.connect().catch(() => {});
    expect(sockets.length).toBe(n + 1);
    expect(client.status).toBe('connecting');
  });
});

describe('HubClient clock', () => {
  it('pings after the welcome, estimates the offset and pings once a minute', async () => {
    const client = make();
    void client.connect().catch(() => {});
    const s = await handshake();
    // Answer each ping 20 ms later with the hub clock OFFSET ahead; the pong lands 20 ms after that.
    const answered = new Set<number>();
    const step = async (ms: number) => {
      for (let t = 0; t < ms; t += 20) {
        for (const m of s.sent) {
          if (m.t !== 'ping' || answered.has(m.id)) continue;
          answered.add(m.id);
          const now = Date.now() + 20 + OFFSET;
          setTimeout(() => s.receive({ t: 'pong', id: m.id, now }), 40);
        }
        await vi.advanceTimersByTimeAsync(20);
      }
    };
    await step(3000);
    const pings = s.sent.filter((m) => m.t === 'ping').length;
    expect(pings).toBeGreaterThanOrEqual(8);
    expect(pings).toBeLessThanOrEqual(10);
    expect(client.clock.rtt).toBe(40);
    expect(Math.abs(client.clock.hubNow(Date.now()) - (Date.now() + OFFSET))).toBeLessThan(20);
    const before = s.sent.length;
    await vi.advanceTimersByTimeAsync(61_000);
    expect(s.sent.slice(before).filter((m) => m.t === 'ping').length).toBe(1);
  });

  it('ignores a pong with an unknown id', async () => {
    const client = make();
    void client.connect().catch(() => {});
    const s = await handshake();
    s.receive({ t: 'pong', id: 9999, now: 1 });
    expect(client.clock.offset).toBeNull();
  });
});

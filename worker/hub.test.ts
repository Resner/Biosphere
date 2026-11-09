import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createIdentity,
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  memoryKeyStore,
  toBase64Url,
} from '../src/ledger/identity';
import {
  CLOSE_BAD_HELLO,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  type HubMsg,
  NONCE_BYTES,
  PROTOCOL_VERSION,
  parseHubMsg,
  SDP_MAX_BYTES,
} from '../src/net/protocol';
import { heavyTest } from '../tests/heavy';
import { anchorAt } from './test-hub';

const ORIGIN = 'https://resner.github.io';

const stub = () => env.AUTHORITY.get(env.AUTHORITY.idFromName('global'));
/** Moves the clock the Authority sees forward, as if `ms` had passed. */
const skip = (ms: number) => vi.spyOn(Date, 'now').mockReturnValue(Date.now() + ms);

interface Client {
  ws: WebSocket;
  inbox: HubMsg[];
  closed: Promise<number>;
  next(): Promise<HubMsg>;
  send(msg: unknown): void;
}

async function connect(): Promise<Client> {
  const res = await exports.default.fetch('https://authority.test/v1/hub', {
    headers: { Upgrade: 'websocket', Origin: ORIGIN },
  });
  const ws = res.webSocket;
  if (!ws) throw new Error(`no WebSocket (status ${res.status})`);
  const inbox: HubMsg[] = [];
  const waiting: Array<(m: HubMsg) => void> = [];
  ws.addEventListener('message', (e) => {
    const msg = parseHubMsg(String(e.data));
    if (!msg) throw new Error(`unparseable hub message: ${String(e.data)}`);
    const waiter = waiting.shift();
    if (waiter) waiter(msg);
    else inbox.push(msg);
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener('close', (e) => resolve(e.code)),
  );
  ws.accept();
  return {
    ws,
    inbox,
    closed,
    next: () => {
      const queued = inbox.shift();
      if (queued) return Promise.resolve(queued);
      return new Promise<HubMsg>((resolve) => waiting.push(resolve));
    },
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  };
}

const sockets: Client[] = [];
async function open(): Promise<Client> {
  const c = await connect();
  sockets.push(c);
  return c;
}

async function challenge(c: Client): Promise<string> {
  const msg = await c.next();
  if (msg.t !== 'challenge') throw new Error(`expected challenge, got ${msg.t}`);
  return msg.nonce;
}

async function makeHello(nonce: string, name = 'Alice', store = memoryKeyStore()) {
  const id = await createIdentity(store);
  const sig = toBase64Url(id.sign(HELLO_DOMAIN, helloMessage(nonce, name) ?? new Uint8Array()));
  return { id, hello: { t: 'hello', v: PROTOCOL_VERSION, playerId: id.playerId, name, sig } };
}

async function login(name = 'Alice', store = memoryKeyStore()) {
  const c = await open();
  const { id, hello } = await makeHello(await challenge(c), name, store);
  c.send(hello);
  const welcome = await c.next();
  // Every welcome is followed by the player's `life` (M4).
  if (welcome.t === 'welcome') expect((await c.next()).t).toBe('life');
  return { c, id, welcome };
}

afterEach(async () => {
  vi.restoreAllMocks();
  const open = sockets.splice(0);
  for (const c of open) {
    try {
      c.ws.close(1000, 'done');
    } catch {
      // already closed
    }
  }
  await Promise.all(open.map((c) => c.closed));
  // The Authority and its storage outlive a test, so leave no world row behind.
  await runInDurableObject(stub(), (_o, state) => {
    state.storage.sql.exec('DELETE FROM ponds');
  });
});

describe('hub hello', () => {
  it('sends a 16-byte random nonce challenge on connect', async () => {
    const a = await open();
    const b = await open();
    const [na, nb] = [await challenge(a), await challenge(b)];
    expect(fromBase64Url(na)?.length).toBe(NONCE_BYTES);
    expect(na).not.toBe(nb);
  });

  it('welcomes a valid signed hello', async () => {
    const { welcome } = await login();
    expect(welcome.t).toBe('welcome');
    if (welcome.t !== 'welcome') return;
    expect(welcome).not.toHaveProperty('members');
    expect(welcome.now).toBeGreaterThan(0);
  });

  it('closes 4002 on a bad signature', async () => {
    const c = await open();
    const { hello } = await makeHello(await challenge(c));
    const flipped = hello.sig.startsWith('A') ? `B${hello.sig.slice(1)}` : `A${hello.sig.slice(1)}`;
    c.send({ ...hello, sig: flipped });
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it('closes 4002 when the signature covers another nonce', async () => {
    const c = await open();
    await challenge(c);
    const { hello } = await makeHello(toBase64Url(new Uint8Array(NONCE_BYTES)));
    c.send(hello);
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it('closes 4002 when the signed name differs from the sent name', async () => {
    const c = await open();
    const { hello } = await makeHello(await challenge(c), 'Alice');
    c.send({ ...hello, name: 'Mallory' });
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it.each(['ab', 'a'.repeat(17), 'bad name', 'ümlaut', 'x<y', 'Fuck', 'f_u_c_k', 'Arschloch'])(
    'closes 4002 for the name %j',
    async (name) => {
      const c = await open();
      const { hello } = await makeHello(await challenge(c), name);
      c.send(hello);
      expect(await c.closed).toBe(CLOSE_BAD_HELLO);
    },
  );

  it.each([1, 6, 7, 8, 9, 10, 11, 12, 13])('closes 4002 for protocol version %i', async (v) => {
    const c = await open();
    const { hello } = await makeHello(await challenge(c));
    c.send({ ...hello, v });
    expect(await c.next()).toEqual({ t: 'error', code: 'version' });
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it.each([
    ['garbage', 'not json'],
    ['a ping before hello', '{"t":"ping","id":1}'],
    ['a leave before hello', '{"t":"leave"}'],
  ])('closes 4002 for %s as the first message', async (_label, raw) => {
    const c = await open();
    await challenge(c);
    c.send(raw);
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it('closes 4002 for a second hello', async () => {
    const { c, id } = await login();
    const nonce = toBase64Url(new Uint8Array(NONCE_BYTES));
    const again = await makeHello(nonce, 'Alice', memoryKeyStore());
    expect(id.playerId).not.toBe(again.id.playerId);
    c.send(again.hello);
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it('closes 4002 after 10 s without a hello', async () => {
    const c = await open();
    await challenge(c);
    skip(11_000);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await c.closed).toBe(CLOSE_BAD_HELLO);
  });

  it('keeps a logged-in socket when the hello timer fires', async () => {
    const { c } = await login();
    skip(11_000);
    await runDurableObjectAlarm(stub());
    c.send({ t: 'ping', id: 1 });
    expect((await c.next()).t).toBe('pong');
  });
});

describe('single session', () => {
  it('welcomes the newer session and closes the older with 4001', async () => {
    const store = memoryKeyStore();
    const first = await login('Alice', store);
    const second = await login('Alice', store);
    expect(second.welcome.t).toBe('welcome');
    expect(await first.c.closed).toBe(CLOSE_REPLACED);
    second.c.send({ t: 'ping', id: 5 });
    expect((await second.c.next()).t).toBe('pong');
  });

  it('keeps different players side by side', async () => {
    const a = await login('Alice');
    const b = await login('Bob');
    expect(b.welcome.t).toBe('welcome');
    a.c.send({ t: 'ping', id: 1 });
    expect((await a.c.next()).t).toBe('pong');
  });
});

describe('ping and leave', () => {
  it('answers ping with pong carrying the DO clock', async () => {
    const { c } = await login();
    const before = Date.now();
    c.send({ t: 'ping', id: 77 });
    const pong = await c.next();
    expect(pong.t).toBe('pong');
    if (pong.t !== 'pong') return;
    expect(pong.id).toBe(77);
    expect(pong.now).toBeGreaterThanOrEqual(before);
    expect(pong.now).toBeLessThanOrEqual(Date.now());
  });

  it('closes the socket normally on leave', async () => {
    const { c } = await login();
    c.send({ t: 'leave' });
    expect(await c.closed).toBe(1000);
  });
});

describe('rate limit', () => {
  it('closes 4003 above 20 messages in 10 s', async () => {
    const { c } = await login();
    for (let i = 0; i < 25; i++) c.send({ t: 'ping', id: i });
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });

  it('leaves normal traffic alone', async () => {
    const { c } = await login();
    for (let i = 0; i < 15; i++) {
      c.send({ t: 'ping', id: i });
      expect((await c.next()).t).toBe('pong');
    }
  });

  it('opens a new window after 10 s', async () => {
    const { c } = await login();
    for (let i = 0; i < 15; i++) c.send({ t: 'ping', id: i });
    for (let i = 0; i < 15; i++) await c.next();
    skip(11_000);
    for (let i = 0; i < 15; i++) c.send({ t: 'ping', id: i });
    for (let i = 0; i < 15; i++) expect((await c.next()).t).toBe('pong');
  });
});

describe('hibernation and storage', () => {
  it('keeps the session after the object is evicted', async () => {
    const { c } = await login();
    await evictDurableObject(stub());
    c.send({ t: 'ping', id: 9 });
    const pong = await c.next();
    expect(pong).toMatchObject({ t: 'pong', id: 9 });
  });

  it('replaces a hibernated session too', async () => {
    const store = memoryKeyStore();
    const first = await login('Alice', store);
    await evictDurableObject(stub());
    await login('Alice', store);
    expect(await first.c.closed).toBe(CLOSE_REPLACED);
  });

  it('writes no SQLite rows for hello, ping or leave', async () => {
    const size = () => runInDurableObject(stub(), (_o, state) => state.storage.sql.databaseSize);
    const before = await size();
    const { c } = await login();
    c.send({ t: 'ping', id: 1 });
    await c.next();
    c.send({ t: 'leave' });
    await c.closed;
    expect(await size()).toBe(before);
  });
});

type Welcome = Extract<HubMsg, { t: 'welcome' }>;
const welcomeOf = (msg: HubMsg): Welcome => {
  if (msg.t !== 'welcome') throw new Error(`expected welcome, got ${msg.t}`);
  return msg;
};
const CENTRE = 131_072;

/** Logs in `n` players, in order, and returns them with their welcomes. */
async function fill(n: number) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = await login(`Pl${i}`);
    players.push({ ...p, welcome: welcomeOf(p.welcome) });
  }
  return players;
}

/** Reports a starter's position to the directory, anchored there first, and waits for its `near`. */
async function placeAt(
  p: { c: Client; id: { playerId: string } },
  x: number,
  y = CENTRE,
): Promise<void> {
  await anchorAt(p.id.playerId, x, y);
  p.c.send({ t: 'where', x, y, r: 10, aoi: 233 });
  for (;;) if ((await p.c.next()).t === 'near') return;
}

const sqlRows = <T extends Record<string, SqlStorageValue>>(query: string) =>
  runInDurableObject(stub(), (_o, state) => state.storage.sql.exec<T>(query).toArray());
const worldRows = () =>
  runInDurableObject(stub(), (_o, state) =>
    state.storage.sql.exec('SELECT id, seed, epoch, cx, cy, created FROM ponds').toArray(),
  );

describe('the world', () => {
  it('welcomes three sessions to the same world, with no members', async () => {
    const players = await fill(3);
    const [first] = players;
    for (const p of players) {
      expect(p.welcome.world).toEqual(first?.welcome.world);
      expect(p.welcome).not.toHaveProperty('members');
    }
    // Nobody hears of a joiner: there is no roster.
    for (const p of players) p.c.send({ t: 'ping', id: 1 });
    for (const p of players) expect((await p.c.next()).t).toBe('pong');
  });

  it('makes the world’s row for the first player, with the world’s seed and clock, centred on the world', async () => {
    const [world] = await sqlRows<{ seed: string; clock: number; epoch: number }>(
      'SELECT seed, clock, epoch FROM world',
    );
    expect(world?.epoch).toBe(5);
    expect(world?.seed).toMatch(/^[A-Za-z0-9_-]{16}$/);
    const { welcome } = (await fill(1))[0] ?? {};
    // The authority places each creature as it enters the water (M12 T4): no hint here.
    expect(welcome).not.toHaveProperty('you');
    expect(welcome?.world.centre).toEqual({ x: CENTRE, y: CENTRE });
    expect(welcome?.world.size).toBe(CENTRE * 2);
    expect(welcome?.world.seed).toBe(world?.seed);
    expect(welcome?.world.epoch).toBe(world?.clock);
    const rows = await worldRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: welcome?.world.id,
      seed: welcome?.world.seed,
      epoch: welcome?.world.epoch,
      cx: CENTRE,
      cy: CENTRE,
    });
  });

  it('keeps the world when everyone left, and across hibernation', async () => {
    const [a] = await fill(1);
    if (!a) throw new Error('fill');
    a.c.send({ t: 'leave' });
    await a.c.closed;
    const again = welcomeOf((await login('Again')).welcome);
    expect(again.world).toEqual(a.welcome.world);
    await evictDurableObject(stub());
    const late = welcomeOf((await login('Late')).welcome);
    expect(late.world).toEqual(a.welcome.world);
    expect(await worldRows()).toHaveLength(1);
  });

  it('writes one row for the world and nothing for joins or leaves', async () => {
    const [a, b] = await fill(2);
    b?.c.send({ t: 'leave' });
    await b?.c.closed;
    a?.c.send({ t: 'ping', id: 1 });
    await a?.c.next();
    const rows = await runInDurableObject(
      stub(),
      (_o, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            'SELECT (SELECT COUNT(*) FROM ponds) + (SELECT COUNT(*) FROM migrations) AS n',
          )
          .one().n,
    );
    expect(rows).toBe(15); // the world's row and the fourteen schema versions
  });

  it('keeps the world’s clock for a later joiner', async () => {
    const [a] = await fill(1);
    skip(60_000);
    const b = welcomeOf((await login('Later')).welcome);
    expect(b.world.epoch).toBe(a?.welcome.world.epoch);
    expect(b.now).toBeGreaterThan(b.world.epoch);
  });
});

describe('joining a crowded world', () => {
  it('lets 24 clients join one after another within the message budget', async () => {
    const closes: number[] = [];
    const joined: Array<{ playerId: string }> = [];
    const spawns = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const { c, id } = await login(`Pl${i}`);
      void c.closed.then((code) => closes.push(code));
      // What a joining client sends: the opening pings, its spawn and report, then one offer per neighbour.
      for (let p = 0; p < 8; p++) c.send({ t: 'ping', id: p });
      c.send({ t: 'spawn', r: 10, aoi: 233 });
      let at: HubMsg = await c.next();
      while (at.t !== 'spawn') at = await c.next();
      spawns.add(`${at.x},${at.y}`);
      c.send({ t: 'where', x: at.x, y: at.y, r: 10, aoi: 233 });
      for (;;) if ((await c.next()).t === 'near') break;
      for (const m of joined) c.send({ t: 'signal', to: m.playerId, kind: 'offer', sdp: 'v=0' });
      c.send({ t: 'ping', id: 999 });
      for (;;) {
        const msg = await c.next();
        if (msg.t === 'pong' && msg.id === 999) break;
      }
      joined.push({ playerId: id.playerId });
    }
    expect(closes).toEqual([]);
    expect(spawns.size).toBe(24);
  }, 30_000);

  it('closes 4003 on a flood of signals', async () => {
    const { c } = await login();
    for (let i = 0; i < 80; i++) {
      c.send({ t: 'signal', to: 'A'.repeat(43), kind: 'offer', sdp: 'v=0' });
    }
    expect(await c.closed).toBe(CLOSE_RATE_LIMITED);
  });
});

describe('signal relay', () => {
  it('delivers a signal with the verified sender and ignores a forged from', async () => {
    const [a, b] = await fill(2);
    if (!a || !b) throw new Error('fill');
    await placeAt(a, CENTRE);
    await placeAt(b, CENTRE + 300);
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: 'v=0', from: 'forged' });
    expect(await b.c.next()).toEqual({
      t: 'signal',
      from: a.id.playerId,
      kind: 'offer',
      sdp: 'v=0',
      at: [CENTRE, CENTRE, 10],
    });
  });

  it('passes a signal between sessions 3,000 wu apart, and answers no-peer 30,000 wu apart or for an unknown player', async () => {
    const [a, near, far] = await fill(3);
    if (!a || !near || !far) throw new Error('fill');
    await placeAt(a, CENTRE);
    await placeAt(near, CENTRE + 3000);
    await placeAt(far, CENTRE + 30_000);
    a.c.send({ t: 'signal', to: near.id.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await near.c.next()).toMatchObject({ t: 'signal', from: a.id.playerId });
    a.c.send({ t: 'signal', to: far.id.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await a.c.next()).toEqual({ t: 'error', code: 'no-peer' });
    const stranger = await createIdentity(memoryKeyStore());
    a.c.send({ t: 'signal', to: stranger.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await a.c.next()).toEqual({ t: 'error', code: 'no-peer' });
    far.c.send({ t: 'ping', id: 1 });
    expect(await far.c.next()).toMatchObject({ t: 'pong' }); // nothing was delivered
  });

  it('drops an sdp over 8 KB with too-big', async () => {
    const [a, b] = await fill(2);
    if (!a || !b) throw new Error('fill');
    await placeAt(a, CENTRE);
    await placeAt(b, CENTRE + 300);
    const big = 'a'.repeat(SDP_MAX_BYTES + 1);
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: big });
    expect(await a.c.next()).toEqual({ t: 'error', code: 'too-big' });
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: 'a'.repeat(SDP_MAX_BYTES) });
    const ok = await b.c.next();
    expect(ok.t).toBe('signal');
  });
});

describe('TURN credentials', () => {
  const TOKEN = 'secret-api-token-0123456789';
  const STUN = ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'];
  const TURN_ENTRY = {
    urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:5349'],
    username: 'u-1',
    credential: 'c-1',
  };

  const authority = () =>
    runInDurableObject(
      stub(),
      (o) => o as unknown as { env: Record<string, unknown>; turn: { reset(): void } },
    );
  /** Sets or clears the TURN secrets the Authority sees, and forgets any cached credentials. */
  async function secrets(on: boolean) {
    const a = await authority();
    a.env.CF_TURN_KEY_ID = on ? 'key-id' : undefined;
    a.env.CF_TURN_KEY_API_TOKEN = on ? TOKEN : undefined;
    a.turn.reset();
  }
  const cloudflare = (body: unknown = { iceServers: [{ urls: STUN }, TURN_ENTRY] }, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(body, { status }));

  afterEach(() => secrets(false));

  it('adds the TURN entry to the STUN servers and says turn: true', async () => {
    await secrets(true);
    const fetchMock = cloudflare();
    const { welcome } = await login();
    expect(welcome).toMatchObject({ t: 'welcome', turn: true });
    if (welcome.t !== 'welcome') return;
    expect(welcome.ice).toEqual([{ urls: STUN[0] }, { urls: STUN[1] }, TURN_ENTRY]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(
      'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init?.body))).toEqual({ ttl: 86_400 });
  });

  it('fetches once for ten hellos', async () => {
    await secrets(true);
    const fetchMock = cloudflare();
    for (let i = 0; i < 10; i++) await login(`Player${i}`);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fetches again once less than an hour of the TTL remains', async () => {
    await secrets(true);
    const fetchMock = cloudflare();
    await login('Alice');
    skip(86_400_000 - 3_600_000 - 1_000); // 1 h + 1 s left: still cached
    await login('Bob');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    skip(86_400_000 - 3_600_000 + 1_000); // under 1 h left
    const { welcome } = await login('Cara');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(welcome).toMatchObject({ turn: true });
  });

  it('falls back to STUN only when the secrets are missing', async () => {
    const fetchMock = cloudflare();
    const { welcome } = await login();
    expect(welcome).toMatchObject({
      t: 'welcome',
      turn: false,
      ice: [{ urls: STUN[0] }, { urls: STUN[1] }],
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-200 answer', () => cloudflare({ error: 'no' }, 500)],
    ['a malformed body', () => cloudflare({ iceServers: 'nope' })],
    ['no TURN entry', () => cloudflare({ iceServers: [{ urls: STUN }] })],
    [
      'a network error',
      () => vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error(`boom ${TOKEN}`)),
    ],
  ])('falls back to STUN only on %s', async (_label, fake) => {
    await secrets(true);
    fake();
    const { welcome } = await login();
    expect(welcome).toMatchObject({
      t: 'welcome',
      turn: false,
      ice: [{ urls: STUN[0] }, { urls: STUN[1] }],
    });
  });

  it('keeps the cached credentials when a refresh fails', async () => {
    await secrets(true);
    cloudflare();
    await login('Alice');
    skip(86_400_000 - 3_600_000 + 1_000); // under 1 h left: due for a refresh
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    const { welcome } = await login('Bob');
    expect(welcome).toMatchObject({ t: 'welcome', turn: true });
  });

  it('does not ask Cloudflare again for 30 s after a failure', async () => {
    await secrets(true);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('down'));
    await login('Alice');
    await login('Bob');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    skip(31_000);
    await login('Cara');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('makes a joiner reachable only once its welcome is sent', async () => {
    await secrets(true);
    cloudflare();
    const alice = await login('Alice');
    await secrets(true); // forget the cache so Bob's hello waits for Cloudflare
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return Response.json({ iceServers: [{ urls: STUN }, TURN_ENTRY] });
    });
    const bob = await open();
    const { id, hello } = await makeHello(await challenge(bob), 'Bob', memoryKeyStore());
    bob.send(hello);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(alice.c.inbox).toEqual([]);
    alice.c.send({ t: 'signal', to: id.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await alice.c.next()).toEqual({ t: 'error', code: 'no-peer' });
    expect(bob.inbox).toEqual([]);
    expect((await bob.next()).t).toBe('welcome');
    alice.c.send({ t: 'ping', id: 1 });
    expect((await alice.c.next()).t).toBe('pong'); // no roster: nothing announces Bob
  });

  it('welcomes a joiner once, even if it says hello twice while waiting', async () => {
    await secrets(true);
    const alice = await login('Alice');
    await secrets(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      return Response.json({ iceServers: [{ urls: STUN }, TURN_ENTRY] });
    });
    const bob = await open();
    const { hello } = await makeHello(await challenge(bob), 'Bob', memoryKeyStore());
    bob.send(hello);
    bob.send(hello);
    expect((await bob.next()).t).toBe('welcome');
    await new Promise((resolve) => setTimeout(resolve, 300));
    // One welcome, then its `life`, and nothing from the second hello.
    expect(bob.inbox.map((m) => m.t)).toEqual(['life']);
    expect(alice.c.inbox).toEqual([]);
  });

  heavyTest('does not wait more than 2 s for a hanging Cloudflare', async () => {
    await secrets(true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))),
        ),
    );
    const started = performance.now();
    const { welcome } = await login();
    expect(welcome).toMatchObject({ turn: false });
    expect(performance.now() - started).toBeLessThan(3_000);
  });

  it('never leaks the token to a response, a log line or an error', async () => {
    await secrets(true);
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
      vi.spyOn(console, k),
    );
    vi.spyOn(globalThis, 'fetch').mockRejectedValueOnce(new Error(`boom ${TOKEN}`));
    const failed = await login('Alice');
    await secrets(true);
    cloudflare();
    const ok = await login('Bob');
    const output = JSON.stringify([failed.welcome, ok.welcome, spies.map((s) => s.mock.calls)]);
    expect(output).not.toContain(TOKEN);
    expect(output.length).toBeGreaterThan(100);
  });
});

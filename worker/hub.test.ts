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
  parseHubMsg,
  SDP_MAX_BYTES,
} from '../src/net/protocol';

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
  return { id, hello: { t: 'hello', v: 1, playerId: id.playerId, name, sig } };
}

async function login(name = 'Alice', store = memoryKeyStore()) {
  const c = await open();
  const { id, hello } = await makeHello(await challenge(c), name, store);
  c.send(hello);
  const welcome = await c.next();
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
  // The Authority and its storage outlive a test, so leave no ponds behind.
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
    expect(welcome.members).toEqual([]);
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

  it('closes 4002 for a wrong protocol version', async () => {
    const c = await open();
    const { hello } = await makeHello(await challenge(c));
    c.send({ ...hello, v: 2 });
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
    await a.c.next(); // Bob joined Alice's pond
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
/** The next message that is not a roster change. */
async function nextNonMember(c: Client): Promise<HubMsg> {
  for (;;) {
    const msg = await c.next();
    if (msg.t !== 'member') return msg;
  }
}
const GOLDEN_ANGLE = 2.399963;
const CENTRE = 4096;

/** Logs in `n` players, in order, and returns them with their welcomes. */
async function fill(n: number) {
  const players = [];
  for (let i = 0; i < n; i++) {
    const p = await login(`Pl${i}`);
    players.push({ ...p, welcome: welcomeOf(p.welcome) });
  }
  return players;
}

const pondRows = () =>
  runInDurableObject(stub(), (_o, state) =>
    state.storage.sql.exec('SELECT id, seed, epoch, cx, cy, created FROM ponds').toArray(),
  );

describe('ponds', () => {
  it('gives a joiner a spawn hint no current member has, after members left', async () => {
    const [a, b, c] = await fill(3);
    if (!a || !b || !c) throw new Error('fill');
    b.c.send({ t: 'leave' });
    await b.c.closed;
    const d = welcomeOf((await login('Dee')).welcome);
    expect(d.members).toHaveLength(2);
    for (const other of [a, c]) expect(d.you.spawnHint).not.toEqual(other.welcome.you.spawnHint);
  });

  it('creates a pond for the first player, with the spawn hint at the centre', async () => {
    const { welcome } = (await fill(1))[0] ?? {};
    expect(welcome?.members).toEqual([]);
    expect(welcome?.you.spawnHint).toEqual({ x: CENTRE, y: CENTRE });
    expect(welcome?.pond.centre).toEqual({ x: CENTRE, y: CENTRE });
    // The world side in wu (not the pond's capacity): clients build their world from it.
    expect(welcome?.pond.size).toBe(CENTRE * 2);
    const rows = await pondRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: welcome?.pond.id,
      seed: welcome?.pond.seed,
      epoch: welcome?.pond.epoch,
      cx: CENTRE,
      cy: CENTRE,
    });
  });

  it('puts the second player in the same pond, on the ring, and tells the first', async () => {
    const [a, b] = await fill(2);
    if (!a || !b) throw new Error('fill');
    expect(b.welcome.pond).toEqual(a.welcome.pond);
    expect(b.welcome.members).toEqual([{ playerId: a.id.playerId, name: 'Pl0' }]);
    const angle = GOLDEN_ANGLE;
    const radius = 340;
    expect(b.welcome.you.spawnHint.x).toBeCloseTo(CENTRE + radius * Math.cos(angle), 6);
    expect(b.welcome.you.spawnHint.y).toBeCloseTo(CENTRE + radius * Math.sin(angle), 6);
    expect(await a.c.next()).toEqual({
      t: 'member',
      op: 'join',
      member: { playerId: b.id.playerId, name: 'Pl1' },
    });
  });

  it('spaces the ring by the number of current members', async () => {
    const players = await fill(4);
    const hint = players[3]?.welcome.you.spawnHint;
    expect(hint?.x).toBeCloseTo(CENTRE + (300 + 40 * 3) * Math.cos(3 * GOLDEN_ANGLE), 6);
    expect(hint?.y).toBeCloseTo(CENTRE + (300 + 40 * 3) * Math.sin(3 * GOLDEN_ANGLE), 6);
  });

  it('sends the 25th player to a new pond', async () => {
    const players = await fill(25);
    const last = players[24]?.welcome;
    expect(last?.pond.id).not.toBe(players[0]?.welcome.pond.id);
    expect(last?.members).toEqual([]);
    expect(await pondRows()).toHaveLength(2);
  }, 20_000);

  it('joins the fullest pond that has a free place', async () => {
    const players = await fill(25); // pond A: 24, pond B: 1
    const b2 = await login('Bee2'); // joins B (A is full)
    const bId = players[24]?.welcome.pond.id;
    expect(welcomeOf(b2.welcome).pond.id).toBe(bId);
    // A loses a player: A has 23 and is now the fullest with a place.
    players[0]?.c.send({ t: 'leave' });
    await players[0]?.c.closed;
    const next = welcomeOf((await login('Next')).welcome);
    expect(next.pond.id).toBe(players[1]?.welcome.pond.id);
    expect(next.members).toHaveLength(23);
  }, 20_000);

  it('reuses an emptied pond and keeps its epoch', async () => {
    const [a] = await fill(1);
    if (!a) throw new Error('fill');
    a.c.send({ t: 'leave' });
    await a.c.closed;
    const again = welcomeOf((await login('Again')).welcome);
    expect(again.pond).toEqual(a.welcome.pond);
    expect(again.members).toEqual([]);
    expect(await pondRows()).toHaveLength(1);
  });

  it('sends member leave on leave, close and a replaced session', async () => {
    const store = memoryKeyStore();
    const watcher = await login('Watcher');
    const leaver = await login('Leaver');
    const closer = await login('Closer');
    const twin = await login('Twin', store);
    await watcher.c.next(); // join Leaver
    await watcher.c.next(); // join Closer
    await watcher.c.next(); // join Twin
    leaver.c.send({ t: 'leave' });
    expect(await watcher.c.next()).toMatchObject({
      t: 'member',
      op: 'leave',
      member: { name: 'Leaver' },
    });
    closer.c.ws.close(1000, 'bye');
    expect(await watcher.c.next()).toMatchObject({
      t: 'member',
      op: 'leave',
      member: { name: 'Closer' },
    });
    await login('Twin', store); // replaces the twin
    expect(await twin.c.closed).toBe(CLOSE_REPLACED);
    const seen = [await watcher.c.next(), await watcher.c.next()];
    expect(seen.map((m) => (m.t === 'member' ? m.op : m.t)).sort()).toEqual(['join', 'leave']);
  });

  it('writes one row per new pond and nothing for joins or leaves', async () => {
    const [a, b] = await fill(2);
    b?.c.send({ t: 'leave' });
    await b?.c.closed;
    a?.c.send({ t: 'ping', id: 1 });
    expect(await pondRows()).toHaveLength(1);
    const rows = await runInDurableObject(
      stub(),
      (_o, state) =>
        state.storage.sql
          .exec<{ n: number }>(
            'SELECT (SELECT COUNT(*) FROM ponds) + (SELECT COUNT(*) FROM migrations) AS n',
          )
          .one().n,
    );
    expect(rows).toBe(2); // the pond and the schema version
  });

  it('keeps the pond and the roster across hibernation', async () => {
    const [a] = await fill(1);
    await evictDurableObject(stub());
    const b = welcomeOf((await login('Late')).welcome);
    expect(b.pond).toEqual(a?.welcome.pond);
    expect(b.members).toHaveLength(1);
  });
});

describe('joining a full pond', () => {
  it('lets 24 clients join one after another within the message budget', async () => {
    const closes: number[] = [];
    const joined: Array<{ playerId: string }> = [];
    const hints = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const { c, id, welcome } = await login(`Pl${i}`);
      hints.add(JSON.stringify(welcomeOf(welcome).you.spawnHint));
      void c.closed.then((code) => closes.push(code));
      // What a joining client sends: the opening pings, then one offer per member.
      for (let p = 0; p < 8; p++) c.send({ t: 'ping', id: p });
      for (const m of joined) c.send({ t: 'signal', to: m.playerId, kind: 'offer', sdp: 'v=0' });
      c.send({ t: 'ping', id: 999 });
      for (;;) {
        const msg = await c.next();
        if (msg.t === 'pong' && msg.id === 999) break;
      }
      joined.push({ playerId: id.playerId });
    }
    expect(closes).toEqual([]);
    expect(hints.size).toBe(24);
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
    await a.c.next(); // join B
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: 'v=0', from: 'forged' });
    expect(await b.c.next()).toEqual({
      t: 'signal',
      from: a.id.playerId,
      kind: 'offer',
      sdp: 'v=0',
    });
  });

  it('answers no-peer for an unknown player and for another pond', async () => {
    const players = await fill(25);
    const first = players[0];
    const lonely = players[24];
    if (!first || !lonely) throw new Error('fill');
    first.c.send({ t: 'signal', to: lonely.id.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await nextNonMember(first.c)).toEqual({ t: 'error', code: 'no-peer' });
    const stranger = await createIdentity(memoryKeyStore());
    first.c.send({ t: 'signal', to: stranger.playerId, kind: 'offer', sdp: 'v=0' });
    expect(await nextNonMember(first.c)).toEqual({ t: 'error', code: 'no-peer' });
    lonely.c.send({ t: 'ping', id: 1 });
    expect(await lonely.c.next()).toMatchObject({ t: 'pong' }); // nothing was delivered
  });

  it('drops an sdp over 8 KB with too-big', async () => {
    const [a, b] = await fill(2);
    if (!a || !b) throw new Error('fill');
    await a.c.next();
    const big = 'a'.repeat(SDP_MAX_BYTES + 1);
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: big });
    expect(await a.c.next()).toEqual({ t: 'error', code: 'too-big' });
    a.c.send({ t: 'signal', to: b.id.playerId, kind: 'offer', sdp: 'a'.repeat(SDP_MAX_BYTES) });
    const ok = await b.c.next();
    expect(ok.t).toBe('signal');
  });

  it('keeps the epoch when joining an old pond', async () => {
    const [a] = await fill(1);
    skip(60_000);
    const b = welcomeOf((await login('Later')).welcome);
    expect(b.pond.epoch).toBe(a?.welcome.pond.epoch);
    expect(b.now).toBeGreaterThan(b.pond.epoch);
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

  it('does not wait more than 2 s for a hanging Cloudflare', async () => {
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

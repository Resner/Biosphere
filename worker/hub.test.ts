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
  const sig = toBase64Url(id.sign(HELLO_DOMAIN, helloMessage(nonce, name)));
  return { id, hello: { t: 'hello', v: 1, playerId: id.playerId, name, sig } };
}

async function login(name = 'Alice', store = memoryKeyStore()) {
  const c = await open();
  const { id, hello } = await makeHello(await challenge(c), name, store);
  c.send(hello);
  const welcome = await c.next();
  return { c, id, welcome };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const c of sockets.splice(0)) {
    try {
      c.ws.close(1000, 'done');
    } catch {
      // already closed
    }
  }
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

  it.each(['ab', 'a'.repeat(17), 'bad name', 'ümlaut', 'x<y'])(
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

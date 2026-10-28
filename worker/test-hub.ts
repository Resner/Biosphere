import { runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { genesisAskMessage } from '../src/ledger/ask';
import { type Beacon, roundTime } from '../src/ledger/drand';
import {
  createIdentity,
  HELLO_DOMAIN,
  helloMessage,
  type Identity,
  memoryKeyStore,
  toBase64Url,
} from '../src/ledger/identity';
import { REQUEST_DOMAIN } from '../src/ledger/record';
import { type HubMsg, PROTOCOL_VERSION, parseHubMsg } from '../src/net/protocol';
import rounds from '../tests/fixtures/drand/rounds.json';
import type { BeaconSource } from './beacons';
import { fixtureSource } from './fixture-beacons';

// Shared by the hub tests that need a signed-in client and fake beacons (genesis, progress).

export const ORIGIN = 'https://resner.github.io';
const all = rounds.beacons as Beacon[];
export const beaconOf = (round: number): Beacon => all[round - rounds.first] as Beacon;
export const stub = () => env.AUTHORITY.get(env.AUTHORITY.idFromName('global'));

/** Drand time for the object: starts 20 rounds into the fixture and only moves when a test says so. */
const clock = { wall: 20 * 3000 + 100 };
export const source: BeaconSource = fixtureSource(0, () => clock.wall);
export const useFakeBeacons = () =>
  runInDurableObject(stub(), (authority) => {
    (authority as unknown as { source: BeaconSource }).source = source;
  });
/** The network publishes `round`; the object's alarm then resolves what waited for it. */
export async function publish(round: number): Promise<void> {
  clock.wall = Math.max(clock.wall, roundTime(round) - roundTime(rounds.first) + 600);
  await runDurableObjectAlarm(stub());
}

export interface Client {
  ws: WebSocket;
  inbox: HubMsg[];
  closed: Promise<number>;
  next(): Promise<HubMsg>;
  send(msg: unknown): void;
}

export const sockets: Client[] = [];
async function open(): Promise<Client> {
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
  const c: Client = {
    ws,
    inbox,
    closed,
    next: () => {
      const queued = inbox.shift();
      return queued
        ? Promise.resolve(queued)
        : new Promise<HubMsg>((resolve) => waiting.push(resolve));
    },
    send: (msg) => ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg)),
  };
  sockets.push(c);
  return c;
}

/** The next message of type `t`, skipping others (member joins). */
export async function nextOf<T extends HubMsg['t']>(
  c: Client,
  t: T,
): Promise<Extract<HubMsg, { t: T }>> {
  for (;;) {
    const msg = await c.next();
    if (msg.t === t) return msg as Extract<HubMsg, { t: T }>;
  }
}

/** Opens a socket and says hello; the caller reads what the hub answers (`welcome` or `queued`). */
export async function signIn(id?: Identity, store = memoryKeyStore()) {
  const who = id ?? (await createIdentity(store));
  const c = await open();
  const challenge = await nextOf(c, 'challenge');
  const name = 'Tester';
  const sig = toBase64Url(
    who.sign(HELLO_DOMAIN, helloMessage(challenge.nonce, name) ?? new Uint8Array()),
  );
  c.send({ t: 'hello', v: PROTOCOL_VERSION, playerId: who.playerId, name, sig });
  return { c, id: who };
}

export async function login(id?: Identity, store = memoryKeyStore()) {
  const { c, id: who } = await signIn(id, store);
  await nextOf(c, 'welcome');
  const life = await nextOf(c, 'life');
  return { c, id: who, life };
}

let nonces = 0;
export const freshNonce = () =>
  toBase64Url(new Uint8Array(16).fill(++nonces % 256)).padEnd(22, 'A');

export function genesisRequest(id: Identity, nonce = freshNonce(), as: Identity = id) {
  const sig = toBase64Url(as.sign(REQUEST_DOMAIN, genesisAskMessage(id.playerId, nonce)));
  return { t: 'genesis-request', nonce, sig };
}

export const sql = <T extends Record<string, SqlStorageValue>>(
  query: string,
  ...b: SqlStorageValue[]
) => runInDurableObject(stub(), (_o, state) => state.storage.sql.exec<T>(query, ...b).toArray());

/** Asks for a creature and returns the commit message. */
export async function ask(c: Client, id: Identity, nonce?: string) {
  c.send(genesisRequest(id, nonce));
  return nextOf(c, 'commit');
}

/** Asks, publishes the committed round and returns the creature's genesis message. */
export async function hatch(c: Client, id: Identity) {
  const { commit } = await ask(c, id);
  await publish(commit.commitment.round);
  return nextOf(c, 'genesis');
}

export const kill = (creature: string) =>
  sql("UPDATE creatures SET status = 'dead', died_t = 1 WHERE id = ?", creature);

/** Closes every socket a test opened (call from `afterEach`) and clears the ponds. */
export async function closeSockets(): Promise<void> {
  const done = sockets.splice(0);
  for (const c of done) {
    try {
      c.ws.close(1000, 'done');
    } catch {
      // already closed
    }
  }
  await Promise.all(done.map((c) => c.closed));
  await sql('DELETE FROM ponds');
}

/** Rows written through the object's ledger since it was made. */
export const rowsWritten = () =>
  runInDurableObject(
    stub(),
    (authority) => (authority as unknown as { ledger: { rowsWritten: number } }).ledger.rowsWritten,
  );

export interface Condition {
  biomass: number;
  energy: number;
  health: number;
}
export const CALM: Condition = { biomass: 10_000, energy: 12_000, health: 10_000 };

let reports = 0;
/** Sends a `progress` for `c`; `n` counts up by default. */
export function report(c: Client, ticks: number, cond: Condition = CALM, n = ++reports) {
  c.send({ t: 'progress', n, ticks, ...cond });
}

/** Everything the hub sends up to the answer to a ping, so a silent message shows as nothing. */
export async function flush(c: Client): Promise<HubMsg[]> {
  const id = 1 + (++reports % 1000);
  c.send({ t: 'ping', id });
  const out: HubMsg[] = [];
  for (;;) {
    const msg = await c.next();
    if (msg.t === 'pong' && msg.id === id) return out;
    out.push(msg);
  }
}

import { evictDurableObject, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { hexToBytes } from '@noble/hashes/utils.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { genomeHash, genomeToBase64url } from '../src/genome/codec';
import { type Beacon, randomnessOf, roundAt, roundTime } from '../src/ledger/drand';
import {
  checkGenesis,
  commitmentId,
  genesisAskMessage,
  genesisFor,
  verifyGenesisAsk,
} from '../src/ledger/genesis';
import {
  createIdentity,
  fromBase64Url,
  HELLO_DOMAIN,
  helloMessage,
  type Identity,
  memoryKeyStore,
  toBase64Url,
  verify,
} from '../src/ledger/identity';
import { AUTH_DOMAIN, checkStored, REQUEST_DOMAIN, recordHash } from '../src/ledger/record';
import { type HubMsg, parseHubMsg } from '../src/net/protocol';
import rounds from '../tests/fixtures/drand/rounds.json';
import type { BeaconSource } from './beacons';
import { fixtureSource } from './fixture-beacons';
import { HATCH_REFILL_MS } from './ledger';

const ORIGIN = 'https://resner.github.io';
const all = rounds.beacons as Beacon[];
const beaconOf = (round: number): Beacon => all[round - rounds.first] as Beacon;
const stub = () => env.AUTHORITY.get(env.AUTHORITY.idFromName('global'));

/** Drand time for the object: starts 20 rounds into the fixture and only moves when a test says so. */
const clock = { wall: 20 * 3000 + 100 };
const source: BeaconSource = fixtureSource(0, () => clock.wall);
const useFakeBeacons = () =>
  runInDurableObject(stub(), (authority) => {
    (authority as unknown as { source: BeaconSource }).source = source;
  });
/** The network publishes `round`; the object's alarm then resolves what waited for it. */
async function publish(round: number): Promise<void> {
  clock.wall = Math.max(clock.wall, roundTime(round) - roundTime(rounds.first) + 600);
  await runDurableObjectAlarm(stub());
}

interface Client {
  ws: WebSocket;
  inbox: HubMsg[];
  closed: Promise<number>;
  next(): Promise<HubMsg>;
  send(msg: unknown): void;
}

const sockets: Client[] = [];
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
async function nextOf<T extends HubMsg['t']>(c: Client, t: T): Promise<Extract<HubMsg, { t: T }>> {
  for (;;) {
    const msg = await c.next();
    if (msg.t === t) return msg as Extract<HubMsg, { t: T }>;
  }
}

async function login(id?: Identity, store = memoryKeyStore()) {
  const who = id ?? (await createIdentity(store));
  const c = await open();
  const challenge = await nextOf(c, 'challenge');
  const name = 'Tester';
  const sig = toBase64Url(
    who.sign(HELLO_DOMAIN, helloMessage(challenge.nonce, name) ?? new Uint8Array()),
  );
  c.send({ t: 'hello', v: 1, playerId: who.playerId, name, sig });
  await nextOf(c, 'welcome');
  const life = await nextOf(c, 'life');
  return { c, id: who, life };
}

let nonces = 0;
const freshNonce = () => toBase64Url(new Uint8Array(16).fill(++nonces % 256)).padEnd(22, 'A');

function genesisRequest(id: Identity, nonce = freshNonce(), as: Identity = id) {
  const sig = toBase64Url(as.sign(REQUEST_DOMAIN, genesisAskMessage(id.playerId, nonce)));
  return { t: 'genesis-request', nonce, sig };
}

const sql = <T extends Record<string, SqlStorageValue>>(query: string, ...b: SqlStorageValue[]) =>
  runInDurableObject(stub(), (_o, state) => state.storage.sql.exec<T>(query, ...b).toArray());

/** Asks for a creature and returns the commit message. */
async function ask(c: Client, id: Identity, nonce?: string) {
  c.send(genesisRequest(id, nonce));
  return nextOf(c, 'commit');
}

/** Asks, publishes the committed round and returns the creature's genesis message. */
async function hatch(c: Client, id: Identity) {
  const { commit } = await ask(c, id);
  await publish(commit.commitment.round);
  return nextOf(c, 'genesis');
}

const kill = (creature: string) =>
  sql("UPDATE creatures SET status = 'dead', died_t = 1 WHERE id = ?", creature);

beforeEach(async () => {
  await useFakeBeacons();
});

afterEach(async () => {
  vi.restoreAllMocks();
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
});

describe('life after welcome', () => {
  it('sends null and a zero wait to a new player', async () => {
    const { life } = await login();
    expect(life).toEqual({ t: 'life', life: null, genesisIn: 0 });
  });

  it('sends the active creature to a returning player', async () => {
    const { c, id } = await login();
    const g = await hatch(c, id);
    const again = await login(id);
    expect(again.life.life).toMatchObject({
      creature: recordHash(g.record.record),
      seq: 0,
      genome: g.genome,
    });
    expect(again.life.life?.lifespanMs).toBeGreaterThan(2_000_000);
    expect(await c.closed).toBe(4001);
  });
});

describe('genesis request', () => {
  it('commits at once to a future round and then sends a verifiable genesis', async () => {
    const { c, id } = await login();
    const latest = roundAt(source.now());
    const { commit, hatchesLeft } = await ask(c, id);
    expect(commit.commitment.round).toBe(latest + 2);
    expect(hatchesLeft).toBe(2);
    expect(verifyGenesisAsk(id.playerId, commit.commitment.data as never)).toBe(true);

    const keys = (await (
      await exports.default.fetch('https://authority.test/v1/pubkeys', {
        headers: { Origin: ORIGIN },
      })
    ).json()) as { keys: Array<{ id: string; publicKey: string }> };
    const commitId = commitmentId(commit.commitment);
    const key = keys.keys.find((k) => k.id === commit.keyId);
    expect(key).toBeDefined();
    expect(
      verify(
        key?.publicKey ?? '',
        AUTH_DOMAIN,
        hexToBytes(commitId),
        fromBase64Url(commit.authSig) ?? new Uint8Array(),
      ),
    ).toBe(true);

    await publish(commit.commitment.round);
    const g = await nextOf(c, 'genesis');
    expect(commitmentId(g.commit.commitment)).toBe(commitId);
    expect(checkGenesis(g.record.record, g.commit.commitment, g.beacon, g.genome)).toEqual([]);
    expect(checkStored(g.record, keys.keys)).toEqual([]);
    const creature = recordHash(g.record.record);
    expect(g.record.hash).toBe(creature);
    expect(g.record.record.seq).toBe(0);
    // The client recomputes the DNA from the beacon alone.
    const dna = genesisFor(randomnessOf(g.beacon), commitId);
    expect(genomeToBase64url(dna)).toBe(g.genome);
    expect(genomeHash(dna)).toBe(g.record.record.body.genome);
    const [head] = await sql<{ seq: number; status: string }>(
      'SELECT seq, status FROM creatures WHERE id = ?',
      creature,
    );
    expect(head).toMatchObject({ seq: 0, status: 'active' });
  });

  it('answers the same request with the same commit and the same genesis', async () => {
    const { c, id } = await login();
    const nonce = freshNonce();
    const first = await ask(c, id, nonce);
    const again = await ask(c, id, nonce);
    expect(again.commit).toEqual(first.commit);
    expect(again.hatchesLeft).toBe(first.hatchesLeft);
    await publish(first.commit.commitment.round);
    const g1 = await nextOf(c, 'genesis');
    c.send(genesisRequest(id, nonce));
    expect((await nextOf(c, 'commit')).commit).toEqual(first.commit);
    const g2 = await nextOf(c, 'genesis');
    expect(g2).toEqual(g1);
    const [count] = await sql<{ n: number }>(
      'SELECT COUNT(*) AS n FROM creatures WHERE owner = ?',
      id.playerId,
    );
    expect(count?.n).toBe(1);
  });

  it('does not hand a dead creature to a replayed ask', async () => {
    const { c, id } = await login();
    const nonce = freshNonce();
    const first = await ask(c, id, nonce);
    await publish(first.commit.commitment.round);
    const g = await nextOf(c, 'genesis');
    await kill(recordHash(g.record.record));
    c.send(genesisRequest(id, nonce));
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'used' });
    expect(c.inbox.filter((m) => m.t === 'genesis' || m.t === 'commit')).toHaveLength(0);
  });

  it('frees a player whose genesis the ledger refuses', async () => {
    const { c, id } = await login();
    const { commit } = await ask(c, id);
    // Something else made the player's account active before the round came.
    await sql(
      `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t)
       VALUES (?, ?, 'active', 0, ?, '', 0, 0, 0, 0, 1)`,
      'f'.repeat(64),
      id.playerId,
      'f'.repeat(64),
    );
    await publish(commit.commitment.round);
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'already-active' });
    const [row] = await sql<{ pending: string }>(
      'SELECT pending FROM players WHERE id = ?',
      id.playerId,
    );
    expect(row?.pending).toBe('');
  });

  it('keeps a player to one waiting round, whatever nonce they send', async () => {
    const { c, id } = await login();
    const first = await ask(c, id);
    const other = await ask(c, id, freshNonce());
    expect(other.commit).toEqual(first.commit);
    expect(other.hatchesLeft).toBe(first.hatchesLeft);
  });

  it('refuses a bad signature, a request signed by someone else and a second creature', async () => {
    const { c, id } = await login();
    c.send({ ...genesisRequest(id), sig: 'A'.repeat(86) });
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'bad-signature' });
    const stranger = await createIdentity(memoryKeyStore());
    c.send(genesisRequest(id, freshNonce(), stranger));
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'bad-signature' });
    c.send(genesisRequest(stranger, freshNonce(), stranger));
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'bad-signature' });
    const none = await sql('SELECT 1 FROM commitments WHERE owner = ?', id.playerId);
    expect(none).toHaveLength(0);

    await hatch(c, id);
    c.send(genesisRequest(id));
    expect(await nextOf(c, 'refused')).toMatchObject({ reason: 'active' });
    const rows = await sql('SELECT 1 FROM commitments WHERE owner = ?', id.playerId);
    expect(rows).toHaveLength(1);
  });

  it('gives 3 hatches, then refuses with the wait, and refills one per 5 minutes', async () => {
    const { c, id } = await login();
    for (const left of [2, 1, 0]) {
      c.send(genesisRequest(id));
      const commit = await nextOf(c, 'commit');
      expect(commit.hatchesLeft).toBe(left);
      await publish(commit.commit.commitment.round);
      const g = await nextOf(c, 'genesis');
      await kill(recordHash(g.record.record));
    }
    c.send(genesisRequest(id));
    const refused = await nextOf(c, 'refused');
    expect(refused.reason).toBe('limit');
    expect(refused.genesisIn).toBeGreaterThan(HATCH_REFILL_MS - 5000);
    expect(refused.genesisIn).toBeLessThanOrEqual(HATCH_REFILL_MS);

    // The wait also shows in `life` for a new session.
    expect((await login(id)).life.genesisIn).toBeGreaterThan(0);

    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + HATCH_REFILL_MS + 1000);
    const next = await login(id);
    expect(next.life.genesisIn).toBe(0);
    next.c.send(genesisRequest(id));
    expect((await nextOf(next.c, 'commit')).hatchesLeft).toBe(0);
  });

  it('never refills past 3', async () => {
    const { c, id } = await login();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 100 * HATCH_REFILL_MS);
    c.send(genesisRequest(id));
    expect((await nextOf(c, 'commit')).hatchesLeft).toBe(2);
  });
});

describe('waiting for the beacon', () => {
  it('delivers the creature to a player who left and came back', async () => {
    const { c, id } = await login();
    const { commit } = await ask(c, id);
    c.ws.close(1000, 'gone');
    await c.closed;
    await publish(commit.commitment.round);

    const back = await login(id);
    // The creature exists although nobody was connected when its round came.
    expect(back.life.life?.seq).toBe(0);
    expect(back.life.life?.creature).toMatch(/^[0-9a-f]{64}$/);
  });

  it('announces a waiting commitment again on reconnect, then sends the genesis', async () => {
    const { c, id } = await login();
    const { commit } = await ask(c, id);
    c.ws.close(1000, 'gone');
    await c.closed;
    const back = await login(id);
    expect(back.life.life).toBeNull();
    const again = await nextOf(back.c, 'commit');
    expect(again.commit).toEqual(commit);
    await publish(commit.commitment.round);
    expect(commitmentId((await nextOf(back.c, 'genesis')).commit.commitment)).toBe(
      commitmentId(commit.commitment),
    );
  });

  it('sends no genesis before the round exists', async () => {
    const { c, id } = await login();
    const { commit } = await ask(c, id);
    await runDurableObjectAlarm(stub());
    expect(c.inbox.filter((m) => m.t === 'genesis')).toHaveLength(0);
    await publish(commit.commitment.round);
    expect((await nextOf(c, 'genesis')).t).toBe('genesis');
  });

  it('survives eviction of the object while waiting', async () => {
    const { c, id } = await login();
    const { commit } = await ask(c, id);
    await evictDurableObject(stub());
    await useFakeBeacons();
    await publish(commit.commitment.round);
    expect((await nextOf(c, 'genesis')).t).toBe('genesis');
  });
});

describe('genesis checks', () => {
  it('differs per request and is equal in workerd and Node for the same inputs', async () => {
    // The same pinned value as src/ledger/genesis.test.ts.
    const dna = genesisFor(randomnessOf(beaconOf(rounds.first + 2)), 'ab'.repeat(32));
    expect(genomeHash(dna)).toBe(
      'f3f00a538769f2625bf8059c78d6d50f1b99424e9f098f6691db299475d2e7d3',
    );

    const a = await login();
    const b = await login();
    const ga = await hatch(a.c, a.id);
    const gb = await hatch(b.c, b.id);
    expect(ga.record.record.body.genome).not.toBe(gb.record.record.body.genome);
  });

  it('fails the client-side check for a tampered genesis', async () => {
    const { c, id } = await login();
    const g = await hatch(c, id);
    const { record, commit, beacon } = g;
    const other = genomeToBase64url(genesisFor(randomnessOf(beacon), 'ef'.repeat(32)));
    expect(checkGenesis(record.record, commit.commitment, beacon, other)).toContain(
      'genome-mismatch',
    );
    const wrongRound = { ...record.record, body: { ...record.record.body, round: 1 } };
    expect(checkGenesis(wrongRound, commit.commitment, beacon)).toContain('round-mismatch');
    const next = beaconOf(beacon.round + 1);
    expect(checkGenesis(record.record, commit.commitment, next)).toContain('beacon-round');
  });
});

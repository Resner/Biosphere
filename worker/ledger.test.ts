import { evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { env, exports } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore } from '../src/ledger/identity';
import {
  checkStored,
  creatureId,
  type LedgerRecord,
  type PubKey,
  type RecordRequest,
  requestHash,
  requestMessage,
  type StoredRecord,
} from '../src/ledger/record';
import { RULES_VERSION } from '../src/sim/rules';
import type { Ledger } from './ledger';
import { migrate } from './schema';

const ORIGIN = 'https://resner.github.io';
const stub = () => env.AUTHORITY.get(env.AUTHORITY.idFromName('global'));
const inLedger = <T>(fn: (ledger: Ledger) => T | Promise<T>): Promise<T> =>
  runInDurableObject(stub(), (authority) => fn(authority.ledger));

const hex = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 0;
const nextHex = (): string => hex(++counter + Date.now());

const newPlayer = (): Promise<Identity> => createIdentity(memoryKeyStore());

function genesisRequest(owner: string): RecordRequest {
  return {
    v: 1,
    rules: RULES_VERSION,
    kind: 'genesis',
    creature: '',
    seq: 0,
    prev: '',
    owner,
    body: { commit: nextHex(), round: 100, genome: nextHex(), generation: 0, karyotype: 1 },
  };
}

function nextRequest(
  head: StoredRecord,
  kind: 'checkpoint' | 'death' = 'checkpoint',
  body: LedgerRecord['body'] = { activeMs: 1000, biomass: 150, energy: 8000, health: 9000 },
): RecordRequest {
  const { record } = head;
  return {
    v: 1,
    rules: RULES_VERSION,
    kind,
    creature: record.kind === 'genesis' ? head.hash : record.creature,
    seq: record.seq + 1,
    prev: head.hash,
    owner: record.owner,
    body,
  };
}

async function hatch(ledger: Ledger, owner: string): Promise<StoredRecord> {
  const result = ledger.accept({ request: genesisRequest(owner), genome: 'genome-text' });
  if (!result.ok) throw new Error(`genesis refused: ${result.reason}`);
  return result.stored;
}

function mustAccept(ledger: Ledger, request: RecordRequest): StoredRecord {
  const result = ledger.accept({ request });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.stored;
}

const reason = (ledger: Ledger, request: RecordRequest): string => {
  const result = ledger.accept({ request });
  return result.ok ? 'accepted' : result.reason;
};

describe('migration 2', () => {
  it('creates the ledger tables and a second start applies nothing', async () => {
    const result = await runInDurableObject(stub(), (_o, state) => {
      const sql = state.storage.sql;
      const names = sql
        .exec<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .toArray()
        .map((r) => r.name);
      const versions = () =>
        sql.exec<{ version: number }>('SELECT version FROM migrations ORDER BY version').toArray();
      const before = versions();
      migrate(sql);
      return { names, before, after: versions() };
    });
    for (const table of [
      'ponds',
      'players',
      'creatures',
      'records',
      'commitments',
      'beacons',
      'keys',
      'usage',
      'flags',
      'genesis_log',
    ]) {
      expect(result.names).toContain(table);
    }
    expect(result.before.map((r) => r.version)).toEqual([1, 2, 3, 4]);
    expect(result.after).toEqual(result.before);
  });
});

describe('Ledger.accept', () => {
  it('accepts a genesis, then a chain of transitions, countersigned and moving the head', async () => {
    const owner = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      expect(genesis.record.creature).toBe('');
      expect(genesis.hash).toBe(creatureId(genesis.record));
      expect(ledger.head(genesis.hash)).toMatchObject({
        status: 'active',
        seq: 0,
        hash: genesis.hash,
        genome: 'genome-text',
        owner: owner.playerId,
      });
      const cp = mustAccept(ledger, nextRequest(genesis));
      expect(cp.record.seq).toBe(1);
      expect(cp.record.prev).toBe(genesis.hash);
      expect(cp.record.creature).toBe(genesis.hash);
      expect(cp.record.t).toBeGreaterThan(0);
      expect(ledger.head(genesis.hash)).toMatchObject({
        seq: 1,
        hash: cp.hash,
        activeMs: 1000,
        biomass: 150,
        energy: 8000,
        health: 9000,
      });
      const dead = mustAccept(
        ledger,
        nextRequest(cp, 'death', { cause: 'starved', activeMs: 2000 }),
      );
      expect(ledger.head(genesis.hash)).toMatchObject({
        status: 'dead',
        seq: 2,
        hash: dead.hash,
        activeMs: 2000,
        diedT: dead.record.t,
      });
    });
  });

  it('returns an identical resubmission unchanged and writes nothing', async () => {
    const owner = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      const request = nextRequest(genesis);
      const first = mustAccept(ledger, request);
      const before = ledger.rowsWritten;
      const again = ledger.accept({ request });
      expect(again).toEqual({ ok: true, stored: first, fresh: false });
      // The head has moved on; the old request still answers.
      const second = mustAccept(ledger, nextRequest(first));
      const rows = ledger.rowsWritten;
      expect(ledger.accept({ request })).toMatchObject({ ok: true, stored: first });
      expect(ledger.accept({ request: nextRequest(first) })).toMatchObject({
        ok: true,
        stored: second,
      });
      expect(ledger.rowsWritten).toBe(rows);
      expect(rows).toBeGreaterThan(before);
      // A genesis resubmission returns the same creature.
      const genesisRequestAgain = { ...genesisRequestOf(genesis.record) };
      expect(ledger.accept({ request: genesisRequestAgain, genome: 'genome-text' })).toMatchObject({
        ok: true,
        stored: genesis,
        fresh: false,
      });
    });
  });

  it('rejects stale and wrong-seq requests as conflicts and logs them', async () => {
    const owner = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      const cp = mustAccept(ledger, nextRequest(genesis));
      const stale = {
        ...nextRequest(genesis),
        body: { activeMs: 5, biomass: 1, energy: 1, health: 1 },
      };
      expect(reason(ledger, stale)).toBe('conflict');
      const skipped = { ...nextRequest(cp), seq: 3 };
      expect(reason(ledger, skipped)).toBe('conflict');
      const wrongPrev = { ...nextRequest(cp), prev: nextHex() };
      expect(reason(ledger, wrongPrev)).toBe('conflict');
      expect(ledger.head(genesis.hash)?.hash).toBe(cp.hash);
      const flags = ledger.flags(genesis.hash);
      expect(flags).toHaveLength(3);
      expect(reason(ledger, stale)).toBe('conflict'); // a replay adds no row
      expect(ledger.flags(genesis.hash)).toHaveLength(3);
      expect(flags[0]).toMatchObject({
        kind: 'conflict',
        owner: owner.playerId,
        creature: genesis.hash,
        hash: requestHash(stale),
      });
      expect(flags[0]?.t).toBeGreaterThan(0);
    });
  });

  it('refuses unknown creatures, other owners, dead creatures and malformed records', async () => {
    const owner = await newPlayer();
    const thief = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      const ghost = nextRequest({
        ...genesis,
        hash: nextHex(),
        record: { ...genesis.record, creature: nextHex() },
      });
      expect(reason(ledger, ghost)).toBe('unknown-creature');
      expect(reason(ledger, { ...nextRequest(genesis), owner: thief.playerId })).toBe(
        'wrong-owner',
      );
      expect(ledger.flags(genesis.hash).map((f) => f.kind)).toContain('wrong-owner');
      expect(reason(ledger, { ...nextRequest(genesis), creature: '' })).toBe('no-creature');
      expect(reason(ledger, { ...nextRequest(genesis), v: 2 as 1 })).toMatch(/^invalid-record:/);
      const dead = mustAccept(
        ledger,
        nextRequest(genesis, 'death', { cause: 'toxin', activeMs: 1 }),
      );
      expect(reason(ledger, nextRequest(dead))).toBe('dead');
      expect(ledger.head(genesis.hash)?.status).toBe('dead');
    });
  });

  it('checks an owner signature when one comes with the request', async () => {
    const owner = await newPlayer();
    const other = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      const request = nextRequest(genesis);
      const sign = (who: Identity) =>
        Buffer.from(who.sign('bs/req/v1', requestMessage(request))).toString('base64url');
      expect(ledger.accept({ request, ownerSig: sign(other) })).toEqual({
        ok: false,
        reason: 'bad-owner-signature',
      });
      const ok = ledger.accept({ request, ownerSig: sign(owner) });
      expect(ok.ok && ok.stored.ownerSig).toBe(sign(owner));
      expect(ok.ok && checkStored(ok.stored, ledger.pubkeys())).toEqual([]);
    });
  });

  it('allows one active creature per player and a new genesis after death', async () => {
    const owner = await newPlayer();
    await inLedger(async (ledger) => {
      const first = await hatch(ledger, owner.playerId);
      expect(reason(ledger, genesisRequest(owner.playerId))).toBe('already-active');
      mustAccept(ledger, nextRequest(first, 'death', { cause: 'starved', activeMs: 1 }));
      const second = await hatch(ledger, owner.playerId);
      expect(second.hash).not.toBe(first.hash);
    });
  });

  it('keeps exactly one head per creature over 200 random calls', async () => {
    const players = await Promise.all([newPlayer(), newPlayer(), newPlayer()]);
    let seed = 0x9e3779b9;
    const random = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % n;
    };
    await inLedger(async (ledger) => {
      const known: StoredRecord[] = [];
      const heads = new Map<string, StoredRecord>();
      for (let i = 0; i < 200; i++) {
        const player = players[random(players.length)] as Identity;
        const pick = known.length > 0 ? (known[random(known.length)] as StoredRecord) : null;
        const roll = random(10);
        let request: RecordRequest;
        if (!pick || roll === 0) {
          request = genesisRequest(player.playerId);
        } else if (roll <= 5) {
          // The creature's real head: valid unless it is dead.
          const head = heads.get(
            pick.record.kind === 'genesis' ? pick.hash : pick.record.creature,
          ) as StoredRecord;
          request = nextRequest(head, random(8) === 0 ? 'death' : 'checkpoint', {
            activeMs: random(1000),
            biomass: random(1000),
            energy: random(10000),
            health: random(10000),
          });
        } else if (roll <= 7) {
          request = nextRequest(pick); // stale unless it is the head
        } else if (roll === 8) {
          request = { ...nextRequest(pick), owner: player.playerId }; // wrong owner unless it is theirs
        } else {
          request = nextRequest(pick); // a duplicate of whatever came before
        }
        const result = ledger.accept({ request });
        if (!result.ok) continue;
        const id =
          result.stored.record.kind === 'genesis'
            ? result.stored.hash
            : result.stored.record.creature;
        if (result.fresh) {
          known.push(result.stored);
          heads.set(id, result.stored);
        }
      }
      expect(heads.size).toBeGreaterThan(3);
      const active = new Map<string, number>();
      for (const [id, last] of heads) {
        const chain = ledger.chain(id);
        chain.forEach((r, i) => {
          expect(r.record.seq).toBe(i);
          expect(r.record.prev).toBe(i === 0 ? '' : (chain[i - 1] as StoredRecord).hash);
        });
        const head = ledger.head(id);
        expect(head?.hash).toBe(chain.at(-1)?.hash);
        expect(head?.hash).toBe(last.hash);
        expect(head?.status).toBe(chain.at(-1)?.record.kind === 'death' ? 'dead' : 'active');
        if (head?.status === 'active') active.set(head.owner, (active.get(head.owner) ?? 0) + 1);
      }
      for (const n of active.values()) expect(n).toBe(1);
    });
  });

  it('writes at most 3 rows to accept a checkpoint', async () => {
    const owner = await newPlayer();
    await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      ledger.pubkeys(); // generates the key
      const before = ledger.rowsWritten;
      mustAccept(ledger, nextRequest(genesis));
      expect(ledger.rowsWritten - before).toBeLessThanOrEqual(3);
      expect(ledger.rowsWritten - before).toBeGreaterThan(0);
    });
  });
});

describe('the authority key', () => {
  it('is made on first use, kept across an eviction and never leaves the object', async () => {
    const first = await inLedger((ledger) => ledger.pubkeys());
    expect(first).toHaveLength(1);
    await evictDurableObject(stub());
    const again = await inLedger((ledger) => ledger.pubkeys());
    expect(again).toEqual(first);
    const secret = await runInDurableObject(
      stub(),
      (_o, state) =>
        new Uint8Array(
          state.storage.sql.exec<{ secret: ArrayBuffer }>('SELECT secret FROM keys').one().secret,
        ),
    );
    expect(secret).toHaveLength(32);
    const secretText = Buffer.from(secret).toString('base64url');
    const owner = await newPlayer();
    const leaked = await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      const refused = ledger.accept({ request: { ...nextRequest(genesis), seq: 9 } });
      return JSON.stringify([genesis, refused, ledger.pubkeys(), ledger.flags(genesis.hash)]);
    });
    expect(leaked).not.toContain(secretText);
    expect(leaked).not.toContain(Buffer.from(secret).toString('hex'));
  });

  it('serves /v1/pubkeys, origin-checked, and every stored record verifies with it', async () => {
    const owner = await newPlayer();
    const stored = await inLedger(async (ledger) => {
      const genesis = await hatch(ledger, owner.playerId);
      return [genesis, mustAccept(ledger, nextRequest(genesis))];
    });
    const res = await exports.default.fetch('https://authority.test/v1/pubkeys', {
      headers: { Origin: ORIGIN },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const body = (await res.json()) as { keys: (PubKey & { from: number })[] };
    expect(body.keys).toHaveLength(1);
    expect(Object.keys(body.keys[0] ?? {}).sort()).toEqual(['from', 'id', 'publicKey']);
    for (const s of stored) expect(checkStored(s, body.keys)).toEqual([]);

    const bad = await exports.default.fetch('https://authority.test/v1/pubkeys', {
      headers: { Origin: 'https://evil.example' },
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

function genesisRequestOf(record: LedgerRecord): RecordRequest {
  const { t: _t, ...request } = record;
  return request;
}

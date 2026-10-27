import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createIdentity, type Identity, memoryKeyStore, toBase64Url } from '../src/ledger/identity';
import {
  checkStored,
  type RecordKind,
  type RecordRequest,
  requestMessage,
  type Status,
  type StoredRecord,
  transitionOutcome,
} from '../src/ledger/record';
import { RULES_VERSION } from '../src/sim/rules';
import {
  type BirthChild,
  type Exhaustion,
  type Head,
  Ledger,
  type MateResult,
  type PromoteResult,
} from './ledger';
import { migrate } from './schema';

const stub = (name = 'global') => env.AUTHORITY.get(env.AUTHORITY.idFromName(name));
const inLedger = <T>(fn: (ledger: Ledger) => T | Promise<T>): Promise<T> =>
  runInDurableObject(stub(), (authority) => fn(authority.ledger));

const hex = (n: number): string => n.toString(16).padStart(64, '0');
let counter = 0;
const nextHex = (): string => hex(++counter * 7919 + Date.now());

const LIFESPAN = 4_500_000;
const RULE: Exhaustion = { lifespanOf: () => LIFESPAN, restoreMinMs: 120_000 };
const ROUND = 5000;

const newPlayer = (): Promise<Identity> => createIdentity(memoryKeyStore());
const sign = (who: Identity, request: RecordRequest): string =>
  toBase64Url(who.sign('bs/req/v1', requestMessage(request)));

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

function hatch(ledger: Ledger, owner: string): Head {
  const result = ledger.accept({ request: genesisRequest(owner), genome: 'genome-text' });
  if (!result.ok) throw new Error(`genesis refused: ${result.reason}`);
  return must(ledger.head(result.stored.hash));
}

function must<T>(x: T | null | undefined): T {
  if (x === null || x === undefined) throw new Error('missing');
  return x;
}

const chainRequest = (
  head: Head,
  kind: RecordKind,
  body: RecordRequest['body'],
  seq = head.seq + 1,
): RecordRequest => ({
  v: 1,
  rules: RULES_VERSION,
  kind,
  creature: head.id,
  seq,
  prev: head.hash,
  owner: head.owner,
  body,
});

const checkpoint = (head: Head, activeMs = head.activeMs + 1000): RecordRequest =>
  chainRequest(head, 'checkpoint', { activeMs, biomass: 900, energy: 700, health: 9000 });

function step(ledger: Ledger, request: RecordRequest): Head {
  const result = ledger.accept({ request });
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return must(ledger.head(request.creature));
}

function die(ledger: Ledger, head: Head, cause = 'killed'): Head {
  return step(
    ledger,
    chainRequest(head, 'death', {
      cause,
      activeMs: head.activeMs,
      biomass: head.biomass,
      energy: head.energy,
      health: 0,
    }),
  );
}

function mateRequests(
  a: Head,
  b: Head,
  commit: string,
  round = ROUND,
): [RecordRequest, RecordRequest] {
  const body = (self: Head, other: Head, role: 'a' | 'b') => ({
    commit,
    round,
    role,
    partner: other.owner,
    partnerCreature: other.id,
    genome: nextHex(),
    partnerGenome: nextHex(),
    generation: self.generation,
    activeMs: self.activeMs,
    biomass: 850,
    energy: 560,
    health: 9000,
    cooldownUntilMs: self.activeMs + 360_000,
  });
  return [
    chainRequest(a, 'mate-commit', body(a, b, 'a')),
    chainRequest(b, 'mate-commit', body(b, a, 'b')),
  ];
}

function mate(
  ledger: Ledger,
  a: Head,
  b: Head,
  commit = nextHex(),
): MateResult & { commit: string } {
  const requests = mateRequests(a, b, commit);
  return { ...ledger.mate({ commit, round: ROUND, requests }), commit };
}

function birthChildren(
  commit: string,
  a: Head,
  b: Head,
  mates: [StoredRecord, StoredRecord],
): [BirthChild, BirthChild] {
  const make = (owner: string, slot: number): BirthChild => ({
    request: {
      v: 1,
      rules: RULES_VERSION,
      kind: 'birth',
      creature: '',
      seq: 0,
      prev: '',
      owner,
      body: {
        commit,
        round: ROUND,
        slot,
        parents: [a.id, b.id],
        mates: [mates[0].hash, mates[1].hash],
        genome: nextHex(),
        generation: Math.max(a.generation, b.generation) + 1,
        karyotype: 1,
      },
    },
    genome: `child-${slot}-${nextHex()}`,
    condition: { biomass: 80, energy: 9600, health: 9000 },
  });
  return [make(a.owner, 0), make(b.owner, 1)];
}

interface Mated {
  a: Head;
  b: Head;
  commit: string;
  mates: [StoredRecord, StoredRecord];
}

function mated(ledger: Ledger, a: Head, b: Head): Mated {
  const result = mate(ledger, a, b);
  if (!result.ok) throw new Error(`mate refused: ${result.reason}`);
  return { a, b, commit: result.commit, mates: result.stored };
}

/** Both players' pending children, born through the legitimate path. */
function bear(ledger: Ledger, m: Mated): [Head, Head] {
  const children = birthChildren(m.commit, m.a, m.b, m.mates);
  const result = ledger.birth({ commit: m.commit, children });
  if (!result.ok) throw new Error(`birth refused: ${result.reason}`);
  return [must(ledger.head(result.stored[0].hash)), must(ledger.head(result.stored[1].hash))];
}

function promoteRequest(child: Head, parent: string): RecordRequest {
  return chainRequest(child, 'promote', { role: 'child', parent });
}

function promote(ledger: Ledger, who: Identity, child: Head, parent: string): PromoteResult {
  const request = promoteRequest(child, parent);
  return ledger.promote(request, sign(who, request));
}

function mustPromote(ledger: Ledger, who: Identity, child: Head, parent: string) {
  const result = promote(ledger, who, child, parent);
  if (!result.ok) throw new Error(`promote refused: ${result.reason}`);
  return result;
}

function restoreRequest(ancestor: Head, from: string): RecordRequest {
  return chainRequest(ancestor, 'restore', {
    from,
    activeMs: ancestor.activeMs,
    biomass: ancestor.biomass,
    energy: ancestor.energy,
    health: ancestor.health,
    cooldownUntilMs: ancestor.cooldownUntilMs,
  });
}

/** Two players with a genesis creature each. */
async function pair(ledger: Ledger): Promise<{ A: Identity; B: Identity; a: Head; b: Head }> {
  const [A, B] = [await newPlayer(), await newPlayer()];
  return { A, B, a: hatch(ledger, A.playerId), b: hatch(ledger, B.playerId) };
}

/** G frozen under a promoted child C1 that is then dead: G is the nearest surviving ancestor. */
async function lineageOfTwo(ledger: Ledger) {
  const { A, B, a, b } = await pair(ledger);
  const m = mated(ledger, a, b);
  const [c1] = bear(ledger, m);
  mustPromote(ledger, A, c1, a.id);
  const active = must(ledger.head(c1.id));
  const dead = die(ledger, step(ledger, checkpoint(active, 5000)));
  return { A, B, g: must(ledger.head(a.id)), c1: dead, b };
}

describe('migration 5', () => {
  it('rebuilds creatures with the new statuses, columns and indexes', async () => {
    const result = await runInDurableObject(stub(), (_o, state) => {
      const sql = state.storage.sql;
      const columns = sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('creatures')")
        .toArray()
        .map((r) => r.name);
      const indexes = sql
        .exec<{ name: string; sql: string }>(
          "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
        )
        .toArray();
      const matings = sql
        .exec<{ name: string }>("SELECT name FROM pragma_table_info('matings')")
        .toArray()
        .map((r) => r.name);
      const versions = sql
        .exec<{ version: number }>('SELECT version FROM migrations ORDER BY version')
        .toArray()
        .map((r) => r.version);
      return { columns, indexes, matings, versions };
    });
    expect(result.versions).toEqual([1, 2, 3, 4, 5]);
    for (const c of ['generation', 'parent_a', 'parent_b', 'chain_parent', 'cooldown_until_ms']) {
      expect(result.columns).toContain(c);
    }
    const byName = Object.fromEntries(result.indexes.map((i) => [i.name, i.sql]));
    expect(byName.creatures_one_active).toMatch(/UNIQUE.*WHERE status = 'active'/s);
    expect(byName.creatures_one_pending).toMatch(/UNIQUE.*WHERE status = 'pending'/s);
    expect(byName.creatures_dead).toMatch(/WHERE status = 'dead'/);
    expect(byName.matings_open).toMatch(/WHERE resolved = 0/);
    for (const c of ['commit_id', 'owner_a', 'owner_b', 'creature_a', 'creature_b', 'round', 't']) {
      expect(result.matings).toContain(c);
    }
    expect(result.matings).toContain('resolved');
  });

  it('migrates a database built through migration 4 without changing a row, and applies once', async () => {
    const out = await runInDurableObject(stub('legacy-db'), async (_o, state) => {
      const sql = state.storage.sql;
      // Throw away what this object's start-up made and build the old schema.
      const tables = sql
        .exec<{ name: string }>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
        )
        .toArray();
      for (const { name } of tables) sql.exec(`DROP TABLE "${name}"`);
      migrate(sql, 4);
      const [p1, p2] = [await newPlayer(), await newPlayer()];
      const put = (id: string, owner: string, status: string, seq: number, died: number | null) =>
        sql.exec(
          `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
           VALUES (?, ?, ?, ?, ?, 'g', 1000, 150, 8000, 9000, 5, ?)`,
          id,
          owner,
          status,
          seq,
          hex(seq + 1),
          died,
        );
      put(hex(1), p1.playerId, 'active', 3, null);
      put(hex(2), p1.playerId, 'dead', 2, 99);
      put(hex(3), p2.playerId, 'dead', 1, 50);
      sql.exec(
        `INSERT INTO records (creature, seq, hash, req, kind, owner, t, json, owner_sig, auth_sig, key_id)
         VALUES (?, 0, ?, ?, 'genesis', ?, 5, '{}', NULL, 'sig', 'key')`,
        hex(1),
        hex(1),
        hex(9),
        p1.playerId,
      );
      sql.exec('INSERT INTO players (id, first_seen, last_seen) VALUES (?, 1, 2)', p1.playerId);
      const dump = () => ({
        creatures: sql
          .exec(
            'SELECT id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t FROM creatures ORDER BY id',
          )
          .toArray(),
        records: sql.exec('SELECT * FROM records ORDER BY creature, seq').toArray(),
        players: sql.exec('SELECT * FROM players ORDER BY id').toArray(),
      });
      const before = dump();
      migrate(sql);
      const after = dump();
      const versions = () => sql.exec('SELECT version FROM migrations').toArray().length;
      const n = versions();
      migrate(sql);
      const ledger = new Ledger(state.storage);
      return {
        before,
        after,
        n,
        again: versions(),
        active: ledger.active(p1.playerId)?.id,
        history: ledger.history(p1.playerId, 5).map((h) => h.creature),
        defaults: sql
          .exec(
            'SELECT generation, chain_parent, cooldown_until_ms FROM creatures WHERE id = ?',
            hex(1),
          )
          .one(),
        dead: ledger.head(hex(2))?.status,
      };
    });
    expect(out.after).toEqual(out.before);
    expect(out.n).toBe(5);
    expect(out.again).toBe(5);
    expect(out.active).toBe(hex(1));
    expect(out.history).toEqual([hex(2)]);
    expect(out.defaults).toEqual({ generation: 0, chain_parent: null, cooldown_until_ms: 0 });
    expect(out.dead).toBe('dead');
  });
});

describe('Ledger.mate', () => {
  it('appends both mate-commit records and the mating row, attested, in one transaction', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const keys = ledger.pubkeys();
      const before = ledger.rowsWritten;
      const result = mate(ledger, a, b);
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by mate: ${rows}`);
      expect(rows).toBeLessThanOrEqual(6);
      if (!result.ok) throw new Error(result.reason);
      expect(result.fresh).toBe(true);
      for (const [i, s] of result.stored.entries()) {
        expect(checkStored(s, keys)).toEqual([]);
        expect(s.ownerSig).toBeNull();
        expect(s.record.kind).toBe('mate-commit');
        expect(s.record.seq).toBe(1);
        expect(s.record.prev).toBe(i === 0 ? a.hash : b.hash);
      }
      expect(ledger.head(a.id)).toMatchObject({
        seq: 1,
        hash: result.stored[0].hash,
        status: 'active',
        biomass: 850,
        energy: 560,
        cooldownUntilMs: 360_000,
      });
      expect(ledger.head(b.id)?.hash).toBe(result.stored[1].hash);
      expect(ledger.pairMatings(a.owner, b.owner, 0)).toBe(1);
      expect(ledger.pairMatings(b.owner, a.owner, 0)).toBe(1);
      expect(ledger.pairMatings(a.owner, b.owner, Date.now() + 60_000)).toBe(0);
    });
  });

  it('returns the same records for a resubmission and writes nothing', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const commit = nextHex();
      const requests = mateRequests(a, b, commit);
      const one = ledger.mate({ commit, round: ROUND, requests });
      expect(one.ok).toBe(true);
      const rows = ledger.rowsWritten;
      const again = ledger.mate({ commit, round: ROUND, requests });
      expect(again).toMatchObject({ ok: true, fresh: false });
      expect(again.ok && one.ok && again.stored).toEqual(one.ok && one.stored);
      expect(ledger.rowsWritten).toBe(rows);
    });
  });

  it('refuses with neither record written and a conflict flag when a head moved', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const requests = mateRequests(a, b, nextHex());
      step(ledger, checkpoint(b)); // B's head moves on
      const rows = ledger.rowsWritten;
      const result = ledger.mate({
        commit: String(requests[0].body.commit),
        round: ROUND,
        requests,
      });
      expect(result).toMatchObject({ ok: false, reason: 'conflict' });
      expect(ledger.rowsWritten - rows).toBeLessThanOrEqual(1); // the flag only
      expect(ledger.head(a.id)?.seq).toBe(0);
      expect(ledger.chain(a.id)).toHaveLength(1);
      expect(ledger.chain(b.id)).toHaveLength(2);
      expect(ledger.pairMatings(a.owner, b.owner, 0)).toBe(0);
    });
  });

  it('refuses a mating that does not agree with itself', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const c = await newPlayer();
      const other = hatch(ledger, c.playerId);
      const commit = nextHex();
      const good = mateRequests(a, b, commit);
      const tamper = (
        i: number,
        patch: Record<string, unknown>,
      ): [RecordRequest, RecordRequest] => {
        const copy = structuredClone(good);
        (copy[i] as RecordRequest).body = {
          ...(copy[i] as RecordRequest).body,
          ...patch,
        } as RecordRequest['body'];
        return copy;
      };
      const reasons = [
        tamper(0, { commit: nextHex() }),
        tamper(1, { round: ROUND + 1 }),
        tamper(0, { role: 'b' }),
        tamper(1, { partner: c.playerId }),
        tamper(0, { partnerCreature: other.id }),
        tamper(0, { generation: 7 }),
        [good[0], { ...good[0] }] as [RecordRequest, RecordRequest],
        mateRequests(a, other, commit).map((r, i) => (i === 0 ? r : good[1])) as [
          RecordRequest,
          RecordRequest,
        ],
        [good[1], good[0]] as [RecordRequest, RecordRequest],
      ].map((requests) => {
        const r = ledger.mate({ commit, round: ROUND, requests });
        return r.ok ? 'accepted' : r.reason;
      });
      expect(reasons.every((r) => r !== 'accepted')).toBe(true);
      expect(ledger.chain(a.id)).toHaveLength(1);
      expect(ledger.chain(b.id)).toHaveLength(1);
      expect(ledger.pairMatings(a.owner, b.owner, 0)).toBe(0);
    });
  });

  it('refuses a creature that is not active, one with a pending child, and one in flight', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [c, d] = [await newPlayer(), await newPlayer()];
      const [x, y] = [hatch(ledger, c.playerId), hatch(ledger, d.playerId)];
      const dead = die(ledger, x);
      expect(mate(ledger, dead, y)).toMatchObject({ ok: false });
      const first = mated(ledger, a, b);
      const aNow = must(ledger.head(a.id));
      // In flight: neither A nor B can be in a second mating before the first is born.
      const second = mate(ledger, aNow, y);
      expect(second).toMatchObject({ ok: false, reason: 'in-flight' });
      const [childA] = bear(ledger, first);
      expect(childA.status).toBe('pending');
      // A pending child blocks the next mating for its owner.
      const third = mate(ledger, must(ledger.head(a.id)), y);
      expect(third).toMatchObject({ ok: false, reason: 'pending' });
    });
  });
});

describe('Ledger.birth', () => {
  it('creates both pending creatures, appends nothing to the parents and resolves the mating', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const keys = ledger.pubkeys();
      const m = mated(ledger, a, b);
      const parentsBefore = [ledger.chain(a.id).length, ledger.chain(b.id).length];
      const children = birthChildren(m.commit, m.a, m.b, m.mates);
      const before = ledger.rowsWritten;
      const result = ledger.birth({ commit: m.commit, children });
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by birth: ${rows}`);
      expect(rows).toBeLessThanOrEqual(7);
      if (!result.ok) throw new Error(result.reason);
      expect([ledger.chain(a.id).length, ledger.chain(b.id).length]).toEqual(parentsBefore);
      for (const [i, s] of result.stored.entries()) {
        expect(checkStored(s, keys)).toEqual([]);
        expect(s.record.kind).toBe('birth');
        expect(s.record.owner).toBe(i === 0 ? a.owner : b.owner);
        const head = must(ledger.head(s.hash));
        expect(head).toMatchObject({
          status: 'pending',
          seq: 0,
          generation: 1,
          parentA: a.id,
          parentB: b.id,
          chainParent: null,
          activeMs: 0,
          biomass: 80,
          cooldownUntilMs: 0,
          genome: children[i]?.genome,
        });
      }
      expect(ledger.fallback(a.id, RULE).pending?.id).toBe(result.stored[0].hash);
    });
  });

  it('writes nothing for an unknown mating, and a repeat answers with the same children', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const m = mated(ledger, a, b);
      const children = birthChildren(m.commit, m.a, m.b, m.mates);
      const rows = ledger.rowsWritten;
      expect(ledger.birth({ commit: nextHex(), children })).toMatchObject({
        ok: false,
        reason: 'unknown-commit',
      });
      expect(ledger.rowsWritten).toBe(rows);
      const first = ledger.birth({ commit: m.commit, children });
      expect(first).toMatchObject({ ok: true, fresh: true });
      const done = ledger.rowsWritten;
      const again = ledger.birth({ commit: m.commit, children });
      expect(again).toMatchObject({ ok: true, fresh: false });
      expect(again.ok && first.ok && again.stored).toEqual(first.ok && first.stored);
      expect(ledger.rowsWritten).toBe(done);
      // A different child for the same, resolved mating is refused.
      const other = birthChildren(m.commit, m.a, m.b, m.mates);
      expect(ledger.birth({ commit: m.commit, children: other })).toMatchObject({
        ok: false,
        reason: 'resolved',
      });
      expect(ledger.rowsWritten).toBe(done);
    });
  });

  it('refuses children that do not belong to the mating', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const m = mated(ledger, a, b);
      const [x, y] = birthChildren(m.commit, m.a, m.b, m.mates);
      const rows = ledger.rowsWritten;
      const bad = (children: [BirthChild, BirthChild]) => {
        const r = ledger.birth({ commit: m.commit, children });
        return r.ok ? 'accepted' : r.reason;
      };
      expect(bad([y, x])).not.toBe('accepted'); // owners swapped
      expect(
        bad([
          x,
          { ...y, request: { ...y.request, body: { ...y.request.body, commit: nextHex() } } },
        ]),
      ).not.toBe('accepted');
      expect(
        bad([
          x,
          { ...y, request: { ...y.request, body: { ...y.request.body, parents: [b.id, a.id] } } },
        ]),
      ).not.toBe('accepted');
      expect(
        bad([
          x,
          { ...y, request: { ...y.request, body: { ...y.request.body, round: ROUND + 1 } } },
        ]),
      ).not.toBe('accepted');
      expect(ledger.rowsWritten).toBe(rows);
    });
  });

  it('cannot give a player a second pending creature', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      const [childA] = bear(ledger, mated(ledger, a, b));
      expect(childA.status).toBe('pending');
      const sql = ledger.storage.sql;
      expect(() =>
        sql.exec(
          `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t)
           VALUES (?, ?, 'pending', 0, ?, 'g', 0, 80, 100, 100, 1)`,
          nextHex(),
          a.owner,
          nextHex(),
        ),
      ).toThrow();
    });
  });
});

describe('Ledger.promote', () => {
  it('activates the child and freezes the parent with its condition', async () => {
    await inLedger(async (ledger) => {
      const { A, a, b } = await pair(ledger);
      const keys = ledger.pubkeys();
      const aLive = step(ledger, checkpoint(a, 90_000));
      const m = mated(ledger, aLive, b);
      const [child] = bear(ledger, m);
      const parent = must(ledger.head(a.id));
      const before = ledger.rowsWritten;
      const result = mustPromote(ledger, A, child, a.id);
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by promote with a freeze: ${rows}`);
      expect(rows).toBeLessThanOrEqual(6);
      expect(result.fresh).toBe(true);
      expect(checkStored(result.stored, keys)).toEqual([]);
      expect(result.frozen && checkStored(result.frozen, keys)).toEqual([]);
      expect(result.stored.ownerSig).not.toBeNull();
      expect(result.frozen?.ownerSig).toBeNull();
      expect(result.frozen?.record.body).toEqual({
        role: 'parent',
        child: child.id,
        activeMs: parent.activeMs,
        biomass: parent.biomass,
        energy: parent.energy,
        health: parent.health,
        cooldownUntilMs: parent.cooldownUntilMs,
      });
      expect(ledger.head(child.id)).toMatchObject({ status: 'active', seq: 1, chainParent: a.id });
      expect(ledger.head(a.id)).toMatchObject({
        status: 'checkpoint',
        seq: parent.seq + 1,
        activeMs: parent.activeMs,
        cooldownUntilMs: parent.cooldownUntilMs,
      });
      expect(ledger.active(a.owner)?.id).toBe(child.id);
    });
  });

  it('is idempotent and refuses with a named reason and no change otherwise', async () => {
    await inLedger(async (ledger) => {
      const { A, B, a, b } = await pair(ledger);
      const [childA, childB] = bear(ledger, mated(ledger, a, b));
      const request = promoteRequest(childA, a.id);
      const ownerSig = sign(A, request);
      const rows0 = ledger.rowsWritten;
      const bad = (r: PromoteResult) => (r.ok ? 'accepted' : r.reason);
      // Changes nothing: a bad signature, someone else's signature, someone else's child.
      expect(bad(ledger.promote(request, sign(B, request)))).toBe('bad-owner-signature');
      expect(bad(ledger.promote(request, 'x'))).toBe('bad-owner-signature');
      const theirs = { ...promoteRequest(childB, a.id), owner: a.owner };
      expect(bad(ledger.promote(theirs, sign(A, theirs)))).toBe('wrong-owner');
      // A parent that is not the player's active creature.
      const stray = promoteRequest(childA, b.id);
      expect(bad(ledger.promote(stray, sign(A, stray)))).toBe('bad-parent');
      const stale = { ...request, prev: nextHex() };
      expect(bad(ledger.promote(stale, sign(A, stale)))).toBe('conflict');
      expect(ledger.head(childA.id)?.status).toBe('pending');
      expect(ledger.head(a.id)?.status).toBe('active');
      // wrong-owner and conflict write flags only.
      expect(ledger.rowsWritten - rows0).toBeLessThanOrEqual(2);
      const first = ledger.promote(request, ownerSig);
      expect(first).toMatchObject({ ok: true, fresh: true });
      const rows = ledger.rowsWritten;
      const again = ledger.promote(request, ownerSig);
      expect(again).toMatchObject({ ok: true, fresh: false });
      expect(again.ok && first.ok && [again.stored, again.frozen]).toEqual(
        first.ok && [first.stored, first.frozen],
      );
      expect(ledger.rowsWritten).toBe(rows);
      // Not pending any more: a new request for it names the status.
      const late = promoteRequest(must(ledger.head(childA.id)), a.id);
      expect(bad(ledger.promote(late, sign(A, late)))).toBe('status:active');
    });
  });

  it('only links a parent that already died, and only the most recent one', async () => {
    await inLedger(async (ledger) => {
      const { A, a, b } = await pair(ledger);
      const [childA] = bear(ledger, mated(ledger, a, b));
      const dead = die(ledger, must(ledger.head(a.id)));
      const result = mustPromote(ledger, A, childA, dead.id);
      expect(result.frozen).toBeNull();
      expect(ledger.head(childA.id)).toMatchObject({ status: 'active', chainParent: dead.id });
      expect(ledger.chain(dead.id).at(-1)?.record.kind).toBe('death');
      // A can promote while the active creature lives or once it is dead, nothing else:
      const { A: A2, a: a2, b: b2 } = await pair(ledger);
      const first = die(ledger, a2);
      const [x] = bear(ledger, mated(ledger, hatch(ledger, A2.playerId), b2));
      // A2 now has a dead (first) and an active creature: the dead one is refused as the parent.
      expect(promote(ledger, A2, x, first.id)).toMatchObject({ ok: false, reason: 'bad-parent' });
    });
  });
});

describe('Ledger.fallback, restore and markExhausted', () => {
  it('finds the pending child and the nearest surviving ancestor', async () => {
    await inLedger(async (ledger) => {
      const { g, c1 } = await lineageOfTwo(ledger);
      expect(ledger.fallback(c1.id, RULE)).toEqual({ pending: null, ancestor: g, exhausted: [] });
      // Nothing and nobody.
      const lone = die(ledger, hatch(ledger, (await newPlayer()).playerId));
      expect(ledger.fallback(lone.id, RULE)).toEqual({
        pending: null,
        ancestor: null,
        exhausted: [],
      });
    });
  });

  it('skips an exhausted ancestor and reports it, and marks it dead with old-age', async () => {
    await inLedger(async (ledger) => {
      // G -> C1 -> C2; C2 dead; C1 has under restoreMinMs left; G is fine.
      const { A, B, a, b } = await pair(ledger);
      const [c1, cb] = bear(ledger, mated(ledger, a, b));
      mustPromote(ledger, A, c1, a.id);
      mustPromote(ledger, B, cb, b.id);
      let c1Live = step(ledger, checkpoint(must(ledger.head(c1.id)), LIFESPAN - 60_000));
      const [c2] = bear(ledger, mated(ledger, c1Live, must(ledger.head(cb.id))));
      c1Live = must(ledger.head(c1.id));
      mustPromote(ledger, A, c2, c1.id);
      const c2Dead = die(ledger, must(ledger.head(c2.id)));
      const fb = ledger.fallback(c2Dead.id, RULE);
      expect(fb.ancestor?.id).toBe(a.id);
      expect(fb.exhausted.map((h) => h.id)).toEqual([c1.id]);
      // Read only: nothing changed.
      expect(ledger.head(c1.id)?.status).toBe('checkpoint');
      const before = ledger.rowsWritten;
      const marked = ledger.markExhausted(c1.id, RULE);
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by markExhausted: ${rows}`);
      expect(rows).toBeLessThanOrEqual(3);
      if (!marked.ok) throw new Error(marked.reason);
      expect(marked.stored.record.kind).toBe('death');
      expect(marked.stored.record.body.cause).toBe('old-age');
      expect(ledger.head(c1.id)).toMatchObject({ status: 'dead' });
      expect(c1Live.id).toBe(c1.id);
      // A creature that is not exhausted, or not frozen, is refused and nothing changes.
      expect(ledger.markExhausted(a.id, RULE)).toMatchObject({ ok: false });
      expect(ledger.markExhausted(c2Dead.id, RULE)).toMatchObject({ ok: false });
      // The marked one is skipped without being reported again.
      expect(ledger.fallback(c2Dead.id, RULE)).toMatchObject({
        ancestor: { id: a.id },
        exhausted: [],
      });
      // A repeat answers the same record.
      expect(ledger.markExhausted(c1.id, RULE)).toMatchObject({ ok: true, fresh: false });
    });
  });

  it('restores the nearest ancestor with its saved condition and keeps its earlier records', async () => {
    await inLedger(async (ledger) => {
      const { A, B, g, c1 } = await lineageOfTwo(ledger);
      const keys = ledger.pubkeys();
      const hashesBefore = ledger.chain(g.id).map((r) => r.hash);
      const request = restoreRequest(g, c1.id);
      const bad = (r: ReturnType<Ledger['restore']>) => (r.ok ? 'accepted' : r.reason);
      expect(bad(ledger.restore(request, sign(B, request), RULE))).toBe('bad-owner-signature');
      const wrongBody = restoreRequest(g, c1.id);
      wrongBody.body = { ...wrongBody.body, activeMs: 1 };
      expect(bad(ledger.restore(wrongBody, sign(A, wrongBody), RULE))).toBe('condition-mismatch');
      const wrongFrom = restoreRequest(g, nextHex());
      expect(bad(ledger.restore(wrongFrom, sign(A, wrongFrom), RULE))).toBe('not-nearest');
      const stale = { ...request, prev: nextHex() };
      expect(bad(ledger.restore(stale, sign(A, stale), RULE))).toBe('conflict');
      expect(ledger.head(g.id)?.status).toBe('checkpoint');
      const before = ledger.rowsWritten;
      const result = ledger.restore(request, sign(A, request), RULE);
      const rows = ledger.rowsWritten - before;
      console.log(`rows written by restore: ${rows}`);
      expect(rows).toBeLessThanOrEqual(3);
      if (!result.ok) throw new Error(result.reason);
      expect(checkStored(result.stored, keys)).toEqual([]);
      expect(ledger.head(g.id)).toMatchObject({
        status: 'active',
        activeMs: g.activeMs,
        cooldownUntilMs: g.cooldownUntilMs,
        seq: g.seq + 1,
      });
      expect(
        ledger
          .chain(g.id)
          .map((r) => r.hash)
          .slice(0, hashesBefore.length),
      ).toEqual(hashesBefore);
      // Idempotent.
      const rows2 = ledger.rowsWritten;
      expect(ledger.restore(request, sign(A, request), RULE)).toMatchObject({
        ok: true,
        fresh: false,
      });
      expect(ledger.rowsWritten).toBe(rows2);
    });
  });

  it('refuses a restore while another creature is active, and for a dead or pending creature', async () => {
    await inLedger(async (ledger) => {
      const { A, g, c1 } = await lineageOfTwo(ledger);
      const fresh = hatch(ledger, g.owner); // the player started another life
      const request = restoreRequest(g, c1.id);
      expect(ledger.restore(request, sign(A, request), RULE)).toMatchObject({
        ok: false,
        reason: 'active-exists',
      });
      die(ledger, fresh);
      const onDead = restoreRequest(c1, c1.id);
      expect(ledger.restore(onDead, sign(A, onDead), RULE)).toMatchObject({
        ok: false,
        reason: 'dead',
      });
    });
  });
});

describe('the creature that died last', () => {
  it('is not displaced by a frozen ancestor that the walk marks dead afterwards', async () => {
    await inLedger(async (ledger) => {
      const { A, B, a, b } = await pair(ledger);
      const [c1, cb] = bear(ledger, mated(ledger, a, b));
      mustPromote(ledger, A, c1, a.id);
      mustPromote(ledger, B, cb, b.id);
      const [c2] = bear(ledger, mated(ledger, must(ledger.head(c1.id)), must(ledger.head(cb.id))));
      const dead = die(ledger, must(ledger.head(c1.id)));
      // G has less than restoreMinMs of life left, so the walk marks it dead after C1.
      const rule: Exhaustion = {
        lifespanOf: (head) => (head.id === a.id ? head.activeMs + 1000 : LIFESPAN),
        restoreMinMs: 120_000,
      };
      const walked = ledger.fallback(dead.id, rule).exhausted;
      expect(walked.map((h) => h.id)).toEqual([a.id]);
      expect(ledger.markExhausted(a.id, rule)).toMatchObject({ ok: true });
      expect(ledger.head(a.id)?.diedT).toBeLessThanOrEqual(must(ledger.head(c1.id)?.diedT));
      expect(promote(ledger, A, c2, dead.id)).toMatchObject({ ok: true, frozen: null });
    });
  });
});

describe('Ledger.alive', () => {
  it('is true while a creature is active, pending or frozen, false when all are dead', async () => {
    await inLedger(async (ledger) => {
      const { A, a, b } = await pair(ledger);
      expect(ledger.alive(a.owner)).toBe(true);
      const [child] = bear(ledger, mated(ledger, a, b));
      const dead = die(ledger, must(ledger.head(a.id)));
      expect(ledger.alive(a.owner)).toBe(true); // the pending child
      mustPromote(ledger, A, child, dead.id);
      expect(ledger.alive(a.owner)).toBe(true);
      die(ledger, must(ledger.head(child.id)));
      expect(ledger.alive(a.owner)).toBe(false);
      expect(ledger.alive((await newPlayer()).playerId)).toBe(false);
    });
  });
});

describe('the transition matrix against the store', () => {
  const STATUSES: Status[] = ['pending', 'active', 'checkpoint', 'dead'];

  /** A creature in `status`, made only through legitimate operations. */
  async function inStatus(ledger: Ledger, status: Status) {
    const { A, B, a, b } = await pair(ledger);
    if (status === 'active') return { A, B, target: a, b };
    if (status === 'dead') return { A, B, target: die(ledger, a), b };
    const [child] = bear(ledger, mated(ledger, a, b));
    if (status === 'pending') return { A, B, target: child, b, parent: must(ledger.head(a.id)) };
    mustPromote(ledger, A, child, a.id);
    return { A, B, target: must(ledger.head(a.id)), b };
  }

  const reasonOf = (r: { ok: boolean; reason?: string }): string =>
    r.ok ? 'accepted' : (r.reason ?? '');

  function expectCell(
    label: string,
    kind: RecordKind,
    role: string | null,
    status: Status,
    result: { ok: boolean; reason?: string },
  ) {
    const expected = transitionOutcome(kind, role, status);
    expect(result.ok, `${label}: ${reasonOf(result)}`).toBe(expected.ok);
    // The store names a finished creature `dead` (as in M4) where the matrix says `status:dead`.
    const reason =
      !expected.ok && expected.reason === 'status:dead' ? 'dead' : !expected.ok && expected.reason;
    if (!expected.ok && !result.ok) expect(result.reason, label).toBe(reason);
  }

  it('checkpoint and death accept exactly the cells of the matrix', async () => {
    await inLedger(async (ledger) => {
      for (const status of STATUSES) {
        const cp = await inStatus(ledger, status);
        expectCell(
          `checkpoint/${status}`,
          'checkpoint',
          null,
          status,
          ledger.accept({ request: checkpoint(cp.target) }),
        );
        const dt = await inStatus(ledger, status);
        // Only an exhausted checkpoint dies, and only through markExhausted.
        const result =
          status === 'checkpoint'
            ? ledger.markExhausted(dt.target.id, { lifespanOf: () => 1000, restoreMinMs: 5000 })
            : ledger.accept({
                request: chainRequest(dt.target, 'death', { cause: 'starved', activeMs: 1 }),
              });
        expectCell(`death/${status}`, 'death', null, status, result);
      }
    });
  });

  it('mate-commit accepts exactly the cells of the matrix', async () => {
    await inLedger(async (ledger) => {
      for (const status of STATUSES) {
        const { target } = await inStatus(ledger, status);
        const partner = hatch(ledger, (await newPlayer()).playerId);
        expectCell(
          `mate-commit/${status}`,
          'mate-commit',
          null,
          status,
          mate(ledger, target, partner),
        );
      }
    });
  });

  it('promote (child) and restore accept exactly the cells of the matrix', async () => {
    await inLedger(async (ledger) => {
      for (const status of STATUSES) {
        const { A, target } = await inStatus(ledger, status);
        const parent = status === 'pending' ? must(ledger.active(target.owner)).id : nextHex();
        expectCell(
          `promote:child/${status}`,
          'promote',
          'child',
          status,
          promote(ledger, A, target, parent),
        );
        const r = await inStatus(ledger, status);
        // The restore cell that is allowed needs a player with no active creature.
        const subject = status === 'checkpoint' ? await lineageOfTwo(ledger) : null;
        const ancestor = subject ? subject.g : r.target;
        const from = subject ? subject.c1.id : ancestor.id;
        const request = restoreRequest(ancestor, from);
        const who = subject ? subject.A : r.A;
        expectCell(
          `restore/${status}`,
          'restore',
          null,
          status,
          ledger.restore(request, sign(who, request), RULE),
        );
      }
    });
  });

  it('promote (parent) writes a freeze exactly when the parent is active', async () => {
    await inLedger(async (ledger) => {
      // Active parent: frozen.
      const live = await inStatus(ledger, 'pending');
      const active = mustPromote(ledger, live.A, live.target, must(live.parent).id);
      expect(active.frozen).not.toBeNull();
      expect(transitionOutcome('promote', 'parent', 'active').ok).toBe(true);
      // Dead parent: linked, no parent record.
      const { A, a, b } = await pair(ledger);
      const [child] = bear(ledger, mated(ledger, a, b));
      const dead = die(ledger, must(ledger.head(a.id)));
      expect(mustPromote(ledger, A, child, dead.id).frozen).toBeNull();
      expect(transitionOutcome('promote', 'parent', 'dead').ok).toBe(false);
      // Frozen parent while the player has a pending child and no active creature: refused.
      const p = await pair(ledger);
      const [c1, cb] = bear(ledger, mated(ledger, p.a, p.b));
      mustPromote(ledger, p.A, c1, p.a.id);
      mustPromote(ledger, p.B, cb, p.b.id);
      const [c2] = bear(ledger, mated(ledger, must(ledger.head(c1.id)), must(ledger.head(cb.id))));
      die(ledger, must(ledger.head(c1.id)));
      const refused = promote(ledger, p.A, c2, p.a.id);
      expect(refused).toMatchObject({ ok: false, reason: 'bad-parent' });
      expect(transitionOutcome('promote', 'parent', 'checkpoint').ok).toBe(false);
      expect(ledger.head(c2.id)?.status).toBe('pending');
    });
  });

  it('genesis and birth are the only kinds that create a creature', async () => {
    await inLedger(async (ledger) => {
      const { a, b } = await pair(ledger);
      expect(transitionOutcome('genesis', null, null).ok).toBe(true);
      expect(transitionOutcome('birth', null, null).ok).toBe(true);
      expect(ledger.accept({ request: genesisRequest(a.owner), genome: 'g' })).toMatchObject({
        ok: false,
        reason: 'already-active',
      });
      const m = mated(ledger, a, b);
      const [x] = birthChildren(m.commit, m.a, m.b, m.mates);
      expect(ledger.accept({ request: x.request })).toMatchObject({ ok: false });
    });
  });
});

describe('invariants under random operations', () => {
  // mulberry32
  const rng = (seed: number) => () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  it('keeps every chain, status and lineage invariant over 300 operations', async () => {
    const random = rng(2026);
    const pick = <T>(xs: T[]): T => xs[Math.floor(random() * xs.length)] as T;
    await inLedger(async (ledger) => {
      const players = await Promise.all([newPlayer(), newPlayer(), newPlayer(), newPlayer()]);
      const keys = ledger.pubkeys();
      const accepted: Array<{ redo: () => unknown; stored: unknown }> = [];
      const counts: Record<string, number> = {};
      const note = (op: string, ok: boolean) => {
        if (ok) counts[op] = (counts[op] ?? 0) + 1;
      };
      const lastDead = (owner: string): Head | null =>
        ledger.history(owner, 1)[0]
          ? ledger.head(must(ledger.history(owner, 1)[0]).creature)
          : null;
      const open = (): string[] =>
        ledger.storage.sql
          .exec<{ commit_id: string }>('SELECT commit_id FROM matings WHERE resolved = 0')
          .toArray()
          .map((r) => r.commit_id);
      const mating = new Map<string, { a: Head; b: Head; mates: [StoredRecord, StoredRecord] }>();

      for (let i = 0; i < 300; i++) {
        const p = pick(players);
        const id = p.playerId;
        const active = ledger.active(id);
        const op = pick([
          'hatch',
          'checkpoint',
          'checkpoint',
          'checkpoint',
          'mate',
          'mate',
          'mate',
          'mate',
          'mate',
          'mate',
          'birth',
          'birth',
          'birth',
          'birth',
          'birth',
          'promote',
          'promote',
          'promote',
          'promote',
          'promote',
          'die',
          'restore',
          'restore',
          'walk',
          'dup',
          'dup',
          'stale',
          'wrong-owner',
        ]);
        if (op === 'hatch') {
          if (!active && !ledger.alive(id)) {
            const request = genesisRequest(id);
            const r = ledger.accept({ request, genome: 'genome-text' });
            note(op, r.ok);
            if (r.ok)
              accepted.push({
                redo: () => ledger.accept({ request, genome: 'genome-text' }),
                stored: r.stored,
              });
          }
        } else if (op === 'checkpoint' && active) {
          const request = checkpoint(active, active.activeMs + Math.floor(random() * 2_000_000));
          const r = ledger.accept({ request });
          note(op, r.ok);
          if (r.ok) accepted.push({ redo: () => ledger.accept({ request }), stored: r.stored });
        } else if (op === 'mate') {
          const q = pick(players);
          const [x, y] = [active, ledger.active(q.playerId)];
          if (x && y) {
            const commit = nextHex();
            const requests = mateRequests(x, y, commit);
            const r = ledger.mate({ commit, round: ROUND, requests });
            note(op, r.ok);
            if (r.ok) {
              mating.set(commit, { a: x, b: y, mates: r.stored });
              accepted.push({
                redo: () => ledger.mate({ commit, round: ROUND, requests }),
                stored: r.stored,
              });
            }
          }
        } else if (op === 'birth') {
          const commit = open().find((c) => mating.has(c));
          const m = commit ? mating.get(commit) : undefined;
          if (commit && m) {
            const children = birthChildren(commit, m.a, m.b, m.mates);
            const r = ledger.birth({ commit, children });
            note(op, r.ok);
            if (r.ok)
              accepted.push({ redo: () => ledger.birth({ commit, children }), stored: r.stored });
          }
        } else if (op === 'promote') {
          const child = ledger.storage.sql
            .exec<{ id: string }>(
              "SELECT id FROM creatures WHERE owner = ? AND status = 'pending'",
              id,
            )
            .toArray()[0];
          const parent = active ?? lastDead(id);
          if (child && parent) {
            const request = promoteRequest(must(ledger.head(child.id)), parent.id);
            const ownerSig = sign(p, request);
            const r = ledger.promote(request, ownerSig);
            note(op, r.ok);
            if (r.ok)
              accepted.push({
                redo: () => ledger.promote(request, ownerSig),
                stored: [r.stored, r.frozen],
              });
          }
        } else if (op === 'die' && active) {
          const request = chainRequest(active, 'death', {
            cause: 'starved',
            activeMs: active.activeMs,
          });
          const r = ledger.accept({ request });
          note(op, r.ok);
          if (r.ok) {
            accepted.push({ redo: () => ledger.accept({ request }), stored: r.stored });
            const dead = must(ledger.head(active.id));
            for (const h of ledger.fallback(dead.id, RULE).exhausted) {
              const m = ledger.markExhausted(h.id, RULE);
              note('mark', m.ok);
            }
          }
        } else if (op === 'restore' && !active) {
          const dead = lastDead(id);
          const ancestor = dead ? ledger.fallback(dead.id, RULE).ancestor : null;
          if (dead && ancestor) {
            const request = restoreRequest(ancestor, dead.id);
            const ownerSig = sign(p, request);
            const r = ledger.restore(request, ownerSig, RULE);
            note(op, r.ok);
            if (r.ok)
              accepted.push({
                redo: () => ledger.restore(request, ownerSig, RULE),
                stored: r.stored,
              });
          }
        } else if (op === 'walk') {
          const dead = lastDead(id);
          for (const h of dead ? ledger.fallback(dead.id, RULE).exhausted : []) {
            note('mark', ledger.markExhausted(h.id, RULE).ok);
          }
        } else if (op === 'dup' && accepted.length > 0) {
          const entry = pick(accepted);
          const before = ledger.rowsWritten;
          const again = entry.redo() as { ok: boolean; fresh?: boolean };
          expect(again.ok).toBe(true);
          expect(again.fresh).toBe(false);
          expect(ledger.rowsWritten).toBe(before);
        } else if (op === 'stale' && active) {
          const r = ledger.accept({
            request: chainRequest(active, 'checkpoint', { activeMs: 1 }, active.seq + 2),
          });
          expect(r.ok).toBe(false);
        } else if (op === 'wrong-owner' && active) {
          const other = pick(players.filter((x) => x.playerId !== id));
          const r = ledger.accept({ request: { ...checkpoint(active), owner: other.playerId } });
          expect(r.ok).toBe(false);
        }
      }
      console.log('random operations accepted:', JSON.stringify(counts));
      for (const op of ['hatch', 'checkpoint', 'mate', 'birth', 'promote', 'die']) {
        expect(counts[op] ?? 0, op).toBeGreaterThan(0);
      }

      // Invariants.
      const sql = ledger.storage.sql;
      const creatures = sql
        .exec<{ id: string; owner: string; status: string; chain_parent: string | null }>(
          'SELECT id, owner, status, chain_parent FROM creatures',
        )
        .toArray();
      const owners = new Map<string, string>(creatures.map((c) => [c.id, c.owner]));
      for (const c of creatures) {
        const chain = ledger.chain(c.id);
        chain.forEach((r, n) => {
          expect(r.record.seq).toBe(n);
          expect(r.record.prev).toBe(n === 0 ? '' : (chain[n - 1] as StoredRecord).hash);
          expect(checkStored(r, keys)).toEqual([]);
        });
        expect(ledger.head(c.id)?.hash).toBe(chain.at(-1)?.hash);
        const first = chain[0]?.record;
        if (first?.kind === 'birth') {
          for (const parent of first.body.parents as string[])
            expect(owners.has(parent)).toBe(true);
        }
        // chain_parent: same owner, and following it terminates.
        const seen = new Set<string>([c.id]);
        for (
          let at = c.chain_parent;
          at;
          at = creatures.find((x) => x.id === at)?.chain_parent ?? null
        ) {
          expect(owners.get(at)).toBe(c.owner);
          expect(seen.has(at)).toBe(false);
          seen.add(at);
        }
      }
      for (const status of ['active', 'pending']) {
        const per = new Map<string, number>();
        for (const c of creatures.filter((x) => x.status === status)) {
          per.set(c.owner, (per.get(c.owner) ?? 0) + 1);
        }
        for (const n of per.values()) expect(n).toBeLessThanOrEqual(1);
      }
      // Every accepted request answers again unchanged and writes nothing.
      const rows = ledger.rowsWritten;
      for (const entry of accepted) {
        const again = entry.redo() as { ok: boolean; stored?: unknown; fresh?: boolean };
        expect(again.ok).toBe(true);
        expect(again.fresh).toBe(false);
      }
      expect(ledger.rowsWritten).toBe(rows);
    });
  });
});

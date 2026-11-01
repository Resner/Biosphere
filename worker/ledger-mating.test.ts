import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { checkStored, type RecordRequest } from '../src/ledger/record';
import { type BirthChild, Ledger } from './ledger';
import {
  bear,
  birthChildren,
  checkpoint,
  die,
  hatch,
  hex,
  inLedger,
  mate,
  mated,
  mateRequests,
  must,
  newPlayer,
  nextHex,
  pair,
  ROUND,
  RULE,
  step,
  stub,
} from './ledger-test-kit';
import { migrate } from './schema';

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
    expect(result.versions).toEqual([1, 2, 3, 4, 5, 6]);
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
      // Migration 5 alone: migration 6 renews the world and empties these tables (ADR 0040).
      migrate(sql, 5);
      const after = dump();
      const versions = () => sql.exec('SELECT version FROM migrations').toArray().length;
      const n = versions();
      migrate(sql, 5);
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

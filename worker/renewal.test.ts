import { runInDurableObject } from 'cloudflare:test';
import { env } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createIdentity, memoryKeyStore } from '../src/ledger/identity';
import { HATCH_BUCKET, Ledger } from './ledger';
import { migrate } from './schema';
import { closeSockets, hatch, login, sql, useFakeBeacons } from './test-hub';

// The world renewal (M6c T2, ADR 0040): migration 6 empties the world once and keeps identities;
// the hub tells each returning identity once.

const hex = (n: number): string => n.toString(16).padStart(64, '0');

beforeEach(useFakeBeacons);
afterEach(closeSockets);

describe('migration 6', () => {
  it('empties creatures, records, commitments, matings and the genesis log, keeps identities, and runs once', async () => {
    const out = await runInDurableObject(
      env.AUTHORITY.get(env.AUTHORITY.idFromName('renewal-db')),
      async (_o, state) => {
        const sql = state.storage.sql;
        // Throw away what this object's start-up made and build the schema before the renewal.
        const tables = sql
          .exec<{ name: string }>(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'",
          )
          .toArray();
        for (const { name } of tables) sql.exec(`DROP TABLE "${name}"`);
        migrate(sql, 5);
        const [p1, p2] = [
          await createIdentity(memoryKeyStore()),
          await createIdentity(memoryKeyStore()),
        ];
        // Every table holds a row.
        sql.exec("INSERT INTO ponds VALUES ('pond01', 'seed', 5, 100, 100, 5)");
        sql.exec(
          "INSERT INTO players (id, first_seen, last_seen, hatches, hatch_t, pending) VALUES (?, 10, 20, 0, 15, 'c1')",
          p1.playerId,
        );
        sql.exec(
          "INSERT INTO players (id, first_seen, last_seen, hatches, hatch_t, pending) VALUES (?, 11, 21, 2, 16, '')",
          p2.playerId,
        );
        sql.exec(
          `INSERT INTO creatures (id, owner, status, seq, hash, genome, active_ms, biomass, energy, health, born_t, died_t)
           VALUES (?, ?, 'active', 0, ?, 'g', 1000, 150, 8000, 9000, 5, NULL),
                  (?, ?, 'dead', 2, ?, 'g', 1000, 150, 8000, 9000, 5, 9),
                  (?, ?, 'pending', 0, ?, 'g', 0, 0, 0, 0, 5, NULL)`,
          hex(1),
          p1.playerId,
          hex(1),
          hex(2),
          p1.playerId,
          hex(2),
          hex(3),
          p2.playerId,
          hex(3),
        );
        sql.exec(
          `INSERT INTO records (creature, seq, hash, req, kind, owner, t, json, owner_sig, auth_sig, key_id)
           VALUES (?, 0, ?, ?, 'genesis', ?, 5, '{}', NULL, 'sig', 'key')`,
          hex(1),
          hex(1),
          hex(9),
          p1.playerId,
        );
        sql.exec(
          `INSERT INTO commitments (id, kind, owner, round, req, json, auth_sig, key_id, created, resolved)
           VALUES ('c1', 'genesis', ?, 100, 'r1', '{}', 'sig', 'key', 5, NULL)`,
          p1.playerId,
        );
        sql.exec(
          `INSERT INTO matings (commit_id, owner_a, owner_b, creature_a, creature_b, round, t)
           VALUES ('m1', ?, ?, ?, ?, 100, 5)`,
          p1.playerId,
          p2.playerId,
          hex(1),
          hex(3),
        );
        sql.exec("INSERT INTO genesis_log VALUES ('r1', ?, ?, 5)", hex(1), p1.playerId);
        sql.exec("INSERT INTO beacons VALUES (100, 'beacon-sig')");
        sql.exec("INSERT INTO keys VALUES ('k1', 'pub', X'00', 1)");
        sql.exec("INSERT INTO usage VALUES ('2026-10-31', 10, 200, 30)");
        sql.exec(
          "INSERT INTO flags (kind, owner, creature, hash, t) VALUES ('x', ?, ?, ?, 5)",
          p1.playerId,
          hex(1),
          hex(1),
        );
        const count = (table: string) =>
          sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM ${table}`).one().n;
        const wiped = ['creatures', 'records', 'commitments', 'matings', 'genesis_log'];
        const kept = ['ponds', 'keys', 'usage', 'flags', 'beacons'];
        const keptRows = () =>
          Object.fromEntries(
            kept.map((t) => [t, sql.exec(`SELECT * FROM ${t} ORDER BY 1`).toArray()]),
          );
        const dump = () => ({
          wiped: Object.fromEntries(wiped.map((t) => [t, count(t)])),
          kept: keptRows(),
          players: sql
            .exec(
              'SELECT id, first_seen, last_seen, hatches, hatch_t, pending, epoch_seen FROM players ORDER BY first_seen',
            )
            .toArray(),
          world: sql.exec('SELECT epoch, reset_at FROM world').toArray(),
          versions: sql
            .exec<{ version: number }>('SELECT version FROM migrations ORDER BY version')
            .toArray()
            .map((r) => r.version),
        });
        const beforeKept = keptRows();
        const from = Date.now();
        migrate(sql);
        const after = dump();
        migrate(sql);
        const again = dump();
        const ledger = new Ledger(state.storage);
        return {
          from,
          to: Date.now(),
          beforeKept,
          after,
          again,
          ids: [p1.playerId, p2.playerId],
          history: ledger.history(p1.playerId, 5),
          hatches: ledger.hatches(p1.playerId, Date.now()).left,
          active: ledger.active(p1.playerId),
          pending: ledger.pending(p2.playerId),
        };
      },
    );
    expect(out.after.versions).toEqual([1, 2, 3, 4, 5, 6]);
    // Identities, keys, usage, flags, beacons and ponds survive untouched.
    expect(out.after.kept).toEqual(out.beforeKept);
    expect(out.after.players.map((p) => [p.id, p.first_seen, p.last_seen])).toEqual([
      [out.ids[0], 10, 20],
      [out.ids[1], 11, 21],
    ]);
    // The world is empty: no creature, record, commitment, mating or genesis-log entry.
    expect(out.after.wiped).toEqual({
      creatures: 0,
      records: 0,
      commitments: 0,
      matings: 0,
      genesis_log: 0,
    });
    // Nothing points at a deleted commitment, and every bucket is full.
    for (const p of out.after.players) {
      expect(p).toMatchObject({ pending: '', hatches: HATCH_BUCKET, hatch_t: 0, epoch_seen: 0 });
    }
    expect(out.hatches).toBe(HATCH_BUCKET);
    expect(out.history).toEqual([]);
    expect(out.active).toBeNull();
    expect(out.pending).toBeNull();
    // The one-row world table holds epoch 2 and the migration's time.
    expect(out.after.world).toHaveLength(1);
    expect(out.after.world[0]?.epoch).toBe(2);
    expect(out.after.world[0]?.reset_at).toBeGreaterThanOrEqual(out.from);
    expect(out.after.world[0]?.reset_at).toBeLessThanOrEqual(out.to);
    // A second run is a no-op.
    expect(out.again).toEqual(out.after);
  });
});

describe('the renewal notice', () => {
  const resetAt = async () =>
    (await sql<{ reset_at: number }>('SELECT reset_at FROM world'))[0]?.reset_at ?? 0;

  it('tells a returning identity once', async () => {
    const id = await createIdentity(memoryKeyStore());
    // An identity first seen before the reset, as every player of the old world is.
    await sql(
      'INSERT INTO players (id, first_seen, last_seen) VALUES (?1, ?2, ?2)',
      id.playerId,
      (await resetAt()) - 60_000,
    );
    const first = await login(id);
    expect(first.life.renewed).toBe(true);
    expect((await sql('SELECT epoch_seen FROM players WHERE id = ?', id.playerId))[0]).toEqual({
      epoch_seen: 2,
    });
    const second = await login(id);
    expect(second.life.renewed).toBeUndefined();
    const third = await login(id);
    expect(third.life.renewed).toBeUndefined();
  });

  it('never tells a new identity', async () => {
    const { c, id, life } = await login();
    expect(life.renewed).toBeUndefined();
    // Hatching writes the player's row, first seen after the reset.
    await hatch(c, id);
    expect(
      (
        await sql<{ first_seen: number }>(
          'SELECT first_seen FROM players WHERE id = ?',
          id.playerId,
        )
      )[0]?.first_seen,
    ).toBeGreaterThanOrEqual(await resetAt());
    const again = await login(id);
    expect(again.life.renewed).toBeUndefined();
  });
});

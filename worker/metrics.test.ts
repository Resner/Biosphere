import { runInDurableObject } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { meteredSql, type RowCounter } from './metered-sql';
import type { Metrics } from './metrics';
import { CHECKED } from './plan';
import { migrate } from './schema';
import {
  CALM,
  type Client,
  closeSockets,
  flush,
  hatch,
  login,
  nextOf,
  ORIGIN,
  report,
  signIn,
  sql,
  stub,
  useFakeBeacons,
} from './test-hub';
import { DAY_MS, type UsageDay, type UsageMeter } from './usage';

// M13 T1 (ADR 0067): the day in depth, and `GET /v1/metrics`. Each test lives on a day of its own
// (a mocked `Date.now`), so the meter's day starts empty and earlier tests leave no counts in it.

interface Inside {
  usage: UsageMeter;
  env: Record<string, string | undefined>;
  rowCount: RowCounter;
  proofReads: number;
  proof(creature: string): unknown;
  metrics(): Metrics;
}

const inside = <T>(fn: (o: Inside) => T): Promise<T> =>
  runInDurableObject(stub(), (o) => fn(o as unknown as Inside));

let dayNo = 0;
let wall = 0;

beforeEach(async () => {
  await useFakeBeacons();
  dayNo++;
  wall = Date.UTC(2032, 0, 1, 10, 0, 0) + dayNo * 3 * DAY_MS;
  vi.spyOn(Date, 'now').mockImplementation(() => wall);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeSockets();
  await inside((o) => {
    delete o.env.MAX_SESSIONS;
    delete o.env.DAILY_REQUEST_BUDGET;
  });
});

const today = () => inside((o) => o.usage.today(wall));
const metrics = () => inside((o) => o.metrics());

/** A ping and its pong: every message sent before it has been counted. */
async function barrier(c: Client): Promise<void> {
  c.send({ t: 'ping', id: 1 });
  await nextOf(c, 'pong');
}

const GET = (path: string, origin: string | null = ORIGIN) =>
  exports.default.fetch(`https://authority.test${path}`, {
    headers: origin ? { Origin: origin } : {},
  });

describe('migration 13', () => {
  it('adds the day’s columns, and an older row reads as zeros and {}', async () => {
    const columns = await sql<{ name: string }>("SELECT name FROM pragma_table_info('usage')");
    const names = columns.map((c) => c.name);
    for (const name of [
      'by_type',
      'upgrades',
      'reads',
      'rows_read',
      'player_ms',
      'peak_seated',
      'peak_queued',
      'waits',
      'wait_ms',
      'relay_reports',
      'relay_links',
      'relay_relayed',
      'relay_kb',
    ]) {
      expect(names).toContain(name);
    }
    // A row written before the migration, with only the original columns.
    const old = new Date(wall - DAY_MS).toISOString().slice(0, 10);
    await sql(
      'INSERT OR REPLACE INTO usage (day, requests, messages, rows_written, db_bytes) VALUES (?, 7, 140, 9, 1000)',
      old,
    );
    const days = await inside((o) => o.usage.history(wall));
    const row = days.find((d) => d.day === old);
    expect(row).toEqual({
      day: old,
      requests: 7,
      messages: 140,
      byType: {},
      upgrades: 0,
      reads: 0,
      rowsWritten: 9,
      rowsRead: 0,
      dbBytes: 1000,
      playerMs: 0,
      peakSeated: 0,
      peakQueued: 0,
      waits: 0,
      waitMs: 0,
      relay: { reports: 0, links: 0, relayed: 0, kb: 0 },
    } satisfies UsageDay);
  });

  it('applies to a database at version 12', async () => {
    await inside((_o) => undefined);
    const { v } = (await sql<{ v: number }>('SELECT MAX(version) AS v FROM migrations'))[0] as {
      v: number;
    };
    expect(v).toBeGreaterThanOrEqual(13);
    // Running the migrations again changes nothing.
    await runInDurableObject(stub(), (_o, state) => migrate(state.storage.sql));
  });
});

describe('counting messages', () => {
  it('counts each type, the unparsable ones as bad, and 20 messages as one request', async () => {
    const { c } = await login();
    await barrier(c);
    const before = await today();
    const requestsBefore = await inside((o) => o.usage.requests(wall));
    for (let i = 0; i < 10; i++) c.send({ t: 'where', x: 4000, y: 4000, r: 10, aoi: 233 });
    for (let i = 1; i <= 3; i++) report(c, i * 30, CALM, 100 + i);
    c.send('{not json');
    await barrier(c);
    const after = await today();
    const delta = (k: string) => (after.byType[k] ?? 0) - (before.byType[k] ?? 0);
    expect([delta('where'), delta('progress'), delta('bad'), delta('ping')]).toEqual([10, 3, 1, 1]);
    expect(after.messages - before.messages).toBe(15);
    const requestsAfter = await inside((o) => o.usage.requests(wall));
    expect(requestsAfter - requestsBefore).toBeCloseTo(15 / 20, 10);
  });

  it('counts an upgrade as one request, and a flush writes once within a minute', async () => {
    const before = await today();
    const first = await signIn();
    await nextOf(first.c, 'welcome');
    const mid = await today();
    expect(mid.upgrades - before.upgrades).toBe(1);
    // The upgrade and the hello: 1 + 1/20 request-equivalents (rounded up once).
    const stored = () =>
      sql<{ rows_written: number; upgrades: number }>(
        'SELECT rows_written, upgrades FROM usage WHERE day = ?',
        mid.day,
      );
    await inside((o) => o.usage.flush(wall));
    const [flushed] = await stored();
    expect(flushed?.upgrades).toBe(mid.upgrades);
    const writes = () => inside((o) => o.rowCount.written);
    const written = await writes();
    wall += 10_000;
    await inside((o) => o.usage.flush(wall));
    expect(await writes()).toBe(written);
    expect((await stored())[0]).toEqual(flushed);
  });
});

describe('counting rows', () => {
  it('adds every statement’s rows read and written, as the cursors report them', async () => {
    await runInDurableObject(stub(), (_o, state) => {
      const raw = state.storage.sql;
      const cursors: SqlStorageCursor<Record<string, SqlStorageValue>>[] = [];
      const spy = {
        exec(query: string, ...bindings: unknown[]) {
          const cursor = raw.exec(query, ...bindings);
          cursors.push(cursor);
          return cursor;
        },
        databaseSize: raw.databaseSize,
      } as unknown as SqlStorage;
      const counter: RowCounter = { written: 0, read: 0 };
      const sql = meteredSql(spy, counter);
      sql.exec('CREATE TABLE IF NOT EXISTS probe (k INTEGER PRIMARY KEY, v TEXT)');
      sql.exec('DELETE FROM probe');
      for (let k = 0; k < 20; k++) sql.exec('INSERT INTO probe VALUES (?, ?)', k, 'x');
      sql.exec("UPDATE probe SET v = 'y' WHERE k < 5");
      expect(sql.exec('SELECT * FROM probe').toArray()).toHaveLength(20);
      sql.exec('SELECT COUNT(*) AS n FROM probe').one();
      for (const row of sql.exec('SELECT k FROM probe WHERE k < 3')) expect(row).toBeDefined();
      const taken = sql.exec('SELECT * FROM probe');
      taken.next();
      taken.next();
      taken.toArray();
      sql.exec('DROP TABLE probe');
      expect(counter.written).toBe(cursors.reduce((n, c) => n + c.rowsWritten, 0));
      expect(counter.read).toBe(cursors.reduce((n, c) => n + c.rowsRead, 0));
      expect(counter.written).toBeGreaterThan(20);
      expect(counter.read).toBeGreaterThan(20);
    });
  });

  it('counts a genesis hatch’s rows, and a proof read’s rows read', async () => {
    const { c, id } = await login();
    const before = await inside((o) => ({ ...o.rowCount, ledger: o.rowCount.written }));
    const genesis = await hatch(c, id);
    const after = await inside((o) => ({ ...o.rowCount }));
    expect(after.written - before.written).toBeGreaterThanOrEqual(5);
    expect(after.read).toBeGreaterThan(before.read);
    const readsBefore = after.read;
    await inside((o) => o.proof(genesis.record.hash));
    const readsAfter = await inside((o) => o.rowCount.read);
    expect(readsAfter).toBeGreaterThan(readsBefore);
    const day = await today();
    expect(day.rowsWritten).toBeGreaterThanOrEqual(after.written - before.written);
    expect(day.rowsRead).toBeGreaterThan(0);
  });
});

describe('seated time', () => {
  it('adds up seated session time, the peaks and the waits in the line', async () => {
    await inside((o) => {
      o.env.MAX_SESSIONS = '3';
    });
    const a = await login();
    const b = await login();
    const c = await login();
    const waiting = await signIn();
    expect((await waiting.c.next()).t).toBe('queued');
    wall += 30_000;
    c.c.ws.close(1000, 'bye');
    // The first in line takes the freed seat after its 30 s wait.
    await nextOf(waiting.c, 'welcome');
    wall += 30_000;
    const seated = async (n: number) =>
      vi.waitFor(async () => expect((await metrics()).live.seated).toBe(n));
    await seated(3);
    for (const x of [a, b, waiting]) x.c.ws.close(1000, 'bye');
    await seated(0);
    const day = await today();
    // Three sessions for 30 s, then three again for 30 s (one seat changed hands): 180 s.
    expect(day.playerMs).toBeGreaterThanOrEqual(179_000);
    expect(day.playerMs).toBeLessThanOrEqual(181_000);
    expect(day.peakSeated).toBe(3);
    expect(day.peakQueued).toBe(1);
    expect(day.waits).toBe(1);
    expect(day.waitMs).toBeGreaterThanOrEqual(29_000);
    expect(day.waitMs).toBeLessThanOrEqual(31_000);
  });

  it('writes the seated time, the peaks and the types in the day’s row at a flush', async () => {
    const a = await login();
    wall += 60_000;
    await barrier(a.c);
    await inside((o) => o.usage.flush(wall));
    const day = await today();
    const [row] = await sql<{ player_ms: number; peak_seated: number; by_type: string }>(
      'SELECT player_ms, peak_seated, by_type FROM usage WHERE day = ?',
      day.day,
    );
    expect(row?.player_ms).toBeGreaterThanOrEqual(59_000);
    expect(row?.peak_seated).toBe(1);
    expect(JSON.parse(row?.by_type ?? '{}')).toMatchObject({ ping: 1 });
  });
});

describe('GET /v1/metrics', () => {
  beforeEach(() => caches.default.delete(new Request('https://authority.test/v1/metrics')));

  it('answers the shape, with no player named', async () => {
    const { c, id } = await login();
    await barrier(c);
    const res = await GET('/v1/metrics');
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toBe('public, max-age=60');
    expect(res.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    const text = await res.text();
    const body = JSON.parse(text) as Metrics;
    expect(Object.keys(body).sort()).toEqual([
      'admission',
      'checked',
      'days',
      'limits',
      'live',
      'month',
      'now',
      'plan',
      'storage',
      'today',
    ]);
    expect(body.plan).toBe('free');
    expect(body.checked).toBe(CHECKED);
    expect(body.limits).toMatchObject({ requestsPerDay: 100_000, storageBytes: 1_000_000_000 });
    expect(Object.keys(body.live).sort()).toEqual(
      ['away', 'crowds', 'fights', 'instances', 'members', 'queued', 'seated', 'witnessed'].sort(),
    );
    expect(body.live.seated).toBe(1);
    expect(body.today.byType.ping).toBeGreaterThanOrEqual(1);
    expect(body.today.reads).toBe(1);
    expect(body.month.requests).toBeGreaterThanOrEqual(body.today.requests);
    expect(body.storage.limit).toBe(1_000_000_000);
    expect(body.storage.bytes).toBeGreaterThan(0);
    expect(body.admission).toEqual({
      open: true,
      why: null,
      turn: true,
      seatEveryS: 30,
      waits: null,
    });
    expect(text).not.toContain(id.playerId);
    expect(text).not.toMatch(/[0-9a-f]{64}/);
  });

  it('refuses a foreign origin and caches an answer for the edge', async () => {
    expect((await GET('/v1/metrics', 'https://evil.example')).status).toBe(403);
    const before = await inside((o) => o.proofReads);
    const first = await GET('/v1/metrics');
    expect(first.status).toBe(200);
    expect(await inside((o) => o.proofReads)).toBe(before + 1);
    const again = await GET('/v1/metrics');
    expect(again.status).toBe(200);
    expect(await inside((o) => o.proofReads)).toBe(before + 1);
  });

  it('still answers past 80% of the day’s requests', async () => {
    await inside((o) => {
      o.env.DAILY_REQUEST_BUDGET = '10';
      for (let i = 0; i < 400; i++) o.usage.message(wall, 'where');
    });
    expect(await inside((o) => o.usage.requests(wall))).toBeGreaterThan(8);
    const res = await GET('/v1/metrics');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Metrics;
    expect(body.admission.open).toBe(false);
    expect(body.limits.requestsPerDay).toBe(10);
  });

  it('holds yesterday’s row among the days on a new day, and has no rate with no seated time', async () => {
    await inside((o) => {
      for (let i = 0; i < 40; i++) o.usage.message(wall, 'where');
      o.usage.flush(wall);
    });
    const day = await today();
    wall += DAY_MS;
    const body = await metrics();
    expect(body.today.day).not.toBe(day.day);
    expect(body.days[0]?.day).toBe(day.day);
    expect(body.days[0]?.messages).toBe(40);
    expect(body.today.perPlayerMinute).toBeNull();
    expect(body.today.perPlayerHour).toBeNull();
  });

  it('shows the rates per seated player-minute', async () => {
    const a = await login();
    wall += 120_000;
    await barrier(a.c);
    await flush(a.c);
    const body = await metrics();
    expect(body.today.perPlayerMinute?.messages).toBeGreaterThan(0);
    expect(body.today.perPlayerHour?.rowsWritten).toBeGreaterThan(0);
  });
});

import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { stub } from './test-hub';
import { UsageMeter } from './usage';

const DAY = 86_400_000;
const T0 = Date.UTC(2031, 0, 5, 10, 0, 0);

interface Row extends Record<string, SqlStorageValue> {
  day: string;
  requests: number;
  messages: number;
  rows_written: number;
}

/** Runs `fn` with a fresh meter over the object's real SQLite and an empty `usage` table. */
function withMeter<T>(
  fn: (meter: UsageMeter, rows: () => Row[], writes: { n: number }) => T,
): Promise<T> {
  return runInDurableObject(stub(), (_o, state) => {
    const sql = state.storage.sql;
    sql.exec('DELETE FROM usage');
    const writes = { n: 0 };
    const meter = new UsageMeter(sql, () => writes.n);
    return fn(meter, () => sql.exec<Row>('SELECT * FROM usage ORDER BY day').toArray(), writes);
  });
}

describe('UsageMeter', () => {
  it('counts an upgrade as 1 request and 20 messages as 1', async () => {
    await withMeter((meter, rows) => {
      for (let i = 0; i < 40; i++) meter.upgrade(T0);
      for (let i = 0; i < 3000; i++) meter.message(T0);
      expect(meter.requests(T0)).toBe(190);
      meter.flush(T0);
      expect(rows()).toEqual([
        { day: '2031-01-05', requests: 190, messages: 3000, rows_written: 1 },
      ]);
    });
  });

  it('writes at most one row a minute under constant traffic', async () => {
    await withMeter((meter, rows) => {
      for (let s = 0; s < 3600; s++) {
        meter.message(T0 + s * 1000);
        meter.message(T0 + s * 1000);
      }
      const stored = rows()[0];
      // One upsert per minute into the day's single row; the last partial minute is still in memory.
      expect(stored?.rows_written).toBeLessThanOrEqual(60);
      expect(stored?.rows_written).toBeGreaterThanOrEqual(59);
      expect(rows()).toHaveLength(1);
    });
  });

  it('writes nothing while nothing changed', async () => {
    await withMeter((meter, rows) => {
      meter.message(T0);
      meter.flush(T0);
      const before = rows()[0];
      meter.flush(T0 + 10 * 60_000);
      meter.requests(T0 + 20 * 60_000);
      expect(rows()[0]).toEqual(before);
    });
  });

  it('counts the ledger rows written since the last flush', async () => {
    await withMeter((meter, rows, writes) => {
      meter.message(T0);
      writes.n = 7;
      meter.flush(T0 + 1000);
      expect(rows()[0]?.rows_written).toBe(8);
      writes.n = 9;
      meter.flush(T0 + 2000);
      expect(rows()[0]?.rows_written).toBe(11);
    });
  });

  it('starts a new row at midnight UTC and keeps the old one', async () => {
    await withMeter((meter, rows) => {
      const late = Math.floor(T0 / DAY) * DAY + DAY - 1000;
      for (let i = 0; i < 100; i++) meter.message(late);
      expect(meter.requests(late)).toBe(5);
      const early = late + 2000;
      expect(meter.requests(early)).toBe(0);
      meter.message(early);
      meter.flush(early);
      expect(rows().map((r) => [r.day, r.requests, r.messages])).toEqual([
        ['2031-01-05', 5, 100],
        ['2031-01-06', 0, 1],
      ]);
    });
  });

  it('picks up the stored row after an eviction', async () => {
    await runInDurableObject(stub(), (_o, state) => {
      const sql = state.storage.sql;
      sql.exec('DELETE FROM usage');
      const first = new UsageMeter(sql, () => 0);
      for (let i = 0; i < 200; i++) first.message(T0);
      first.flush(T0);
      const second = new UsageMeter(sql, () => 0);
      expect(second.requests(T0 + 1000)).toBe(10);
    });
  });
});

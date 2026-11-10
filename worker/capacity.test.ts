import { describe, expect, it } from 'vitest';
import {
  ASSUMPTIONS,
  billOf,
  capOf,
  crowdHours,
  derive,
  freeServes,
  freeVerdict,
  HEADROOM_H,
  headroomOf,
  logWindowDays,
  type Measured,
  monthStorage,
  objectCapacity,
  objectsFor,
  paidMonthUsd,
  paidPlayers,
  ratesOf,
  STORE_DAYS_MIN,
  storeDays,
  turnGb,
  usageOf,
} from './capacity';
import {
  allowances,
  CEILING_USD,
  DERIVED,
  FREE,
  INCLUDED,
  MEASURED,
  PAID,
  PRICES,
  sessionCap,
  TABLES,
} from './plan';

// M13 T8: the capacity model's arithmetic, and `plan.ts`'s derived values. The numbers that come
// from the committed measurements are checked against them in `tools/capacity-report.test.ts`.

/** A model whose per-player numbers are round: 10 messages a minute, no fights. */
const ROUND: Measured = {
  world: 6,
  page: { where: 2, progress: 2, ping: 1, signal: 4, avail: 0, total: 9 },
  fight: { frames: 300, alone: 600, witnessed: 100 },
  session: { rowsWritten: 3, rowsRead: 30 },
  fightRows: { written: 37, read: 37 },
  lifecycle: { mating: 20, promote: 5 },
  cpuMsPerMessage: 1,
  clientKBps: 4,
  memoryBytesPerSession: 1000,
  bytes: { hour: 2800, hatch: 2600, settled: 1800, logged: 6600 },
};
const NO_FIGHTS = { ...ASSUMPTIONS, fightsPerHour: 0 };

describe('the capacity arithmetic', () => {
  it('10,000 players at 10 messages a minute send 1,667 a second and 7.2 M request-equivalents a day', () => {
    const m: Measured = { ...ROUND, world: 7 }; // 7 + progress 2 + ping 1 + avail 0 = 10
    // No fights, and sessions so long that their upgrades and reads vanish: messages alone.
    const only = { ...NO_FIGHTS, sessionMinutes: 1e12 };
    const u = usageOf(m, 10_000, only);
    expect(u.messagesPerSecond).toBeCloseTo(1666.67, 1);
    expect(u.requestsPerDay).toBeCloseTo(7.2e6, -3);
  });

  it('216 M request-equivalents a month on the paid plan cost $37.25 for requests', () => {
    const u = usageOf(ROUND, 1, NO_FIGHTS);
    const month = { ...u, requestsPerDay: 216e6 / 30 };
    const bill = billOf(month, TABLES, 0);
    expect(bill.base + bill.requests).toBeCloseTo(5 + (216 - 1) * 0.15, 6);
    expect(bill.base + bill.requests).toBeCloseTo(37.25, 6);
  });

  it('200 players receiving 1 KB/s each over a relay for 30 days give 518 GB of TURN, in decimal units', () => {
    expect(turnGb(200, 1, 30)).toBeCloseTo(518.4, 6);
  });

  it('finds the binding limit of each row of the table', () => {
    for (const players of [5, 50, 200, 1000, 10_000]) {
      const u = usageOf(MEASURED, players);
      const v = freeVerdict(u, TABLES);
      if (v.within) {
        expect(u.requestsPerDay).toBeLessThanOrEqual(TABLES.free.requestsPerDay);
        expect(u.rowsWrittenPerDay).toBeLessThanOrEqual(TABLES.free.rowsWrittenPerDay);
      } else {
        // The named meter is the one that gives the fewest hours of the day.
        const hours: Record<string, number> = {
          requests: (24 * TABLES.free.requestsPerDay) / u.requestsPerDay,
          'rows written': (24 * TABLES.free.rowsWrittenPerDay) / u.rowsWrittenPerDay,
          'rows read': (24 * TABLES.free.rowsReadPerDay) / u.rowsReadPerDay,
        };
        expect(v.hours).toBeCloseTo(Math.min(...Object.values(hours), 24), 6);
        expect(hours[v.first ?? '']).toBeCloseTo(v.hours, 6);
      }
    }
  });

  it('the derived paid allowances spend at most $4.50 above the base at the mix', () => {
    const players = paidPlayers(MEASURED, TABLES);
    expect(players).toBeGreaterThan(0);
    // Spending each allowance in full for the month, with the rest at that population's level.
    const u = usageOf(MEASURED, players);
    const spent = {
      ...u,
      requestsPerDay: allowances('paid').requestsPerDay,
      rowsWrittenPerDay: allowances('paid').rowsWrittenPerDay,
      rowsReadPerDay: allowances('paid').rowsReadPerDay,
    };
    const bill = billOf(spent, TABLES, monthStorage(u));
    expect(bill.total - bill.base).toBeLessThanOrEqual(CEILING_USD - 5 + 1e-9);
    expect(bill.total).toBeLessThanOrEqual(CEILING_USD);
    // One more player would pass the ceiling.
    expect(paidMonthUsd(MEASURED, TABLES, players + 1)).toBeGreaterThan(CEILING_USD);
  });

  it('the free plan caps at 80% of one object, and the paid plan at the smaller of its money cap and that (ADR 0075)', () => {
    const cap = capOf(objectCapacity(MEASURED));
    expect(cap).toBe(Math.floor(0.8 * DERIVED.capacity.players));
    expect(FREE.sessions).toBe(cap);
    expect(FREE.sessions).toBe(621);
    expect(PAID.sessions).toBe(Math.min(DERIVED.paid.around, cap));
    expect(PAID.sessions).toBe(590);
    expect(sessionCap('paid')).toBe(PAID.sessions);
    expect(sessionCap('free')).toBe(FREE.sessions);
    // The free plan's allowances serve far fewer around the clock: the headroom keeps the day.
    expect(DERIVED.free.around).toBeLessThan(FREE.sessions);
  });

  it('one object is bound by the smallest of CPU, messages and memory', () => {
    const c = objectCapacity(MEASURED);
    expect(c.players).toBe(Math.min(c.byCpu, c.byMessages, c.byMemory));
    expect(c.players).toBeGreaterThanOrEqual(200);
    expect(objectsFor(c, 10_000)).toBe(Math.ceil(10_000 / capOf(c)));
  });

  it('the free plan serves whole player-hours and the plans carry their values', () => {
    const f = freeServes(MEASURED, TABLES);
    expect(f.around).toBe(Math.floor(f.playerHours / 24));
    expect(FREE.requestsPerDay).toBe(100_000);
    expect(PAID.requestsPerDay).toBeGreaterThanOrEqual(Math.floor(INCLUDED.requests / 30));
    expect(PAID.rowsWrittenPerDay).toBeGreaterThanOrEqual(Math.floor(INCLUDED.rowsWritten / 30));
    expect(PRICES.requestsPerM).toBe(0.15);
    expect(derive(MEASURED, TABLES)).toEqual(DERIVED);
  });

  it('the log window follows the store rule', () => {
    const f = freeServes(MEASURED, TABLES);
    const days = storeDays(MEASURED, f.playerHours, TABLES.free.storageBytes, 14);
    expect(logWindowDays(MEASURED, TABLES)).toBe(days >= STORE_DAYS_MIN ? 14 : 7);
    // A store a tenth the size cannot last: the window shortens.
    expect(
      logWindowDays(MEASURED, { ...TABLES, free: { ...TABLES.free, storageBytes: 1e8 } }),
    ).toBe(7);
  });
});

describe('the headroom (ADR 0075)', () => {
  const r = ratesOf(MEASURED, ASSUMPTIONS);
  const free = allowances('free');

  it('seats well over a crowd of 500 on a fresh free day, and with matings priced it falls below the free cap', () => {
    expect(HEADROOM_H).toBe(2);
    expect(headroomOf(free, r)).toBeGreaterThan(500);
    expect(headroomOf(free, r)).toBeLessThan(FREE.sessions);
  });

  it('with rows written at 60% of the allowance, is ⌊40,000 ÷ (rows written per player-hour × 2)⌋', () => {
    const left = { ...free, rowsWrittenPerDay: 0.4 * FREE.rowsWrittenPerDay };
    expect(left.rowsWrittenPerDay).toBe(40_000);
    expect(headroomOf(left, r)).toBe(Math.floor(40_000 / (r.rowsWrittenPerHour * 2)));
  });

  it('is the smallest over requests, rows written and rows read, and none once one is spent', () => {
    const left = { requestsPerDay: 1_000, rowsWrittenPerDay: 1e9, rowsReadPerDay: 1e12 };
    expect(headroomOf(left, r)).toBe(Math.floor(1_000 / (r.requestsPerHour * 2)));
    expect(headroomOf({ ...left, rowsReadPerDay: -5 }, r)).toBe(0);
  });

  it('is above the paid cap on a fresh day', () => {
    expect(headroomOf(allowances('paid'), r)).toBeGreaterThan(PAID.sessions);
  });

  it.each([50, 200, 500])(
    'a crowd of %i from a fresh free day: the headroom falls below it and the budget guard holds when crowdHours says',
    (players) => {
      const h = crowdHours(free, r, players);
      // What is left after `t` hours of the crowd's play.
      const leftAt = (t: number) => ({
        requestsPerDay: free.requestsPerDay - players * r.requestsPerHour * t,
        rowsWrittenPerDay: free.rowsWrittenPerDay - players * r.rowsWrittenPerHour * t,
        rowsReadPerDay: free.rowsReadPerDay - players * r.rowsReadPerHour * t,
      });
      expect(headroomOf(leftAt(h.headroom - 0.01), r)).toBeGreaterThanOrEqual(players);
      expect(headroomOf(leftAt(h.headroom + 0.01), r)).toBeLessThan(players);
      const spent = leftAt(h.budget);
      expect(spent.rowsWrittenPerDay).toBeCloseTo(0.1 * free.rowsWrittenPerDay, 3);
    },
  );

  it('about 200 players play over three hours of a fresh free day before the headroom stops newcomers, and over five before the budget guard', () => {
    const h = crowdHours(free, r, 200);
    expect(h.headroom).toBeGreaterThan(3);
    expect(h.budget).toBeGreaterThan(h.headroom);
    expect(h.budget).toBeGreaterThan(5);
    expect(h.budget).toBeLessThan(5.5);
  });
});

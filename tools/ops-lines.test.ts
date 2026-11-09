import { describe, expect, it } from 'vitest';
import audit from '../tests/fixtures/ops/audit-clean.json';
import idle from '../tests/fixtures/ops/metrics-idle.json';
import {
  type AuditReport,
  errorLine,
  HOURS_LEFT_WARN,
  hoursLeft,
  hoursToGuard,
  type Metrics,
  parseAudit,
  parseMetrics,
  ratePerHour,
  savePath,
  statusLine,
  turnUse,
  warnings,
} from './ops-lines';

// The two answers are recorded from a local E2E hub (`node tools/worker.mjs dev --e2e`): idle, a
// fresh day. The busy cases below edit their numbers.
const IDLE = idle as unknown as Metrics;
const CLEAN = audit as unknown as AuditReport;

const HOUR = 3_600_000;
/** 16:00 UTC on the recorded day. */
const NOON = Date.parse('2026-11-09T16:00:00Z');

function busy(over: {
  seated?: number;
  queued?: number;
  requests?: number;
  rowsWritten?: number;
  rowsRead?: number;
  why?: Metrics['admission']['why'];
  headroom?: number;
  sessions?: number;
  turn?: boolean;
  relayKb?: number;
  bytes?: number;
  waits?: Metrics['admission']['waits'];
  now?: number;
}): Metrics {
  const sessions = over.sessions ?? 621;
  return {
    ...IDLE,
    now: over.now ?? NOON,
    limits: { ...IDLE.limits, sessions },
    live: { ...IDLE.live, seated: over.seated ?? 0, queued: over.queued ?? 0 },
    today: {
      ...IDLE.today,
      requests: over.requests ?? 0,
      rowsWritten: over.rowsWritten ?? 0,
      rowsRead: over.rowsRead ?? 0,
    },
    month: { ...IDLE.month, relayKb: over.relayKb ?? 0 },
    storage: { ...IDLE.storage, bytes: over.bytes ?? 1_000_000 },
    admission: {
      ...IDLE.admission,
      open: over.why === undefined || over.why === null,
      why: over.why ?? null,
      headroom: over.headroom ?? 700,
      turn: over.turn ?? true,
      waits: over.waits ?? null,
    },
  };
}

const sections = (ws: { section: string }[]) => ws.map((w) => w.section);

describe('the recorded answers', () => {
  it('parse', () => {
    expect(parseMetrics(IDLE).ok).toBe(true);
    expect(parseAudit(CLEAN).ok).toBe(true);
  });

  it('give a status line with the seats, the line, the use, the hours left, the relay and the flags', () => {
    const line = statusLine(IDLE, CLEAN);
    expect(line).toMatch(/^\d\d:\d\d:\d\dZ \| free \| seated 0\/200 \(cap 200, headroom 763\)/);
    expect(line).toContain('queued 0');
    expect(line).toContain('open');
    expect(line).toContain('use req 0% rows-w 0% rows-r 0%');
    expect(line).toContain('left >99 h');
    expect(line).toContain('relay 0%');
    expect(line).toContain('flags none');
  });

  it('are quiet: an idle hub on a clean audit warns of nothing', () => {
    expect(warnings(IDLE, CLEAN)).toEqual([]);
  });
});

describe('the status line', () => {
  it('names the wait, the closed door and STUN-only', () => {
    const m = busy({
      seated: 600,
      queued: 12,
      why: 'full',
      headroom: 600,
      turn: false,
      waits: { n: 40, p50: 42.5, p95: 120 },
    });
    const line = statusLine(m, null);
    expect(line).toContain('seated 600/600 (cap 621, headroom 600)');
    expect(line).toContain('queued 12 wait p50 42.5 s p95 120 s');
    expect(line).toContain('closed (full)');
    expect(line).toContain('(STUN only)');
    expect(line).toContain('flags n/a');
  });

  it('lists the flags raised today by kind', () => {
    const a = { ...CLEAN, day: { ...CLEAN.day, teleport: 2, replay: 1 } };
    expect(statusLine(IDLE, a)).toContain('flags replay 1, teleport 2');
  });
});

describe('the hours left', () => {
  it('is the smallest over the allowances at the rate given, infinite at none', () => {
    expect(
      hoursLeft(
        { requests: 0.5, rowsWritten: 0.9, rowsRead: 1 },
        { requests: 0.1, rowsWritten: 0.1, rowsRead: 0.1 },
      ),
    ).toBeCloseTo(5);
    expect(
      hoursLeft(
        { requests: 0.5, rowsWritten: 0.9, rowsRead: 1 },
        { requests: 0, rowsWritten: 0, rowsRead: 0 },
      ),
    ).toBe(Number.POSITIVE_INFINITY);
    expect(
      hoursLeft(
        { requests: -0.1, rowsWritten: 1, rowsRead: 1 },
        { requests: 0.1, rowsWritten: 0, rowsRead: 0 },
      ),
    ).toBe(0);
  });

  it('takes the rate between two answers of a day, else over the day so far', () => {
    const before = busy({ now: NOON, requests: 10_000 });
    const now = busy({ now: NOON + HOUR, requests: 20_000 });
    // 10% of the requests an hour.
    expect(ratePerHour(now, before).requests).toBeCloseTo(0.1);
    // 16 h into the day with 20% spent.
    expect(ratePerHour(now).requests).toBeCloseTo(0.2 / 17);
    // The guard is at 90%: 70% to go at 10% an hour.
    expect(hoursToGuard(now, before)).toBeCloseTo(7);
  });

  it('ignores a "before" from another day or the same moment', () => {
    const yesterday = {
      ...busy({ now: NOON - 24 * HOUR, requests: 99_000 }),
      today: { ...IDLE.today, day: '2026-11-08', requests: 99_000 },
    } as Metrics;
    const now = busy({ requests: 16_000 });
    expect(ratePerHour(now, yesterday).requests).toBeCloseTo(0.16 / 16);
    expect(ratePerHour(now, now).requests).toBeCloseTo(0.16 / 16);
  });
});

describe('the warnings', () => {
  it('say nothing for a healthy crowd', () => {
    const m = busy({ seated: 200, requests: 20_000, rowsWritten: 5_000, rowsRead: 100_000 });
    expect(warnings(m, CLEAN)).toEqual([]);
  });

  it('warn of a line: admission closed for the seats, and a line while it is open', () => {
    const closed = warnings(busy({ seated: 621, queued: 5, why: 'full' }), CLEAN);
    expect(sections(closed)).toContain('A long line');
    expect(closed[0]?.text).toContain('closed (full) with 5 in line');
    const open = warnings(busy({ seated: 100, queued: 2 }), CLEAN);
    expect(open[0]?.text).toContain('2 in line while admission is open');
  });

  it('warn when the seats left under the headroom are under a tenth of the seats held', () => {
    expect(sections(warnings(busy({ seated: 190, headroom: 200 }), CLEAN))).toContain(
      'A long line',
    );
    expect(warnings(busy({ seated: 190, headroom: 211 }), CLEAN)).toEqual([]);
  });

  it('warn of a long median wait', () => {
    const m = busy({ seated: 100, waits: { n: 10, p50: 300, p95: 900 } });
    expect(warnings(m, CLEAN)[0]?.text).toContain('median wait today is 300 s');
    expect(warnings(busy({ seated: 100, waits: { n: 10, p50: 299, p95: 900 } }), CLEAN)).toEqual(
      [],
    );
  });

  it('warn at 75% of an allowance, and again past the guard, each with its own section', () => {
    const near = warnings(busy({ seated: 50, rowsWritten: 76_000 }), CLEAN);
    expect(near.map((w) => w.section)).toContain("The day's budget is spent");
    expect(near[0]?.text).toContain('76%');
    expect(warnings(busy({ seated: 50, rowsWritten: 74_000 }), CLEAN)).toEqual([]);
    const past = warnings(busy({ seated: 50, requests: 91_000, why: 'budget' }), CLEAN);
    expect(sections(past)).toContain("The free plan's hard limit is reached");
    expect(sections(past)).toContain("The day's budget is spent");
  });

  it('warn when the guard is under a few hours away at the current rate', () => {
    const before = busy({ seated: 100, now: NOON, requests: 10_000 });
    const now = busy({ seated: 100, now: NOON + HOUR, requests: 30_000 });
    // 60% to go at 20% an hour: 3 h, not under.
    expect(warnings(now, CLEAN, before)).toEqual([]);
    const faster = busy({ seated: 100, now: NOON + HOUR, requests: 32_000 });
    const ws = warnings(faster, CLEAN, before);
    expect(ws[0]?.text).toMatch(/guard trips in 2\.6 h/);
    expect(HOURS_LEFT_WARN).toBe(3);
  });

  it('warn of storage at 75% of the plan’s and say so when admission closes for it', () => {
    const near = warnings(busy({ seated: 50, bytes: 760_000_000 }), CLEAN);
    expect(sections(near)).toEqual(['Storage is near its guard']);
    const closed = warnings(busy({ seated: 50, bytes: 910_000_000, why: 'storage' }), CLEAN);
    expect(sections(closed)).toContain('Storage is near its guard');
  });

  it('warn of the TURN guard: relay at 75% of the month’s allowance, and STUN only', () => {
    expect(turnUse(busy({ relayKb: 500_000_000 }))).toBeCloseTo(0.5);
    expect(warnings(busy({ seated: 50, relayKb: 500_000_000 }), CLEAN)).toEqual([]);
    const near = warnings(busy({ seated: 50, relayKb: 800_000_000 }), CLEAN);
    expect(near[0]?.text).toContain('relay is 80%');
    const off = warnings(busy({ seated: 50, relayKb: 900_000_000, turn: false }), CLEAN);
    expect(off[0]?.text).toContain('STUN only');
    expect(off[0]?.section).toBe('The TURN guard');
  });

  it('warn of flags: any of a serious kind, and the noisy kinds only as a spike', () => {
    const m = busy({ seated: 50 });
    const serious = { ...CLEAN, day: { ...CLEAN.day, 'settle-failed': 1 } };
    expect(warnings(m, serious)[0]?.text).toBe('flags today: settle-failed 1');
    const honest = { ...CLEAN, day: { ...CLEAN.day, replay: 9, 'authority-only': 3, conflict: 9 } };
    expect(warnings(m, honest)).toEqual([]);
    const spike = { ...CLEAN, day: { ...CLEAN.day, replay: 10 } };
    expect(sections(warnings(m, spike))).toEqual(['A spike in flags']);
    expect(warnings(m, null)).toEqual([]);
  });
});

describe('a malformed answer', () => {
  it('is an error, never a throw', () => {
    for (const raw of [null, undefined, 3, 'x', [], {}, { now: 1 }]) {
      const m = parseMetrics(raw);
      expect(m.ok).toBe(false);
      const a = parseAudit(raw);
      expect(a.ok).toBe(false);
    }
  });

  it('names the field a metrics answer lacks, or has wrong', () => {
    const noLimits = { ...IDLE, limits: undefined };
    expect(parseMetrics(noLimits)).toEqual({
      ok: false,
      error: 'metrics: limits.requestsPerDay is missing or not a number',
    });
    const text = { ...IDLE, live: { ...IDLE.live, seated: '3' } };
    expect(parseMetrics(text)).toMatchObject({
      ok: false,
      error: expect.stringContaining('live.seated'),
    });
    const open = { ...IDLE, admission: { ...IDLE.admission, open: 'yes' } };
    expect(parseMetrics(open).ok).toBe(false);
    const nan = { ...IDLE, today: { ...IDLE.today, requests: Number.NaN } };
    expect(parseMetrics(nan).ok).toBe(false);
  });

  it('names the kind an audit answer has wrong', () => {
    expect(parseAudit({ ...CLEAN, day: { ...CLEAN.day, teleport: 'many' } })).toEqual({
      ok: false,
      error: 'audit: day.teleport is not a number',
    });
    expect(parseAudit({ ...CLEAN, total: undefined })).toEqual({
      ok: false,
      error: 'audit: total is missing',
    });
  });

  it('prints as one ERROR line with the time', () => {
    expect(errorLine(NOON, 'metrics: not an object')).toBe(
      '16:00:00Z ERROR metrics: not an object',
    );
  });
});

describe('the saved answers', () => {
  it('go under ops/<UTC date>/ by kind and time', () => {
    expect(savePath('ops', 'metrics', Date.parse('2026-11-09T23:59:05Z'))).toBe(
      'ops/2026-11-09/metrics-235905.json',
    );
    expect(savePath('x', 'audit', Date.parse('2026-11-10T00:00:00Z'))).toBe(
      'x/2026-11-10/audit-000000.json',
    );
  });
});

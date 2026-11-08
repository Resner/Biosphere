import { describe, expect, it } from 'vitest';
import {
  agreement,
  figuresOf,
  type HubLoad,
  loadReport,
  problems,
  type Reading,
  rounded,
  spreadOf,
} from './load-hub-report';

const MIN = 60_000;

/** A recorded run of 100 clients: 6 minutes of hold, then everyone leaves. */
const reading = (over: Partial<Reading>): Reading => ({
  byType: {},
  requests: 0,
  rowsWritten: 0,
  rowsRead: 0,
  playerMs: 0,
  clientSent: {},
  cpuMs: 0,
  rssBytes: 100e6,
  ...over,
});

const RUN: HubLoad = {
  config: { clients: 100, joinMin: 2, holdMin: 6, leaveMin: 2, offersPerMinute: 2 },
  start: reading({ cpuMs: 1000 }),
  holdStart: reading({
    byType: { where: 400, ping: 1000, progress: 100, signal: 300 },
    clientSent: { where: 400, ping: 1000, progress: 100, signal: 300 },
    playerMs: 100 * 2 * MIN,
    cpuMs: 5000,
    requests: 90,
  }),
  holdEnd: reading({
    byType: { where: 1600, ping: 1600, progress: 1300, signal: 1500 },
    clientSent: { where: 1600, ping: 1600, progress: 1300, signal: 1500 },
    playerMs: 100 * 8 * MIN,
    cpuMs: 9800,
    requests: 300,
  }),
  end: reading({
    byType: { where: 1650, ping: 1700, progress: 1350, signal: 1560, gone: 100 },
    clientSent: { where: 1650, ping: 1700, progress: 1350, signal: 1560, gone: 100 },
    playerMs: 100 * 10 * MIN,
    rowsWritten: 400,
    rowsRead: 900,
    requests: 320,
  }),
  entered: 100,
  failures: [],
  seated: { count: 100, received: 7000 },
  rssPeakBytes: 160e6,
  dbBytes: { start: 400_000, end: 1_400_000 },
  rtt: { near: spreadOf([2, 3, 4, 5, 6, 7, 8, 9, 10, 40]), signal: spreadOf([4, 8]) },
  offers: { sent: 1200, answered: 1190 },
  closes: {},
  refused: {},
  dropped: {},
  founders: { n: 8, flags: { 'authority-only': 2 } },
  flags: {},
};

describe('the hub load report', () => {
  it('gives each type per player-minute over the hold, by the clients and by the meter', () => {
    const f = figuresOf(RUN);
    // 600 seated player-minutes in the hold; 1,200 where messages of both counts.
    const where = f.messagesPerMinute.find((m) => m.type === 'where');
    expect(where).toEqual({ type: 'where', meter: 2, clients: 2 });
    // 4,200 messages over 600 player-minutes.
    expect(f.totalPerMinute.meter).toBeCloseTo(7);
    // 210 request-equivalents over the same time.
    expect(f.requestsPerMinute).toBeCloseTo(0.35);
  });

  it('prices rows and bytes per player-hour over the whole run, and the CPU per message over the hold', () => {
    const f = figuresOf(RUN);
    // 1,000 player-minutes is 16.67 player-hours.
    expect(f.rowsWrittenPerHour).toBeCloseTo(400 / (1000 / 60));
    expect(f.rowsReadPerHour).toBeCloseTo(900 / (1000 / 60));
    expect(f.storedBytesPerHour).toBeCloseTo(1_000_000 / (1000 / 60));
    // 4,800 ms of CPU for 4,200 messages.
    expect(f.cpuMsPerMessage).toBeCloseTo(4800 / 4200);
    expect(f.rssPeakAboveStartMB).toBeCloseTo(60);
  });

  it('has no figure where nobody was seated, and none from a machine without /proc', () => {
    const f = figuresOf({
      ...RUN,
      holdEnd: RUN.holdStart,
      end: RUN.start,
      rssPeakBytes: null,
      start: reading({ cpuMs: null, rssBytes: null }),
    });
    expect(f.requestsPerMinute).toBeNull();
    expect(f.rowsWrittenPerHour).toBeNull();
    expect(f.cpuMsPerMessage).toBeNull();
    expect(f.rssPeakAboveStartMB).toBeNull();
  });

  it('passes a clean run and names each way a run fails', () => {
    expect(problems(RUN)).toEqual([]);
    expect(problems({ ...RUN, entered: 99 })).toContain('99 of 100 clients entered the water');
    expect(problems({ ...RUN, seated: { count: 98, received: 0 } }).join()).toContain(
      '98 sessions seated',
    );
    expect(problems({ ...RUN, closes: { '4003': 2 } })).toContain(
      '2 sockets closed for their rate',
    );
    expect(problems({ ...RUN, closes: { '1006': 2 } })).toEqual([]);
    expect(problems({ ...RUN, dropped: { where: 3 } })).toContain('3 where messages dropped');
    expect(problems({ ...RUN, flags: { teleport: 1 } }).join()).toContain('teleport 1');
    // The founders may raise `authority-only` and nothing else.
    expect(
      problems({ ...RUN, founders: { n: 8, flags: { 'authority-only': 8, teleport: 1 } } }).join(),
    ).toContain('flags among the founders: teleport 1');
    expect(problems({ ...RUN, failures: ['client 4: no spawn'] })[0]).toContain('client 4');
  });

  it('holds the meter to the clients within 1% (or one message)', () => {
    expect(agreement(1000, 1010)).toBe(true);
    expect(agreement(1000, 989)).toBe(false);
    expect(agreement(5, 4)).toBe(true);
    expect(agreement(5, 3)).toBe(false);
    const off = { ...RUN, end: { ...RUN.end, byType: { ...RUN.end.byType, where: 1000 } } };
    expect(problems(off).join()).toContain('where: the clients sent 1650, the meter counted 1000');
  });

  it('takes percentiles of the round trips', () => {
    expect(spreadOf([])).toEqual({ n: 0, p50: 0, p95: 0, p99: 0 });
    const s = spreadOf(Array.from({ length: 100 }, (_, i) => i + 1));
    expect(s).toEqual({ n: 100, p50: 51, p95: 96, p99: 100 });
  });

  it('writes the figures, the checks and the flags into the markdown', () => {
    const text = loadReport(RUN);
    expect(text).toContain('# Hub load report');
    expect(text).toContain('**The run passes**');
    expect(text).toContain('| where | 2.00 | 2.00 |');
    expect(text).toContain('| **all** | 7.00 | 7.00 |');
    expect(text).toContain('| CPU ms per incoming message | 1.143 |');
    expect(text).toContain('| `where` → `near` | 10 |');
    expect(text).toContain('Audit flags of the 8 founders');
    expect(loadReport({ ...RUN, dropped: { where: 1 } })).toContain('**The run does not pass**');
  });

  it('rounds the stored JSON to a thousandth', () => {
    const r = rounded({
      ...RUN,
      rtt: { ...RUN.rtt, near: { n: 1, p50: 1.23456, p95: 2, p99: 3 } },
    });
    expect(r.rtt.near.p50).toBe(1.235);
  });
});

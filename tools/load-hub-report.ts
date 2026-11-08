// The hub load report (M13 T7, ADR 0067): 500 headless clients against the real Worker under
// `wrangler dev`, what the meter and the process measured, and the checks a run must pass. Pure:
// `tools/load-hub-run.ts` runs the clients and hands its numbers here, `tools/load-hub.mjs` writes
// `docs/perf/hub-load.md` and `hub-load.json`.

import { CLOSE_RATE_LIMITED } from '../src/net/protocol';

export interface Spread {
  n: number;
  p50: number;
  p95: number;
  p99: number;
}

/** The meter and the clients at one moment. */
export interface Reading {
  /** The meter's messages by type (`bad` for an unparsed one). */
  byType: Record<string, number>;
  requests: number;
  rowsWritten: number;
  rowsRead: number;
  /** Seated session-milliseconds. */
  playerMs: number;
  /** What the clients have sent by type. */
  clientSent: Record<string, number>;
  /** Cumulative CPU time of the object's process, ms (null where /proc isn't there). */
  cpuMs: number | null;
  /** Its resident memory, bytes. */
  rssBytes: number | null;
}

export interface HubLoad {
  config: {
    clients: number;
    joinMin: number;
    holdMin: number;
    leaveMin: number;
    offersPerMinute: number;
  };
  /** The meter and clients before the first join, at the hold's start and end, and after the last leave. */
  start: Reading;
  holdStart: Reading;
  holdEnd: Reading;
  end: Reading;
  /** Clients that signed in and entered the water, and those that failed with why. */
  entered: number;
  failures: string[];
  /** Sessions the object held at the hold's end, and the messages they had received. */
  seated: { count: number; received: number };
  /** The greatest resident memory seen during the run, bytes. */
  rssPeakBytes: number | null;
  /** The database on disk at the start and the end, bytes. */
  dbBytes: { start: number; end: number };
  rtt: { near: Spread; signal: Spread };
  offers: { sent: number; answered: number };
  /** Closes the clients did not ask for, by code. */
  closes: Record<string, number>;
  refused: Record<string, number>;
  /** Messages the object dropped, by type. */
  dropped: Record<string, number>;
  /** The first clients, which hatch one by one before the join window and have nobody to audit them, and the flags that raised. */
  founders: { n: number; flags: Record<string, number> };
  /** The audit's flags raised after the founders (the day's counts by kind, those above zero). */
  flags: Record<string, number>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export const spreadOf = (xs: readonly number[]): Spread => {
  if (xs.length === 0) return { n: 0, p50: 0, p95: 0, p99: 0 };
  const sorted = [...xs].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
  return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99) };
};

const delta = (a: Record<string, number>, b: Record<string, number>): Record<string, number> =>
  Object.fromEntries(
    [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .map((k) => [k, (b[k] ?? 0) - (a[k] ?? 0)]),
  );

const sum = (r: Record<string, number>): number => Object.values(r).reduce((x, y) => x + y, 0);

/** What the hold measured: the seated minutes, and both sides' messages by type. */
export function holdOf(l: HubLoad) {
  const minutes = (l.holdEnd.playerMs - l.holdStart.playerMs) / MINUTE_MS;
  const meter = delta(l.holdStart.byType, l.holdEnd.byType);
  const clients = delta(l.holdStart.clientSent, l.holdEnd.clientSent);
  return {
    minutes,
    meter,
    clients,
    requests: l.holdEnd.requests - l.holdStart.requests,
    cpuMs:
      l.holdStart.cpuMs === null || l.holdEnd.cpuMs === null
        ? null
        : l.holdEnd.cpuMs - l.holdStart.cpuMs,
  };
}

/** What the whole run measured, from before the first join to after the last leave. */
export function runOf(l: HubLoad) {
  const hours = (l.end.playerMs - l.start.playerMs) / HOUR_MS;
  return {
    hours,
    meter: delta(l.start.byType, l.end.byType),
    clients: delta(l.start.clientSent, l.end.clientSent),
    rowsWritten: l.end.rowsWritten - l.start.rowsWritten,
    rowsRead: l.end.rowsRead - l.start.rowsRead,
  };
}

/** Per player-minute (or per player-hour), or null with no seated time. */
const per = (n: number, unit: number): number | null => (unit > 0 ? n / unit : null);

export interface Figures {
  /** Messages per player-minute in the hold, by type, as the meter and the clients count them. */
  messagesPerMinute: { type: string; meter: number; clients: number }[];
  totalPerMinute: { meter: number | null; clients: number | null };
  requestsPerMinute: number | null;
  rowsWrittenPerHour: number | null;
  rowsReadPerHour: number | null;
  /** Stored bytes the run added, per player-hour. */
  storedBytesPerHour: number | null;
  cpuMsPerMessage: number | null;
  rssPeakAboveStartMB: number | null;
}

export function figuresOf(l: HubLoad): Figures {
  const hold = holdOf(l);
  const run = runOf(l);
  const types = [...new Set([...Object.keys(hold.meter), ...Object.keys(hold.clients)])].sort();
  const messages = sum(hold.meter);
  return {
    messagesPerMinute: types.map((type) => ({
      type,
      meter: per(hold.meter[type] ?? 0, hold.minutes) ?? 0,
      clients: per(hold.clients[type] ?? 0, hold.minutes) ?? 0,
    })),
    totalPerMinute: {
      meter: per(messages, hold.minutes),
      clients: per(sum(hold.clients), hold.minutes),
    },
    requestsPerMinute: per(hold.requests, hold.minutes),
    rowsWrittenPerHour: per(run.rowsWritten, run.hours),
    rowsReadPerHour: per(run.rowsRead, run.hours),
    storedBytesPerHour: per(l.dbBytes.end - l.dbBytes.start, run.hours),
    cpuMsPerMessage: hold.cpuMs === null || messages <= 0 ? null : hold.cpuMs / messages,
    rssPeakAboveStartMB:
      l.rssPeakBytes === null || l.start.rssBytes === null
        ? null
        : (l.rssPeakBytes - l.start.rssBytes) / 1e6,
  };
}

/**
 * The meter's count of a type may differ from the clients' by messages in flight at a read, and by
 * a `gone` or `leave` that a closing socket never delivered: 1% of the clients' count, or one.
 */
export const agreement = (client: number, meter: number): boolean =>
  Math.abs(client - meter) <= Math.max(1, Math.ceil(client * 0.01));

/** What a run must show; empty when it passes (the acceptance of M13 T7). */
export function problems(l: HubLoad): string[] {
  const out: string[] = [];
  if (l.failures.length > 0) out.push(`${l.failures.length} clients failed: ${l.failures[0]}`);
  if (l.entered !== l.config.clients)
    out.push(`${l.entered} of ${l.config.clients} clients entered the water`);
  if (l.seated.count !== l.config.clients)
    out.push(`${l.seated.count} sessions seated at the end of the hold, not ${l.config.clients}`);
  const limited = l.closes[String(CLOSE_RATE_LIMITED)] ?? 0;
  if (limited > 0) out.push(`${limited} sockets closed for their rate`);
  const where = l.dropped.where ?? 0;
  if (where > 0) out.push(`${where} where messages dropped`);
  // The founders have nobody to audit them, so `authority-only` is theirs to raise; any other flag is not.
  const odd = Object.entries(l.founders.flags).filter(([k]) => k !== 'authority-only');
  if (odd.length > 0)
    out.push(`flags among the founders: ${odd.map(([k, n]) => `${k} ${n}`).join(', ')}`);
  const flags = sum(l.flags);
  if (flags > 0)
    out.push(
      `${flags} audit flags: ${Object.entries(l.flags)
        .map(([k, n]) => `${k} ${n}`)
        .join(', ')}`,
    );
  const run = runOf(l);
  for (const [type, client] of Object.entries(run.clients)) {
    const meter = run.meter[type] ?? 0;
    if (!agreement(client, meter))
      out.push(`${type}: the clients sent ${client}, the meter counted ${meter}`);
  }
  return out;
}

const fixed =
  (digits: number) =>
  (n: number | null): string =>
    n === null ? 'n/a' : n.toFixed(digits);
const f1 = fixed(1);
const f2 = fixed(2);
const f3 = fixed(3);
const int = (n: number | null): string =>
  n === null ? 'n/a' : Math.round(n).toLocaleString('en-US');

const spreadRow = (label: string, s: Spread): string[] => [
  label,
  String(s.n),
  ...[s.p50, s.p95, s.p99].map((v) => `${Math.round(v)} ms`),
];

const table = (head: string[], rows: string[][]): string[] => [
  `| ${head.join(' | ')} |`,
  `|${head.map(() => '---').join('|')}|`,
  ...rows.map((r) => `| ${r.join(' | ')} |`),
];

/** `docs/perf/hub-load.json`: the measurement with every figure rounded to what the report prints. */
export function rounded(l: HubLoad): HubLoad {
  const r = (n: number) => Math.round(n * 1000) / 1000;
  const spread = (s: Spread): Spread => ({ n: s.n, p50: r(s.p50), p95: r(s.p95), p99: r(s.p99) });
  const reading = (x: Reading): Reading => ({ ...x, cpuMs: x.cpuMs === null ? null : r(x.cpuMs) });
  return {
    ...l,
    start: reading(l.start),
    holdStart: reading(l.holdStart),
    holdEnd: reading(l.holdEnd),
    end: reading(l.end),
    rtt: { near: spread(l.rtt.near), signal: spread(l.rtt.signal) },
  };
}

/** `docs/perf/hub-load.md` for the run. */
export function loadReport(l: HubLoad): string {
  const fig = figuresOf(l);
  const hold = holdOf(l);
  const bad = problems(l);
  const c = l.config;
  const out: string[] = [
    '# Hub load report',
    '',
    `Reproduce with \`npm run load:hub\` (${c.joinMin + c.holdMin + c.leaveMin} minutes of play and a minute or two to start and stop; \`--clients 50 --minutes 3\` is the quick mode`,
    'and prints without writing), which writes this file and `hub-load.json`.',
    '',
    `${c.clients} headless clients (\`tests/load-client.ts\`, the page's own \`HubClient\` and \`WhereReporter\`) join over ${c.joinMin} minutes, hold for ${c.holdMin} and leave over ${c.leaveMin}, against the real Worker under \`wrangler dev\` with the recorded drand rounds. Each hatches a recorded genesis, \`spawn\`s, wanders (\`where\`), sends a \`progress\` every 30 s, offers to its \`near\` peers ${c.offersPerMinute} times a minute (each answered by the target client through the hub) and leaves with \`gone\`. They open no WebRTC link. **This is the local runtime's work, not Cloudflare's**: CPU time is workerd on this machine, and the deployed object's clocks stand still while code runs (ADR 0067), so the figures tell the shape; the capacity model (\`docs/CAPACITY.md\`) prices it.`,
    '',
    bad.length === 0
      ? `**The run passes**: every client seated, none closed for its rate, no \`where\` dropped, no audit flag, and the meter's messages equal the clients' sent counts within 1%.`
      : `**The run does not pass**: ${bad.join('; ')}.`,
    '',
    '## Messages per player-minute (the hold)',
    '',
    `Over the hold's ${f1(hold.minutes)} seated player-minutes. The clients' column counts what they sent; the meter's what the object counted.`,
    '',
    ...table(
      ['Message', 'Clients', 'Meter'],
      [
        ...fig.messagesPerMinute.map((m) => [m.type, f2(m.clients), f2(m.meter)]),
        ['**all**', f2(fig.totalPerMinute.clients), f2(fig.totalPerMinute.meter)],
      ],
    ),
    '',
    `Request-equivalents per player-minute (the meter's, 20 messages each): ${f3(fig.requestsPerMinute)}.`,
    '',
    '## Storage and cost',
    '',
    ...table(
      ['Figure', 'Value'],
      [
        ['Rows written per player-hour', f1(fig.rowsWrittenPerHour)],
        ['Rows read per player-hour', f1(fig.rowsReadPerHour)],
        ['Stored bytes per player-hour', int(fig.storedBytesPerHour)],
        ['Database at the start / end', `${int(l.dbBytes.start)} / ${int(l.dbBytes.end)} B`],
        ['CPU ms per incoming message', f3(fig.cpuMsPerMessage)],
        ['Resident memory, peak above the start', `${f1(fig.rssPeakAboveStartMB)} MB`],
      ],
    ),
    '',
    `Every client hatches once in the run (a genesis, its commitments and the audit attestations), and the run lasts ${c.joinMin + c.holdMin + c.leaveMin} minutes of play, so the rows and stored bytes per player-hour carry that one-time cost spread over a short stay: a player who stays for hours writes far fewer per hour. The capacity model (\`docs/CAPACITY.md\`) separates the hatch from the steady play; the figure to read for steady play is the messages above.`,
    '',
    '## Round trips',
    '',
    'A `where` to the `near` that answers it, and an offer to the answer that comes back through the hub (the target client replies as soon as it hears).',
    '',
    ...table(
      ['', 'Samples', 'p50', 'p95', 'p99'],
      [spreadRow('`where` → `near`', l.rtt.near), spreadRow('offer → answer', l.rtt.signal)],
    ),
    '',
    `${l.offers.sent} offers went out and ${l.offers.answered} answers came back.`,
    '',
    '## Closes, drops and flags',
    '',
    ...table(
      ['What', 'Count'],
      [
        ["Sessions seated at the hold's end", `${l.seated.count} of ${c.clients}`],
        ['Messages those sessions had received', int(l.seated.received)],
        ['Closes the clients did not ask for', JSON.stringify(l.closes)],
        ['Refusals', JSON.stringify(l.refused)],
        ['Messages the object dropped, by type', JSON.stringify(l.dropped)],
        [`Audit flags (after the ${l.founders.n} founders)`, JSON.stringify(l.flags)],
        [`Audit flags of the ${l.founders.n} founders`, JSON.stringify(l.founders.flags)],
        ['Clients that failed', String(l.failures.length)],
      ],
    ),
    '',
  ];
  return `${out.join('\n')}\n`;
}

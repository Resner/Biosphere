// The operator's watch (M14 T15): one status line per `/v1/metrics` answer, and a warning line when
// an action of `docs/OPERATIONS.md` applies. Pure: `tools/ops-watch.mjs` fetches and saves. A
// malformed answer is an error line, never a crash.

import { GUARD_SHARE } from '../worker/capacity';

/** The part of `/v1/metrics` (`worker/metrics.ts`) this reads; the Worker's own types stay out of the tools' compile. */
export interface Metrics {
  now: number;
  plan: string;
  limits: {
    requestsPerDay: number;
    rowsWrittenPerDay: number;
    rowsReadPerDay: number;
    storageBytes: number;
    turnGbPerMonth: number;
    sessions: number;
  };
  live: { seated: number; queued: number; away: number };
  today: {
    day: string;
    requests: number;
    rowsWritten: number;
    rowsRead: number;
    playerMs: number;
  };
  month: { relayKb: number };
  storage: { bytes: number; limit: number };
  admission: {
    open: boolean;
    why: 'full' | 'budget' | 'storage' | null;
    turn: boolean;
    headroom: number;
    waits: { n: number; p50: number; p95: number } | null;
  };
}

/** `/v1/audit` (`worker/audit.ts`): flags by kind, for the day and since the world began. */
export interface AuditReport {
  day: Record<string, number>;
  total: Record<string, number>;
}

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The runbook's incident headings (`docs/OPERATIONS.md`, `tools/ops-doc.test.ts` holds them to it). */
export const SECTIONS = {
  line: 'A long line',
  budget: "The day's budget is spent",
  hard: "The free plan's hard limit is reached",
  storage: 'Storage is near its guard',
  turn: 'The TURN guard',
  flags: 'A spike in flags',
} as const;

/** A warning names the runbook section that says what to do. */
export interface Warning {
  /** The incident's heading in `docs/OPERATIONS.md`. */
  section: string;
  text: string;
}

/** Use of an allowance at which the line warns, ahead of the admission guard (`GUARD_SHARE`). */
export const WARN_SHARE = 0.75;
/** Hours left at the current rate under which the line warns. */
export const HOURS_LEFT_WARN = 3;
/** A waiting player's median wait (seconds) over which the line warns of a long line. */
export const LONG_WAIT_S = 300;
/** Seats left under the headroom (a share of the seats held) under which the line warns. */
export const HEADROOM_SLACK = 0.1;
/** Flags of a kind in a day over which an honest-looking kind is a spike. */
export const NOISY_FLAGS = 10;
/** Kinds that honest play raises now and then: they warn only as a spike (`NOISY_FLAGS`). */
export const NOISY_KINDS: readonly string[] = ['authority-only', 'replay', 'conflict'];

type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

const isNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** The first path (`a.b.c`) under `root` that isn't a finite number, or null. */
function missingNumber(root: unknown, paths: readonly string[]): string | null {
  for (const path of paths) {
    let at: unknown = root;
    for (const key of path.split('.')) at = isObject(at) ? at[key] : undefined;
    if (!isNumber(at)) return path;
  }
  return null;
}

/** A `/v1/metrics` answer, or why it can't be read. */
export function parseMetrics(raw: unknown): Parsed<Metrics> {
  if (!isObject(raw)) return { ok: false, error: 'metrics: not an object' };
  const bad = missingNumber(raw, [
    'now',
    'limits.requestsPerDay',
    'limits.rowsWrittenPerDay',
    'limits.rowsReadPerDay',
    'limits.storageBytes',
    'limits.turnGbPerMonth',
    'limits.sessions',
    'live.seated',
    'live.queued',
    'live.away',
    'today.requests',
    'today.rowsWritten',
    'today.rowsRead',
    'today.playerMs',
    'month.relayKb',
    'storage.bytes',
    'storage.limit',
    'admission.headroom',
  ]);
  if (bad) return { ok: false, error: `metrics: ${bad} is missing or not a number` };
  const adm = (raw as { admission?: unknown }).admission;
  if (!isObject(adm) || typeof adm.open !== 'boolean' || typeof adm.turn !== 'boolean')
    return { ok: false, error: 'metrics: admission.open and admission.turn must be booleans' };
  if (typeof raw.plan !== 'string') return { ok: false, error: 'metrics: plan is missing' };
  return { ok: true, value: raw as unknown as Metrics };
}

/** A `/v1/audit` answer, or why it can't be read. */
export function parseAudit(raw: unknown): Parsed<AuditReport> {
  if (!isObject(raw)) return { ok: false, error: 'audit: not an object' };
  for (const part of ['day', 'total']) {
    const counts = raw[part];
    if (!isObject(counts)) return { ok: false, error: `audit: ${part} is missing` };
    for (const [kind, n] of Object.entries(counts))
      if (!isNumber(n)) return { ok: false, error: `audit: ${part}.${kind} is not a number` };
  }
  return { ok: true, value: raw as unknown as AuditReport };
}

/** The UTC day's allowances as shares used, 0 to 1 and over. */
export interface Use {
  requests: number;
  rowsWritten: number;
  rowsRead: number;
}

export function useOf(m: Metrics): Use {
  return {
    requests: m.today.requests / m.limits.requestsPerDay,
    rowsWritten: m.today.rowsWritten / m.limits.rowsWrittenPerDay,
    rowsRead: m.today.rowsRead / m.limits.rowsReadPerDay,
  };
}

/** The most-used allowance's share. */
export const peakUse = (u: Use): number => Math.max(u.requests, u.rowsWritten, u.rowsRead);

/**
 * The hours until an allowance is spent at `perHour`: Infinity while nothing is spent. It
 * is the smallest over the three allowances.
 */
export function hoursLeft(left: Use, perHour: Use): number {
  let hours = Number.POSITIVE_INFINITY;
  for (const k of ['requests', 'rowsWritten', 'rowsRead'] as const) {
    if (perHour[k] > 0) hours = Math.min(hours, left[k] / perHour[k]);
  }
  return Math.max(0, hours);
}

/** The shares of the day's allowances spent per hour: between two answers of one UTC day, else over the day so far. */
export function ratePerHour(now: Metrics, before?: Metrics): Use {
  const same = before && before.today.day === now.today.day && now.now > before.now;
  const hours = same ? (now.now - before.now) / HOUR_MS : (now.now % DAY_MS) / HOUR_MS;
  const from = same ? useOf(before) : { requests: 0, rowsWritten: 0, rowsRead: 0 };
  const to = useOf(now);
  if (hours <= 0) return { requests: 0, rowsWritten: 0, rowsRead: 0 };
  return {
    requests: Math.max(0, to.requests - from.requests) / hours,
    rowsWritten: Math.max(0, to.rowsWritten - from.rowsWritten) / hours,
    rowsRead: Math.max(0, to.rowsRead - from.rowsRead) / hours,
  };
}

/** Hours until the guard at `GUARD_SHARE` of the first allowance trips (the line closes), at the current rate. */
export function hoursToGuard(now: Metrics, before?: Metrics): number {
  const u = useOf(now);
  const left = {
    requests: GUARD_SHARE - u.requests,
    rowsWritten: GUARD_SHARE - u.rowsWritten,
    rowsRead: GUARD_SHARE - u.rowsRead,
  };
  return hoursLeft(left, ratePerHour(now, before));
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;
const clock = (t: number): string => `${new Date(t).toISOString().slice(11, 19)}Z`;
const hoursText = (h: number): string =>
  !Number.isFinite(h)
    ? 'no spend'
    : h > 99
      ? '>99 h'
      : `${h < 10 ? h.toFixed(1) : Math.round(h)} h`;

/** Flags today by kind, only the kinds raised, as `kind n` joined; `none` when clean. */
export function flagsText(a: AuditReport | null): string {
  if (!a) return 'n/a';
  const raised = Object.entries(a.day).filter(([, n]) => n > 0);
  return raised.length === 0 ? 'none' : raised.map(([k, n]) => `${k} ${n}`).join(', ');
}

/** The seats a plan's turn allowance holds, as a share of the month's allowance used by relay. */
export function turnUse(m: Metrics): number {
  return m.month.relayKb / (m.limits.turnGbPerMonth * 1_000_000);
}

/** One status line for an answer (and the audit, when one came in the last 5 minutes). */
export function statusLine(m: Metrics, audit: AuditReport | null, before?: Metrics): string {
  const u = useOf(m);
  const adm = m.admission;
  const door = adm.open ? 'open' : `closed (${adm.why ?? 'full'})`;
  const wait = adm.waits ? ` wait p50 ${adm.waits.p50} s p95 ${adm.waits.p95} s` : '';
  return [
    clock(m.now),
    `${m.plan}`,
    `seated ${m.live.seated}/${Math.min(m.limits.sessions, adm.headroom)} (cap ${m.limits.sessions}, headroom ${adm.headroom})`,
    `queued ${m.live.queued}${wait}`,
    `away ${m.live.away}`,
    door,
    `use req ${pct(u.requests)} rows-w ${pct(u.rowsWritten)} rows-r ${pct(u.rowsRead)}`,
    `left ${hoursText(hoursToGuard(m, before))}`,
    `relay ${pct(turnUse(m))}${adm.turn ? '' : ' (STUN only)'}`,
    `storage ${pct(m.storage.bytes / m.storage.limit)}`,
    `flags ${flagsText(audit)}`,
  ].join(' | ');
}

/** The warnings that apply, each with the section of the runbook that says what to do. */
export function warnings(m: Metrics, audit: AuditReport | null, before?: Metrics): Warning[] {
  const out: Warning[] = [];
  const adm = m.admission;
  const u = useOf(m);
  const peak = peakUse(u);

  if (!adm.open) {
    const why = adm.why ?? 'full';
    const section =
      why === 'budget' ? SECTIONS.budget : why === 'storage' ? SECTIONS.storage : SECTIONS.line;
    out.push({
      section,
      text: `admission is closed (${why}) with ${m.live.queued} in line`,
    });
  } else if (m.live.queued > 0) {
    out.push({ section: SECTIONS.line, text: `${m.live.queued} in line while admission is open` });
  }
  if (adm.waits && adm.waits.p50 >= LONG_WAIT_S)
    out.push({
      section: SECTIONS.line,
      text: `the median wait today is ${adm.waits.p50} s (over ${LONG_WAIT_S} s)`,
    });
  const slack = Math.min(m.limits.sessions, adm.headroom) - (m.live.seated + m.live.away);
  if (adm.open && slack < HEADROOM_SLACK * (m.live.seated + m.live.away))
    out.push({
      section: SECTIONS.line,
      text: `${slack} seats left before the line forms (headroom ${adm.headroom}, cap ${m.limits.sessions})`,
    });
  if (peak >= WARN_SHARE && peak < GUARD_SHARE)
    out.push({
      section: SECTIONS.budget,
      text: `today’s use is ${pct(peak)} of an allowance; the guard closes admission at ${pct(GUARD_SHARE)}`,
    });
  if (peak >= GUARD_SHARE)
    out.push({
      section: SECTIONS.hard,
      text: `today’s use is ${pct(peak)} of an allowance, past the guard at ${pct(GUARD_SHARE)}`,
    });
  const left = hoursToGuard(m, before);
  if (left < HOURS_LEFT_WARN && peak < GUARD_SHARE)
    out.push({
      section: SECTIONS.budget,
      text: `at the current rate the guard trips in ${hoursText(left)}`,
    });
  const stored = m.storage.bytes / m.storage.limit;
  if (stored >= WARN_SHARE)
    out.push({
      section: SECTIONS.storage,
      text: `the database is ${pct(stored)} of its limit; admission closes at ${pct(GUARD_SHARE)}`,
    });
  if (!adm.turn || turnUse(m) >= WARN_SHARE)
    out.push({
      section: SECTIONS.turn,
      text: adm.turn
        ? `relay is ${pct(turnUse(m))} of the month’s TURN allowance`
        : 'new welcomes carry STUN only: the month’s TURN allowance is at its guard',
    });
  if (audit) {
    const kinds = Object.entries(audit.day).filter(([kind, n]) =>
      NOISY_KINDS.includes(kind) ? n >= NOISY_FLAGS : n > 0,
    );
    if (kinds.length > 0)
      out.push({
        section: SECTIONS.flags,
        text: `flags today: ${kinds.map(([k, n]) => `${k} ${n}`).join(', ')}`,
      });
  }
  return out;
}

/** The line an error prints: a failed fetch or a malformed answer. */
export const errorLine = (at: number, what: string): string => `${clock(at)} ERROR ${what}`;

/** The line a warning prints. */
export const warningLine = (at: number, w: Warning): string =>
  `${clock(at)} WARN ${w.text} (docs/OPERATIONS.md, “${w.section}”)`;

/** The saved file's name for an answer: `ops/<UTC date>/<kind>-<HHMMSS>.json`. */
export function savePath(dir: string, kind: 'metrics' | 'audit', at: number): string {
  const iso = new Date(at).toISOString();
  return `${dir}/${iso.slice(0, 10)}/${kind}-${iso.slice(11, 19).replaceAll(':', '')}.json`;
}

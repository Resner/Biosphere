// The full soak's samples, checks and report (M14 T14). Pure: `tools/soak-run.ts` collects the
// series, `checksOf` judges them, and `reportOf` writes `docs/perf/soak.md`. The same inputs give the
// same bytes.

import { ASSUMPTIONS, fightMessages, ratesOf } from '../worker/capacity';
import { MEASURED } from '../worker/plan';
import { LIFECYCLE_ROWS } from './capacity-measure';
import type { Soak } from './soak-run';

/** One look at the authority: its process, its meter and its audit. */
export interface HubSample {
  minute: number;
  /** The workerd processes' summed CPU time and resident memory; null without /proc. */
  cpuMs: number | null;
  rssBytes: number | null;
  /** Messages the object has taken today (the meter's `byType`, summed). */
  messages: number;
  seated: number;
  queued: number;
  /**
   * `/v1/e2e/consistency` violations by kind, with the first of them in words; null at a minute that
   * didn't ask (the check reads every chain, so it runs every `CONSISTENT_EVERY` minutes).
   */
  consistent: { kinds: Record<string, number>; first: string[] } | null;
  /** Today's audit flags above zero. */
  flags: Record<string, number>;
}

/** One look at a page: its heap after a forced collection, the renderer's resources and its frames. */
export interface PageSample {
  page: number;
  minute: number;
  heapBytes: number;
  geometries: number;
  textures: number;
  programs: number;
  /** The 95th percentile of the frame times drawn since the last sample (ms); null with no frames. */
  frameP95Ms: number | null;
}

/** What the page drivers did. */
export interface PageLife {
  page: number;
  hatches: number;
  /** Minutes at which the page reloaded. */
  reloads: number[];
  courts: number;
  errors: string[];
}

/** What only the full run holds. */
export interface FullSeries {
  hub: HubSample[];
  pages: PageSample[];
  pageLives: PageLife[];
  /** The meter's per-player figures at the end. */
  perPlayer: {
    messagesPerMinute: number | null;
    rowsWrittenPerHour: number | null;
  };
  /** The proof bundles of the creatures the pages played. */
  pagesVerified: { checked: number; problems: string[] };
}

/** What each player did in an hour of the run, per the clients' own counts. */
export interface PlayedMix {
  /** Sign-ins: the first of every client and each one after a drop. */
  sessions: number;
  /** Fights, matings and hatches a player was in; promotions and restores. */
  fights: number;
  matings: number;
  hatches: number;
  promotions: number;
}

/** The mix the run played, or null for a run that kept no player-hours. */
export function playedMix(run: Soak): PlayedMix | null {
  const hours = run.playerHours;
  if (!hours || hours <= 0) return null;
  const per = (n: number | undefined) => (n ?? 0) / hours;
  const t = run.totals;
  return {
    sessions: per(run.entered + (t.drops ?? 0)),
    fights: per(t.fights),
    matings: per(t.matings),
    hatches: per(t.hatches),
    promotions: per((t.promotes ?? 0) + (t.restores ?? 0)),
  };
}

/**
 * What the capacity model says a player-hour of that mix costs (M14 T14d): `MEASURED`'s rows for a
 * session, the checkpoints, a fight (a player carries half of one's rows), a mating (half as well),
 * a promotion or restore and a hatch, and its messages for the page and the fights.
 */
export function modelOf(mix: PlayedMix): { rowsPerHour: number; messagesPerMinute: number } {
  const a = ASSUMPTIONS;
  const rows =
    mix.sessions * MEASURED.session.rowsWritten +
    60 / a.checkpointMinutes +
    (mix.fights / 2) * MEASURED.fightRows.written +
    (mix.matings / 2) * LIFECYCLE_ROWS.mating +
    mix.promotions * LIFECYCLE_ROWS.promote +
    mix.hatches * LIFECYCLE_ROWS.hatch;
  const outside =
    MEASURED.world + MEASURED.page.progress + MEASURED.page.ping + MEASURED.page.avail;
  const messages = outside * 60 + (mix.fights / 2) * fightMessages(MEASURED, a);
  return { rowsPerHour: rows, messagesPerMinute: messages / 60 };
}

/** One line for any run: the rows it wrote a player-hour, against the model's for the mix it played. */
export function mixLine(run: Soak): string | null {
  const mix = playedMix(run);
  if (!mix || !run.rows || !run.playerHours) return null;
  const rows = Object.values(run.rows).reduce((n, v) => n + v, 0) / run.playerHours;
  const model = modelOf(mix).rowsPerHour;
  return `rows written per player-hour ${fixed(rows)}, the model's ${fixed(model)} for ${fixed(mix.sessions)} sessions, ${fixed(mix.fights)} fights, ${fixed(mix.matings)} matings, ${fixed(mix.promotions)} promotions and ${fixed(mix.hatches)} hatches a player-hour`;
}

export interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Allowed growth: the authority's resident memory per hour, and every other drift. */
/** The check of `/v1/e2e/consistency` verifies every creature's chain on the hub's thread: every fifth minute, not every one. */
export const CONSISTENT_EVERY = 5;

export const LIMITS = {
  memorySlopeBytesPerHour: 20_000_000,
  cpuPerMessageRatio: 1.5,
  perPlayerRatio: 1.5,
  pageDrift: 0.2,
} as const;

/** The minutes the checks compare, for a run of 60: scaled for a shorter one. */
export const WINDOWS = {
  early: [10, 20],
  late: [50, 60],
  slope: [10, 60],
  heap: [10, 55],
  frame: [5, 55],
} as const;

const scaleOf = (minutes: number): number => minutes / 60;

/** Least-squares slope of `value` over `minute`, per hour; null with fewer than 3 points. */
export function slopePerHour(points: readonly { minute: number; value: number }[]): number | null {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.minute, 0) / n;
  const my = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.minute - mx) * (p.value - my);
    den += (p.minute - mx) ** 2;
  }
  return den === 0 ? null : (num / den) * 60;
}

/** The sample nearest to `minute`. */
function nearest<T extends { minute: number }>(samples: readonly T[], minute: number): T | null {
  let best: T | null = null;
  for (const s of samples) {
    if (best === null || Math.abs(s.minute - minute) < Math.abs(best.minute - minute)) best = s;
  }
  return best;
}

/** CPU milliseconds per incoming message between two minutes; null where the samples can't say. */
export function cpuPerMessage(hub: readonly HubSample[], from: number, to: number): number | null {
  const a = nearest(hub, from);
  const b = nearest(hub, to);
  if (!a || !b || a.cpuMs === null || b.cpuMs === null) return null;
  const messages = b.messages - a.messages;
  return messages > 0 ? (b.cpuMs - a.cpuMs) / messages : null;
}

const fixed = (n: number, digits = 2): string => n.toFixed(digits);

/** The checks of a full run; every one that does not hold says why. */
export function checksOf(run: Soak): Check[] {
  const full = run.full;
  const out: Check[] = [];
  const add = (name: string, ok: boolean, detail: string) => out.push({ name, ok, detail });
  const base = run.entered >= run.config.clients;
  add('every client seated at once', base, `${run.entered} of ${run.config.clients}`);
  const rate = run.closes['4003'] ?? 0;
  add('no socket closed for its rate', rate === 0, `${rate} closed`);
  const where = run.dropped.where ?? 0;
  add('no where dropped', where === 0, `${where} dropped`);
  const flags = Object.entries(run.flags).filter(([k, n]) => k !== 'authority-only' && n > 0);
  add(
    'no audit flag but authority-only',
    flags.length === 0,
    flags.length === 0 ? 'none' : flags.map(([k, n]) => `${k} ${n}`).join(', '),
  );
  if (!full) return out;

  const bad = full.hub.filter(
    (s) => s.consistent !== null && Object.keys(s.consistent.kinds).length > 0,
  );
  add(
    'consistent empty at every sample',
    bad.length === 0 && run.inconsistencies.length === 0,
    bad.length === 0
      ? `${full.hub.length} samples`
      : `minutes ${bad.map((s) => s.minute).join(', ')}`,
  );
  const flagged = full.hub.filter((s) =>
    Object.entries(s.flags).some(([k, n]) => k !== 'authority-only' && n > 0),
  );
  add(
    'no audit flag at any sample',
    flagged.length === 0,
    flagged.length === 0 ? 'none' : `minutes ${flagged.map((s) => s.minute).join(', ')}`,
  );
  const queued = Math.max(0, ...full.hub.map((s) => s.queued));
  add('nobody waited in line', queued === 0, `at most ${queued} queued`);

  const k = scaleOf(run.config.minutes);
  const [s0, s1] = WINDOWS.slope.map((m) => m * k) as [number, number];
  const memory = slopePerHour(
    full.hub
      .filter((s) => s.rssBytes !== null && s.minute >= s0 && s.minute <= s1)
      .map((s) => ({ minute: s.minute, value: s.rssBytes as number })),
  );
  add(
    'authority memory level',
    memory !== null && memory < LIMITS.memorySlopeBytesPerHour,
    memory === null
      ? 'no memory samples'
      : `${fixed(memory / 1e6, 1)} MB an hour (limit ${LIMITS.memorySlopeBytesPerHour / 1e6})`,
  );
  const early = cpuPerMessage(full.hub, WINDOWS.early[0] * k, WINDOWS.early[1] * k);
  const late = cpuPerMessage(full.hub, WINDOWS.late[0] * k, WINDOWS.late[1] * k);
  add(
    'authority CPU per message level',
    early !== null && late !== null && late <= LIMITS.cpuPerMessageRatio * early,
    early === null || late === null
      ? 'no CPU samples'
      : `${fixed(late, 4)} ms against ${fixed(early, 4)} ms (${fixed(late / early)}x, limit ${LIMITS.cpuPerMessageRatio}x)`,
  );

  // The model at the mix the clients played (a run that kept no player-hours: at the model's own).
  const rates = ratesOf(MEASURED);
  const mix = playedMix(run);
  const model = mix
    ? modelOf(mix)
    : { rowsPerHour: rates.rowsWrittenPerHour, messagesPerMinute: rates.messagesPerHour / 60 };
  const played = mix
    ? `the mix played: ${fixed(mix.sessions)} sessions, ${fixed(mix.fights)} fights, ${fixed(mix.matings)} matings and ${fixed(mix.hatches)} hatches a player-hour`
    : '';
  const messagesLimit = LIMITS.perPlayerRatio * model.messagesPerMinute;
  const m = full.perPlayer.messagesPerMinute;
  add(
    'messages per player-minute',
    m !== null && m <= messagesLimit,
    m === null
      ? 'no meter reading'
      : `${fixed(m)} (${mix ? 'model' : 'MEASURED'} ${fixed(model.messagesPerMinute)}, limit ${fixed(messagesLimit)})`,
  );
  const rowsLimit = LIMITS.perPlayerRatio * model.rowsPerHour;
  const r = full.perPlayer.rowsWrittenPerHour;
  add(
    'rows written per player-hour',
    r !== null && r <= rowsLimit,
    r === null
      ? 'no meter reading'
      : `${fixed(r)} (${mix ? 'model' : 'MEASURED'} ${fixed(model.rowsPerHour)}, limit ${fixed(rowsLimit)}${mix ? `; ${played}` : ''})`,
  );

  const pageIds = [...new Set(full.pages.map((p) => p.page))].sort();
  add('pages sampled', pageIds.length >= 2, `${pageIds.length} pages`);
  for (const id of pageIds) {
    const mine = full.pages.filter((p) => p.page === id);
    const heapA = nearest(mine, WINDOWS.heap[0] * k);
    const heapB = nearest(mine, WINDOWS.heap[1] * k);
    const growth = heapA && heapB ? heapB.heapBytes / heapA.heapBytes - 1 : null;
    add(
      `page ${id} heap level`,
      growth !== null && growth <= LIMITS.pageDrift,
      growth === null || !heapA || !heapB
        ? 'no heap samples'
        : `${fixed(heapA.heapBytes / 1e6, 1)} MB at minute ${heapA.minute}, ${fixed(heapB.heapBytes / 1e6, 1)} MB at ${heapB.minute} (${fixed(growth * 100, 1)}%)`,
    );
    const a = nearest(mine, WINDOWS.heap[1] * k);
    const first = nearest(mine, WINDOWS.heap[0] * k);
    const level =
      a && first
        ? a.geometries <= first.geometries &&
          a.textures <= first.textures &&
          a.programs <= first.programs
        : false;
    add(
      `page ${id} renderer resources do not grow`,
      level,
      a && first
        ? `geometries ${first.geometries} → ${a.geometries}, textures ${first.textures} → ${a.textures}, programs ${first.programs} → ${a.programs}`
        : 'no samples',
    );
    const f0 = nearest(
      mine.filter((p) => p.frameP95Ms !== null),
      WINDOWS.frame[0] * k,
    );
    const f1 = nearest(
      mine.filter((p) => p.frameP95Ms !== null),
      WINDOWS.frame[1] * k,
    );
    const ok =
      f0?.frameP95Ms != null &&
      f1?.frameP95Ms != null &&
      f1.frameP95Ms <= (1 + LIMITS.pageDrift) * f0.frameP95Ms;
    add(
      `page ${id} frame time level`,
      ok,
      f0?.frameP95Ms != null && f1?.frameP95Ms != null
        ? `p95 ${fixed(f0.frameP95Ms, 1)} ms at minute ${f0.minute}, ${fixed(f1.frameP95Ms, 1)} ms at ${f1.minute}`
        : 'no frame samples',
    );
  }
  for (const life of full.pageLives) {
    add(
      `page ${life.page} played and reloaded`,
      life.errors.length === 0 && life.hatches > 0 && life.reloads.length > 0,
      `${life.hatches} hatches, reloads at ${life.reloads.join(', ') || 'none'}${life.errors.length > 0 ? `, errors: ${life.errors.slice(0, 3).join('; ')}` : ''}`,
    );
  }
  add(
    'bundles verify',
    run.verified.problems.length === 0 && full.pagesVerified.problems.length === 0,
    `${run.verified.checked} sampled, ${full.pagesVerified.checked} of the pages' creatures${[
      ...run.verified.problems,
      ...full.pagesVerified.problems,
    ]
      .slice(0, 3)
      .map((p) => `; ${p}`)
      .join('')}`,
  );
  return out;
}

const row = (cells: readonly (string | number)[]): string => `| ${cells.join(' | ')} |`;

/** `docs/perf/soak.md`. */
export function reportOf(run: Soak): string {
  const checks = checksOf(run);
  const full = run.full;
  const lines = [
    '# Soak report',
    '',
    'Reproduce with `npm run soak -- --full` (about 70 minutes; `.github/workflows/soak.yml` runs it).',
    '',
    `${run.config.clients} life clients and ${new Set(full?.pages.map((p) => p.page)).size} Chromium pages (low preset) played for ${run.config.minutes} minutes on the free plan's own limits.`,
    '',
    '## Checks',
    '',
    row(['Check', 'Result', 'Detail']),
    row(['---', '---', '---']),
    ...checks.map((c) => row([c.name, c.ok ? 'pass' : '**FAIL**', c.detail])),
    '',
    '## What happened',
    '',
    row(['Count', 'Total']),
    row(['---', '---']),
    ...['matings', 'births', 'fights', 'kills', 'restores', 'drops'].map((k) =>
      row([k, run.totals[k] ?? 0]),
    ),
  ];
  if (run.rows) {
    const total = Object.values(run.rows).reduce((n, v) => n + v, 0);
    lines.push(
      '',
      '## Rows written, by table',
      '',
      row(['Table', 'Rows', 'Share']),
      row(['---', '---', '---']),
      ...Object.entries(run.rows)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([table, n]) => row([table, n, `${fixed((100 * n) / total, 1)}%`])),
    );
  }
  if (full) {
    lines.push(
      '',
      '## Authority, per minute',
      '',
      row(['Minute', 'Resident MB', 'CPU s', 'Messages', 'Seated', 'Queued']),
      row(['---', '---', '---', '---', '---', '---']),
      ...full.hub
        .filter((_, i) => i % 5 === 0 || i === full.hub.length - 1)
        .map((s) =>
          row([
            s.minute,
            s.rssBytes === null ? '-' : fixed(s.rssBytes / 1e6, 1),
            s.cpuMs === null ? '-' : fixed(s.cpuMs / 1000, 1),
            s.messages,
            s.seated,
            s.queued,
          ]),
        ),
      '',
      '## Pages, every five minutes',
      '',
      row(['Page', 'Minute', 'Heap MB', 'Geometries', 'Textures', 'Programs', 'Frame p95 ms']),
      row(['---', '---', '---', '---', '---', '---', '---']),
      ...full.pages
        .filter((p) => Math.round(p.minute) % 5 === 0)
        .map((p) =>
          row([
            p.page,
            p.minute,
            fixed(p.heapBytes / 1e6, 1),
            p.geometries,
            p.textures,
            p.programs,
            p.frameP95Ms === null ? '-' : fixed(p.frameP95Ms, 1),
          ]),
        ),
    );
  }
  lines.push('', `Result: ${checks.every((c) => c.ok) ? 'pass' : 'FAIL'}`, '');
  return lines.join('\n');
}

/** Every failed check and the quick run's own problems, as the lines the tool prints. */
export function failures(run: Soak): string[] {
  return checksOf(run)
    .filter((c) => !c.ok)
    .map((c) => `${c.name}: ${c.detail}`);
}

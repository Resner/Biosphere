// The soak (M14 T13): `npm run soak` starts the E2E Worker under `wrangler dev` with the scales
// shortened, lets headless life clients (`tests/life-client.ts`) hatch, mate, fight, die and drop
// for a while, and checks what the hub holds at the end. The quick mode is `--clients 20 --minutes
// 5`. Node only; every client talks to localhost.

import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyLineage } from '../src/ledger/verify';
import { LifeClient, type LifeStats, SnapBus } from '../tests/life-client';
import { RuntimeWatch } from './load-hub-run';
import { SoakPages } from './soak-pages';
import { CONSISTENT_EVERY, type FullSeries, type HubSample, type PageSample } from './soak-report';

export interface SoakOptions {
  clients: number;
  minutes: number;
  port: number;
  /** Mean play time between a client's drops (ms); 0 never drops. */
  dropEveryMs?: number;
  /** The full soak (M14 T14): the free plan's own limits, two pages, a sample every minute. */
  full?: { site: string; pages: number; joinMinutes: number };
  log?: (line: string) => void;
}

/** The hub's shortened clocks: maturity and cooldown at 5%, the lifespan at 10%. */
export const SCALES = { lifespan: 0.1, mating: 0.05 } as const;
/** The full soak keeps real lifespans, so per-player costs compare with `MEASURED`'s; only maturity and cooldown are short. */
export const FULL_SCALES = { lifespan: 1, mating: 0.05 } as const;
const scalesOf = (opts: SoakOptions) => (opts.full ? FULL_SCALES : SCALES);
/** Clients that hatch together before the rest, and the pause between two joins. */
const JOIN_GAP_MS = 150;
const ORIGIN = 'http://localhost:5173';
/** Creatures whose proof bundle is verified besides the last generation. */
const SAMPLE = 20;
/** The full soak's sample (M14 T14). */
const FULL_SAMPLE = 50;

export interface Soak {
  config: { clients: number; minutes: number };
  /** Clients in the water at the end of the join. */
  entered: number;
  failures: string[];
  /** The clients' counts, summed. */
  totals: Record<string, number>;
  closes: Record<string, number>;
  refused: Record<string, number>;
  deaths: Record<string, number>;
  /** Why creatures that wanted to court could not, by the rules' refusal. */
  notReady: Record<string, number>;
  /** The hub's dropped messages by type, and the day's audit flags. */
  dropped: Record<string, number>;
  flags: Record<string, number>;
  /** `consistent(hub)` at the end: empty when every invariant holds. */
  inconsistencies: unknown[];
  verified: { checked: number; problems: string[] };
  /** The full run's series: the authority and the pages sampled every minute (M14 T14). */
  full?: FullSeries;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The sum of each count over the records; anything but a count is left out. */
const sum = (rs: object[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rs) {
    for (const [k, n] of Object.entries(r)) if (typeof n === 'number') out[k] = (out[k] ?? 0) + n;
  }
  return out;
};

/** What a run must show to pass: every line is a failed check. */
export function problems(run: Soak): string[] {
  const out: string[] = [];
  out.push(...run.failures);
  if (run.entered < run.config.clients) {
    out.push(`only ${run.entered} of ${run.config.clients} clients were seated`);
  }
  const rate = run.closes['4003'] ?? 0;
  if (rate > 0) out.push(`${rate} sockets were closed for their rate`);
  const where = run.dropped.where ?? 0;
  if (where > 0) out.push(`${where} messages of type where were dropped`);
  for (const [kind, n] of Object.entries(run.flags)) {
    if (kind !== 'authority-only' && n > 0) out.push(`${n} audit flags of kind ${kind}`);
  }
  if (run.inconsistencies.length > 0) {
    out.push(`the hub is inconsistent: ${JSON.stringify(run.inconsistencies.slice(0, 5))}`);
  }
  out.push(...run.verified.problems);
  return out;
}

/** Counts every quick run must show above zero. */
export const MUST_HAPPEN = ['matings', 'fights', 'kills', 'restores', 'drops'] as const;

export function missing(run: Soak): string[] {
  return MUST_HAPPEN.filter((k) => (run.totals[k] ?? 0) === 0);
}

function stop(hub: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (hub.pid) process.kill(-hub.pid, signal);
  } catch {
    // already gone
  }
}

async function startHub(opts: SoakOptions, persist: string): Promise<ChildProcess> {
  // The full soak runs on the free plan's own limits: the headroom seats the crowd or the line says so.
  // The E2E Worker's config pins 200 sessions and 100,000 requests; a zero is no override (`limitsOf`).
  const limits = opts.full
    ? { MAX_SESSIONS: 0, DAILY_REQUEST_BUDGET: 0 }
    : { MAX_SESSIONS: Math.max(1000, opts.clients * 2), DAILY_REQUEST_BUDGET: 100_000_000 };
  const vars = {
    ...limits,
    LIFESPAN_SCALE: scalesOf(opts).lifespan,
    MATING_SCALE: scalesOf(opts).mating,
    // Fresh identities have no play and share one address; let them witness, as a populated world would.
    // The recorded rounds last 30 minutes; the full soak plays for an hour.
    ...(opts.full ? { DRAND_ROUNDS: 'soak' } : {}),
    WITNESS_PLAY_MS: 0,
    WITNESS_IP_CHECK: 'off',
  };
  const hub = spawn(
    process.execPath,
    [
      '--no-warnings',
      'tools/worker.mjs',
      'dev',
      '--e2e',
      '--port',
      String(opts.port),
      '--persist-to',
      persist,
      ...Object.entries(vars).flatMap(([k, v]) => ['--var', `${k}:${v}`]),
    ],
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let tail = '';
  const keep = (d: unknown) => {
    tail = (tail + String(d)).slice(-2000);
  };
  hub.stdout?.on('data', keep);
  hub.stderr?.on('data', keep);
  for (let i = 0; i < 240; i++) {
    if (hub.exitCode !== null) throw new Error(`the hub exited: ${tail}`);
    try {
      if ((await fetch(`http://localhost:${opts.port}/v1/health`)).ok) return hub;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  stop(hub, 'SIGKILL');
  throw new Error(`the hub did not come up: ${tail}`);
}

export async function runSoak(opts: SoakOptions): Promise<Soak> {
  // A hub left over from an earlier run would answer in this run's place, with its own day's meter.
  const taken = await fetch(`http://localhost:${opts.port}/v1/health`).then(
    (r) => r.ok,
    () => false,
  );
  if (taken) throw new Error(`port ${opts.port} already answers: stop the old hub first`);
  const persist = await mkdtemp(join(tmpdir(), 'bs-soak-'));
  const hub = await startHub(opts, persist);
  try {
    return await drive(opts, hub.pid ?? 0);
  } finally {
    stop(hub, 'SIGINT');
    await sleep(500);
    stop(hub, 'SIGKILL');
    await rm(persist, { recursive: true, force: true });
  }
}

/**
 * A read of the authority's E2E meter. A busy hour answers slowly, and one slow answer is not the
 * run's end: each read waits up to 30 s and tries three times before it gives up.
 */
async function getJson<T>(port: number, path: string): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(`http://localhost:${port}${path}`, {
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) throw new Error(`${path} ${res.status}`);
      return (await res.json()) as T;
    } catch (e) {
      last = e;
      await sleep(2_000);
    }
  }
  throw new Error(`${path} did not answer: ${String(last)}`);
}

async function drive(opts: SoakOptions, hubPid: number): Promise<Soak> {
  const log = opts.log ?? (() => {});
  const bus = new SnapBus();
  const clients: LifeClient[] = [];
  const failures: string[] = [];
  const starts: Promise<void>[] = [];
  let entered = 0;
  const t0 = Date.now();
  const hubSamples: HubSample[] = [];
  const pageSamples: PageSample[] = [];
  const watch = new RuntimeWatch(hubPid);
  const pages = opts.full
    ? new SoakPages({
        site: opts.full.site,
        hub: `http://localhost:${opts.port}`,
        pages: opts.full.pages,
        minutes: opts.minutes,
        log,
      })
    : null;
  const joinGap = opts.full ? (opts.full.joinMinutes * 60_000) / opts.clients : JOIN_GAP_MS;
  let pagesUp: Promise<void> = Promise.resolve();
  try {
    if (pages) {
      pagesUp = pages.start().catch((e: unknown) => {
        failures.push(`pages: ${e instanceof Error ? e.message : String(e)}`);
      });
    }
    for (let i = 0; i < opts.clients; i++) {
      const client = new LifeClient({
        url: `ws://localhost:${opts.port}/v1/hub`,
        index: i,
        bus,
        scales: scalesOf(opts),
        ...(opts.dropEveryMs !== undefined ? { dropEveryMs: opts.dropEveryMs } : {}),
      });
      clients.push(client);
      starts.push(
        client.start().then(
          () => {
            entered++;
          },
          (e: unknown) => {
            failures.push(`client ${i}: ${e instanceof Error ? e.message : String(e)}`);
          },
        ),
      );
      await sleep(joinGap);
    }
    await Promise.all(starts);
    log(`${entered} of ${opts.clients} in the water`);
    const end = (opts.full ? t0 : Date.now()) + opts.minutes * 60_000;
    let sampled = 0;
    while (Date.now() < end) {
      const next = opts.full ? t0 + (sampled + 1) * 60_000 : Date.now() + 30_000;
      await sleep(Math.max(0, Math.min(next, end) - Date.now()));
      if (opts.full && Date.now() >= t0 + (sampled + 1) * 60_000) {
        sampled++;
        const minute = sampled;
        try {
          hubSamples.push(
            await sampleHub(opts.port, watch, minute, minute % CONSISTENT_EVERY === 0),
          );
        } catch (e) {
          failures.push(`hub sample at minute ${minute}: ${String(e)}`);
        }
        await pagesUp;
        if (pages) {
          try {
            pageSamples.push(...(await pages.sample(minute)));
          } catch (e) {
            failures.push(`page sample at minute ${minute}: ${String(e)}`);
          }
        }
      }
      const t = sum(clients.map((c) => c.stats));
      log(
        `matings ${t.matings ?? 0}, births ${t.births ?? 0}, fights ${t.fights ?? 0}, kills ${t.kills ?? 0}, restores ${t.restores ?? 0}, drops ${t.drops ?? 0}`,
      );
    }
    for (const [i, c] of clients.entries()) {
      for (const e of c.errors.slice(0, 3)) failures.push(`client ${i}: ${e}`);
      if ((c.stats.closes['4003'] ?? 0) > 0) {
        const top = Object.entries(c.stats.sent)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 6)
          .map(([k, n]) => `${k} ${n}`);
        failures.push(`client ${i} was closed for its rate; it sent ${top.join(', ')}`);
      }
    }
    const pageLives = pages ? await pages.stop() : [];
    for (const life of pageLives)
      for (const e of life.errors) failures.push(`page ${life.page}: ${e}`);
    const stats = clients.map((c): LifeStats => c.stats);
    const [dropped, audit, inconsistencies] = await Promise.all([
      getJson<Record<string, number>>(opts.port, '/v1/e2e/dropped'),
      getJson<{ day: Record<string, number> } | null>(opts.port, '/v1/e2e/audit'),
      getJson<unknown[]>(opts.port, '/v1/e2e/consistency'),
    ]);
    const verified = await verifyProofs(
      opts.port,
      clients.map((c) => c.seen),
      opts.full ? FULL_SAMPLE : SAMPLE,
    );
    const pageIds = pages?.creatures() ?? [];
    const full: FullSeries | undefined = opts.full
      ? {
          hub: hubSamples,
          pages: pageSamples,
          pageLives,
          perPlayer: await perPlayerOf(opts.port),
          pagesVerified: await verifyProofs(
            opts.port,
            pageIds.map((id) => [id]),
            pageIds.length,
          ),
        }
      : undefined;
    const totals = sum(stats);
    return {
      config: { clients: opts.clients, minutes: opts.minutes },
      entered,
      failures,
      totals,
      closes: sum(stats.map((s) => s.closes)),
      refused: sum(stats.map((s) => s.refused)),
      deaths: sum(stats.map((s) => s.deaths)),
      notReady: sum(stats.map((s) => s.notReady)),
      dropped,
      flags: Object.fromEntries(Object.entries(audit?.day ?? {}).filter(([, n]) => n > 0)),
      inconsistencies,
      verified,
      ...(full ? { full } : {}),
    };
  } finally {
    await pages?.stop().catch(() => {});
    for (const c of clients) c.stop();
  }
}

interface MetricsAnswer {
  live: { seated: number; queued: number };
  today: {
    byType: Record<string, number>;
    perPlayerMinute: { messages: number } | null;
    perPlayerHour: { rowsWritten: number } | null;
  };
}

/** One look at the authority: its process, its meter and its audit. */
async function sampleHub(
  port: number,
  watch: RuntimeWatch,
  minute: number,
  inconsistent: boolean,
): Promise<HubSample> {
  const [metrics, audit, inconsistencies] = await Promise.all([
    getJson<MetricsAnswer>(port, '/v1/e2e/metrics'),
    getJson<{ day: Record<string, number> } | null>(port, '/v1/e2e/audit'),
    inconsistent
      ? getJson<{ kind: string; detail?: string }[]>(port, '/v1/e2e/consistency')
      : Promise.resolve(null),
  ]);
  const proc = watch.now();
  return {
    minute,
    cpuMs: proc.cpuMs,
    rssBytes: proc.rssBytes,
    messages: Object.values(metrics.today.byType).reduce((n, v) => n + v, 0),
    seated: metrics.live.seated,
    queued: metrics.live.queued,
    consistent: inconsistencies
      ? {
          kinds: Object.fromEntries(
            [...new Set(inconsistencies.map((i) => i.kind))].map((k) => [
              k,
              inconsistencies.filter((i) => i.kind === k).length,
            ]),
          ),
          first: inconsistencies.slice(0, 3).map((i) => `${i.kind}: ${i.detail ?? ''}`),
        }
      : null,
    flags: Object.fromEntries(Object.entries(audit?.day ?? {}).filter(([, n]) => n > 0)),
  };
}

/** The meter's per-player figures at the end of the run. */
async function perPlayerOf(port: number): Promise<FullSeries['perPlayer']> {
  const metrics = await getJson<MetricsAnswer>(port, '/v1/e2e/metrics');
  return {
    messagesPerMinute: metrics.today.perPlayerMinute?.messages ?? null,
    rowsWrittenPerHour: metrics.today.perPlayerHour?.rowsWritten ?? null,
  };
}

/** The proof bundle of a sample of the creatures played, and of the last generation, through the verifier. */
async function verifyProofs(
  port: number,
  lives: readonly (readonly string[])[],
  size: number,
): Promise<Soak['verified']> {
  const all = [...new Set(lives.flat())];
  const lastGeneration = lives.flatMap((l) => l.slice(-1));
  const step = Math.max(1, Math.floor(all.length / size));
  const sample = new Set([
    ...all.filter((_, i) => i % step === 0).slice(0, size),
    ...lastGeneration,
  ]);
  const problems: string[] = [];
  for (const id of sample) {
    const res = await fetch(`http://localhost:${port}/v1/proof/${id}`, {
      headers: { Origin: ORIGIN },
    });
    if (!res.ok) {
      problems.push(`no proof bundle for ${id.slice(0, 8)} (${res.status})`);
      continue;
    }
    const verdict = verifyLineage(await res.json());
    for (const p of verdict.problems) {
      problems.push(`${id.slice(0, 8)}: ${p.family}:${p.code} at ${p.seq}`);
    }
  }
  return { checked: sample.size, problems };
}

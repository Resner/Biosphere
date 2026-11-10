// Runs the hub load (M13 T7): starts the E2E Worker under `wrangler dev`, joins headless clients
// over `joinMin` minutes, holds, lets them leave over `leaveMin`, and reads the meter, the audit and
// the object's process (CPU time and resident memory from /proc) along the way. The numbers go to
// `tools/load-hub-report.ts`. Node only.

import { type ChildProcess, spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchJson } from '../src/net/hub-client';
import { LoadClient, type LoadStats } from '../tests/load-client';
import { type HubLoad, type Reading, spreadOf } from './load-hub-report';

export interface RunOptions {
  clients: number;
  joinMin: number;
  holdMin: number;
  leaveMin: number;
  /** Offers per player-minute (2 until the in-process load simulation lands its own). */
  offersPerMinute: number;
  port: number;
  /** Lines of progress. */
  log?: (line: string) => void;
}

const SAMPLE_MS = 5000;
/** Clients that hatch together before the join window opens. */
const FOUNDERS = 24;
const CLK_TCK = 100;
const PAGE = 4096;

/** The sum of each key over the records. */
const sumRecords = (rs: Record<string, number>[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const r of rs) for (const [k, n] of Object.entries(r)) out[k] = (out[k] ?? 0) + n;
  return out;
};

/** The entries above zero. */
const positive = (r: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(r).filter(([, n]) => n > 0));

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface Proc {
  pid: number;
  ppid: number;
  comm: string;
  cpuMs: number;
  rssBytes: number;
}

/** One process from /proc, or null where it is gone (or /proc isn't there). */
function readProc(pid: number | string): Proc | null {
  try {
    const line = readFileSync(`/proc/${pid}/stat`, 'utf8');
    const open = line.indexOf('(');
    const close = line.lastIndexOf(')');
    const rest = line.slice(close + 2).split(' ');
    return {
      pid: Number(pid),
      ppid: Number(rest[1]),
      comm: line.slice(open + 1, close),
      cpuMs: ((Number(rest[11]) + Number(rest[12])) * 1000) / CLK_TCK,
      rssBytes: Number(rest[21]) * PAGE,
    };
  } catch {
    return null;
  }
}

/** Every process on the machine, from /proc (Linux only; empty elsewhere). */
function processes(): Proc[] {
  let names: string[];
  try {
    names = readdirSync('/proc');
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const p = /^\d+$/.test(name) ? readProc(name) : null;
    return p ? [p] : [];
  });
}

/** The `workerd` processes under `root`: the object's runtime. */
export function workerd(root: number): Proc[] {
  const all = processes();
  const under = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) {
      if (!under.has(p.pid) && under.has(p.ppid)) {
        under.add(p.pid);
        grew = true;
      }
    }
  }
  return all.filter((p) => under.has(p.pid) && p.comm.startsWith('workerd'));
}

/**
 * The object's processes, found once by walking /proc and then read by pid: a scan of every
 * process on the machine blocks the event loop that carries the clients, so it runs again only
 * when a process it knew has gone.
 */
export class RuntimeWatch {
  private pids: number[] = [];
  constructor(private readonly root: number) {}

  /** Summed CPU time (ms) and resident memory (bytes), or nulls without /proc. */
  now(): { cpuMs: number | null; rssBytes: number | null } {
    let procs = this.pids.map(readProc);
    if (this.pids.length === 0 || procs.includes(null)) {
      this.pids = workerd(this.root).map((p) => p.pid);
      procs = this.pids.map(readProc);
    }
    const live = procs.filter((p): p is Proc => p !== null);
    if (live.length === 0) return { cpuMs: null, rssBytes: null };
    return {
      cpuMs: live.reduce((n, p) => n + p.cpuMs, 0),
      rssBytes: live.reduce((n, p) => n + p.rssBytes, 0),
    };
  }
}

async function sizeOf(dir: string): Promise<number> {
  let total = 0;
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) total += await sizeOf(path);
    else total += (await stat(path).catch(() => ({ size: 0 }))).size;
  }
  return total;
}

const getJson = <T>(port: number, path: string): Promise<T> =>
  fetchJson(`http://localhost:${port}${path}`) as Promise<T>;

interface MeterToday {
  requests: number;
  byType: Record<string, number>;
  rowsWritten: number;
  rowsRead: number;
  playerMs: number;
}

/** Signals the hub's whole process group. */
function stop(hub: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (hub.pid) process.kill(-hub.pid, signal);
  } catch {
    // already gone
  }
}

async function startHub(opts: RunOptions, persist: string): Promise<ChildProcess> {
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
      '--var',
      `MAX_SESSIONS:${Math.max(1000, opts.clients * 2)}`,
      '--var',
      'DAILY_REQUEST_BUDGET:100000000',
      // Fresh identities have no play and share one address; let them witness, as a populated world would.
      '--var',
      'WITNESS_PLAY_MS:0',
      '--var',
      'WITNESS_IP_CHECK:off',
    ],
    // Its own process group, so the whole tree (wrangler and its workerd) goes down together.
    { stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  let tail = '';
  hub.stdout?.on('data', (d) => {
    tail = (tail + String(d)).slice(-2000);
  });
  hub.stderr?.on('data', (d) => {
    tail = (tail + String(d)).slice(-2000);
  });
  for (let i = 0; i < 240; i++) {
    if (hub.exitCode !== null) throw new Error(`the hub exited: ${tail}`);
    try {
      const res = await fetch(`http://localhost:${opts.port}/v1/health`);
      if (res.ok) return hub;
    } catch {
      // not up yet
    }
    await sleep(500);
  }
  stop(hub, 'SIGKILL');
  throw new Error(`the hub did not come up: ${tail}`);
}

export async function runHubLoad(opts: RunOptions): Promise<HubLoad> {
  const log = opts.log ?? (() => {});
  const persist = await mkdtemp(join(tmpdir(), 'bs-load-'));
  const hub = await startHub(opts, persist);
  try {
    return await drive(opts, hub, persist, log);
  } finally {
    stop(hub, 'SIGINT');
    await sleep(500);
    stop(hub, 'SIGKILL');
    await rm(persist, { recursive: true, force: true });
  }
}

async function drive(
  opts: RunOptions,
  hub: ChildProcess,
  persist: string,
  log: (line: string) => void,
): Promise<HubLoad> {
  const clients: LoadClient[] = [];
  const failures: string[] = [];
  const runtime = new RuntimeWatch(hub.pid ?? 0);
  /** The greatest resident memory any sample saw. */
  let rssPeak: number | null = null;
  const sample = () => {
    const p = runtime.now();
    if (p.rssBytes !== null) rssPeak = Math.max(rssPeak ?? 0, p.rssBytes);
    return p;
  };

  const sentTotal = () => sumRecords(clients.map((c) => c.stats.sent));
  const read = async (): Promise<Reading> => {
    const m = await getJson<{ today: MeterToday }>(opts.port, '/v1/e2e/metrics');
    const p = sample();
    return {
      byType: m.today.byType,
      requests: m.today.requests,
      rowsWritten: m.today.rowsWritten,
      rowsRead: m.today.rowsRead,
      playerMs: m.today.playerMs,
      clientSent: sentTotal(),
      cpuMs: p.cpuMs,
      rssBytes: p.rssBytes,
    };
  };

  // Resident memory is sampled all along; its peak is the run's.
  const sampler = setInterval(sample, SAMPLE_MS);

  try {
    await sleep(2000);
    const dbStart = await sizeOf(persist);
    const start = await read();
    log(`hub up, ${start.rssBytes === null ? '?' : Math.round(start.rssBytes / 1e6)} MB resident`);

    // The founders hatch together first: the world's first creatures have nobody to audit them,
    // which the audit rightly flags (`authority-only`), so those flags are counted apart.
    const founders = Math.min(FOUNDERS, Math.ceil(opts.clients / 5));
    const join = (i: number): Promise<void> => {
      const client = new LoadClient({
        url: `ws://localhost:${opts.port}/v1/hub`,
        index: i,
        offersPerMinute: opts.offersPerMinute,
      });
      clients.push(client);
      return client.start().catch((e: unknown) => {
        failures.push(`client ${i}: ${e instanceof Error ? e.message : String(e)}`);
      });
    };
    await Promise.all(Array.from({ length: founders }, (_, i) => join(i)));
    const flagsNow = async () =>
      positive(
        (await getJson<{ day: Record<string, number> } | null>(opts.port, '/v1/e2e/audit'))?.day ??
          {},
      );
    const founderFlags = await flagsNow();
    log(`${founders} founders in the water; their flags: ${JSON.stringify(founderFlags)}`);

    // Join.
    const joinMs = opts.joinMin * 60_000;
    const starts: Promise<void>[] = [];
    const t0 = Date.now();
    for (let i = founders; i < opts.clients; i++) {
      const at = t0 + (joinMs * (i - founders)) / (opts.clients - founders);
      await sleep(Math.max(0, at - Date.now()));
      starts.push(join(i));
      if ((i + 1) % 100 === 0) log(`${i + 1} clients joining`);
    }
    await Promise.all(starts);
    const entered = clients.filter((c) => c.inWater).length;
    log(`${entered} of ${opts.clients} in the water`);

    // Hold.
    const holdStart = await read();
    await sleep(opts.holdMin * 60_000);
    const holdEnd = await read();
    const sessions = await getJson<{ received: number }[]>(opts.port, '/v1/e2e/sessions');
    log(`hold over, ${sessions.length} sessions seated`);

    // Leave.
    const leaveMs = opts.leaveMin * 60_000;
    const l0 = Date.now();
    for (let i = 0; i < clients.length; i++) {
      await sleep(Math.max(0, l0 + (leaveMs * i) / clients.length - Date.now()));
      clients[i]?.leave();
    }
    await sleep(5000);
    const [end, dbEnd, dropped, flags] = await Promise.all([
      read(),
      sizeOf(persist),
      getJson<Record<string, number>>(opts.port, '/v1/e2e/dropped'),
      flagsNow(),
    ]);

    const all = clients.map((c): LoadStats => c.stats);
    return {
      config: {
        clients: opts.clients,
        joinMin: opts.joinMin,
        holdMin: opts.holdMin,
        leaveMin: opts.leaveMin,
        offersPerMinute: opts.offersPerMinute,
      },
      start,
      holdStart,
      holdEnd,
      end,
      entered,
      failures,
      seated: { count: sessions.length, received: sessions.reduce((s, x) => s + x.received, 0) },
      rssPeakBytes: rssPeak,
      dbBytes: { start: dbStart, end: dbEnd },
      rtt: {
        near: spreadOf(all.flatMap((s) => s.nearRtt)),
        signal: spreadOf(all.flatMap((s) => s.signalRtt)),
      },
      offers: {
        sent: all.reduce((s, x) => s + x.offers, 0),
        answered: all.reduce((s, x) => s + x.answers, 0),
      },
      closes: sumRecords(all.map((s) => s.closes)),
      refused: sumRecords(all.map((s) => s.refused)),
      dropped,
      founders: { n: founders, flags: founderFlags },
      flags: positive(
        Object.fromEntries(
          Object.keys(flags).map((k) => [k, (flags[k] ?? 0) - (founderFlags[k] ?? 0)]),
        ),
      ),
    };
  } finally {
    clearInterval(sampler);
    for (const c of clients) c.leave();
  }
}

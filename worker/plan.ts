// Cloudflare's limits and prices as checked on 2026-11-08 (ADR 0067): what the authority's meter
// and admission measure themselves against. The deploy reads `vars.CLOUDFLARE_PLAN` into `PLAN`.

import { derive, type Measured, type Tables } from './capacity';

export const CHECKED = '2026-11-08';
export type PlanName = 'free' | 'paid';

export interface PlanLimits {
  /** Durable Object request-equivalents a day (an upgrade is 1, a message 1/20). */
  requestsPerDay: number;
  rowsWrittenPerDay: number;
  rowsReadPerDay: number;
  /** Per object. */
  storageBytes: number;
  turnGbPerMonth: number;
  /** The plan's session cap (M13 T8 sets it from one object's capacity). */
  sessions: number;
}

const FREE_LIMITS = {
  requestsPerDay: 100_000,
  rowsWrittenPerDay: 100_000,
  rowsReadPerDay: 5_000_000,
  storageBytes: 1_000_000_000,
  turnGbPerMonth: 1_000,
};

/** The free plan's other daily limits that the capacity model reads: duration and Worker requests. */
export const FREE_DAILY = { gbSecondsPerDay: 13_000, workerRequestsPerDay: 100_000 } as const;

export const PRICES = {
  base: 5,
  requestsPerM: 0.15,
  gbSecondsPerM: 12.5,
  rowsWrittenPerM: 1,
  rowsReadPerM: 0.001,
  storageGbMonth: 0.2,
  turnGb: 0.05,
  workerRequestsPerM: 0.3,
} as const;

/** What the paid plan includes per month. */
export const INCLUDED = {
  requests: 1e6,
  gbSeconds: 4e5,
  rowsWritten: 5e7,
  rowsRead: 2.5e10,
  storageGbMonth: 5,
  turnGb: 1000,
  workerRequests: 1e7,
} as const;

/** The most the game may cost a month, in dollars (ADR 0067). */
export const CEILING_USD = 9.5;

/**
 * The per-player numbers the capacity model used (M13 T8). `tools/capacity-measure.ts` folds the
 * committed measurements of `docs/perf/` into them, and a test fails when this table drifts from
 * what they give (`npm run report:capacity -- --measured` prints it).
 */
export const MEASURED: Measured = {
  // MEASURED-BEGIN
  world: 7.821,
  page: { where: 2.213, progress: 1.999, ping: 0.9999, signal: 3.999, avail: 0, total: 9.211 },
  fight: { frames: 300, alone: 600, witnessed: 100 },
  session: { rowsWritten: 3.004, rowsRead: 32.82 },
  fightRows: { written: 37, read: 37 },
  cpuMsPerMessage: 0.9861,
  clientKBps: 4.4,
  memoryBytesPerSession: 861,
  bytes: { hour: 2800, hatch: 2600, settled: 1800, logged: 6668 },
  // MEASURED-END
};

export const TABLES: Tables = {
  prices: PRICES,
  included: INCLUDED,
  free: { ...FREE_LIMITS, ...FREE_DAILY },
  paid: { storageBytes: 10_000_000_000 },
  ceilingUsd: CEILING_USD,
};

/** The one derivation of the allowances and caps (`worker/capacity.ts`), which the report calls too. */
export const DERIVED = derive(MEASURED, TABLES);

export const FREE: PlanLimits = { ...FREE_LIMITS, sessions: DERIVED.free.sessions };

/** The paid plan: its daily allowances spend at most $4.50 a month above the base at the measured mix. */
export const PAID: PlanLimits = {
  requestsPerDay: DERIVED.paid.requestsPerDay,
  rowsWrittenPerDay: DERIVED.paid.rowsWrittenPerDay,
  rowsReadPerDay: DERIVED.paid.rowsReadPerDay,
  storageBytes: TABLES.paid.storageBytes,
  turnGbPerMonth: 1_000,
  sessions: DERIVED.paid.sessions,
};

/** The daily allowances a plan spends. */
export const allowances = (plan: PlanName) => {
  const p = plan === 'paid' ? PAID : FREE;
  return {
    requestsPerDay: p.requestsPerDay,
    rowsWrittenPerDay: p.rowsWrittenPerDay,
    rowsReadPerDay: p.rowsReadPerDay,
  };
};

/** The plan's session cap: the smaller of its money cap and 80% of one object's capacity. */
export const sessionCap = (plan: PlanName): number =>
  plan === 'paid' ? PAID.sessions : FREE.sessions;

/** The `vars` this file reads (a subset of the worker's `Env`, so the tools can import it without the Worker's types). */
export interface PlanEnv {
  PLAN?: string;
  MAX_SESSIONS?: string;
  DAILY_REQUEST_BUDGET?: string;
}

/** The plan in force: `PLAN` is `paid`, else the free plan. */
export const planOf = (env: Pick<PlanEnv, 'PLAN'>): PlanName =>
  env.PLAN === 'paid' ? 'paid' : 'free';

/** A positive whole number from a `vars` entry, else undefined. */
function whole(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The plan's limits with the `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` overrides applied. */
export function limitsOf(env: PlanEnv): PlanLimits {
  const base = planOf(env) === 'paid' ? PAID : FREE;
  return {
    ...base,
    sessions: whole(env.MAX_SESSIONS) ?? base.sessions,
    requestsPerDay: whole(env.DAILY_REQUEST_BUDGET) ?? base.requestsPerDay,
  };
}

// Cloudflare's limits and prices as checked on 2026-11-08 (ADR 0067): what the authority's meter
// and admission measure themselves against. The deploy reads `vars.CLOUDFLARE_PLAN` into `PLAN`.

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

export const FREE: PlanLimits = {
  requestsPerDay: 100_000,
  rowsWrittenPerDay: 100_000,
  rowsReadPerDay: 5_000_000,
  storageBytes: 1_000_000_000,
  turnGbPerMonth: 1_000,
  sessions: 200,
};

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

/** Until T8 derives them: the included amounts spread over 30 days, 10 GB, as many sessions as the free plan. */
export const PAID: PlanLimits = {
  requestsPerDay: Math.floor(INCLUDED.requests / 30),
  rowsWrittenPerDay: Math.floor(INCLUDED.rowsWritten / 30),
  rowsReadPerDay: Math.floor(INCLUDED.rowsRead / 30),
  storageBytes: 10_000_000_000,
  turnGbPerMonth: 1_000,
  sessions: 200,
};

/** The most the game may cost a month, in dollars (ADR 0067). */
export const CEILING_USD = 9.5;

/** The plan in force: `PLAN` is `paid`, else the free plan. */
export const planOf = (env: Pick<Env, 'PLAN'>): PlanName => (env.PLAN === 'paid' ? 'paid' : 'free');

/** A positive whole number from a `vars` entry, else undefined. */
function whole(value: string | undefined): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The plan's limits with the `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` overrides applied. */
export function limitsOf(
  env: Pick<Env, 'PLAN' | 'MAX_SESSIONS' | 'DAILY_REQUEST_BUDGET'>,
): PlanLimits {
  const base = planOf(env) === 'paid' ? PAID : FREE;
  return {
    ...base,
    sessions: whole(env.MAX_SESSIONS) ?? base.sessions,
    requestsPerDay: whole(env.DAILY_REQUEST_BUDGET) ?? base.requestsPerDay,
  };
}

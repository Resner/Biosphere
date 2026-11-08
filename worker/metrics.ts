import type { QueueWhy } from '../src/net/protocol';
import { CHECKED, limitsOf, type PlanLimits, type PlanName, planOf } from './plan';
import { admissionWhy, awaySeats, ETA_S_PER_PLACE, queued, seatedCount } from './sessions';
import type { Hub } from './socket';
import type { UsageDay } from './usage';

// `GET /v1/metrics` (M13 T1, ADR 0067): what the authority spends today and this month, the plan's
// limits and the admission state. It names no player.

export interface Metrics {
  now: number;
  plan: PlanName;
  /** When the plan's limits were last checked against Cloudflare's. */
  checked: string;
  /** In force, overrides applied. */
  limits: PlanLimits;
  live: {
    seated: number;
    queued: number;
    away: number;
    fights: number;
    witnessed: number;
    members: number;
    crowds: number;
    instances: number;
  };
  today: UsageDay & {
    /** Null with no seated time. */
    perPlayerMinute: { messages: number; requests: number } | null;
    perPlayerHour: { rowsWritten: number; rowsRead: number } | null;
  };
  /** The UTC month so far, today included. */
  month: { requests: number; rowsWritten: number; rowsRead: number; relayKb: number };
  /** The 31 days before today that have rows, newest first. */
  days: UsageDay[];
  storage: { bytes: number; limit: number };
  admission: {
    open: boolean;
    why: QueueWhy | null;
    turn: boolean;
    seatEveryS: number;
    waits: { n: number; p50: number; p95: number } | null;
  };
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

/** Today's counts as the meter holds them now. */
export function metricsOf(hub: Hub, now: number): Metrics {
  const limits = limitsOf(hub.env);
  const today = hub.usage.today(now);
  const before = hub.usage.monthBefore(now);
  const seated = seatedCount(hub);
  const crowds = hub.crowds.view();
  const running = hub.fights.running();
  const minutes = today.playerMs / MINUTE_MS;
  const hours = today.playerMs / HOUR_MS;
  const why = admissionWhy(hub, now);
  const bytes = hub.usage.databaseBytes(now);
  return {
    now,
    plan: planOf(hub.env),
    checked: CHECKED,
    limits,
    live: {
      seated,
      queued: queued(hub).length,
      away: awaySeats(hub),
      fights: running.length,
      witnessed: running.filter((lock) => lock.fight?.witness != null).length,
      members: hub.directory.leaves().reduce((n, leaf) => n + leaf.members, 0),
      crowds: crowds.length,
      instances: crowds.reduce((n, crowd) => n + crowd.instances.length, 0),
    },
    today: {
      ...today,
      perPlayerMinute:
        minutes > 0
          ? { messages: today.messages / minutes, requests: today.requests / minutes }
          : null,
      perPlayerHour:
        hours > 0
          ? { rowsWritten: today.rowsWritten / hours, rowsRead: today.rowsRead / hours }
          : null,
    },
    month: {
      requests: before.requests + today.requests,
      rowsWritten: before.rowsWritten + today.rowsWritten,
      rowsRead: before.rowsRead + today.rowsRead,
      relayKb: before.relayKb + today.relay.kb,
    },
    days: hub.usage.history(now),
    storage: { bytes, limit: limits.storageBytes },
    // T9 fills in the wait and the TURN guard for real.
    admission: {
      open: why === null,
      why,
      turn: true,
      seatEveryS: ETA_S_PER_PLACE,
      waits: null,
    },
  };
}

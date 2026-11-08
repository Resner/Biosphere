// Admission by plan (M13 T9, ADR 0067): why a newcomer waits, how long the wait measures, which
// players get their seat back, and when new welcomes stop carrying TURN. What it keeps lives in
// memory (`Admission`), so a wake forgets it: the wait falls back to 30 s a place, and a player
// whose seat closed before the wake waits as anyone does.

import type { IceServer, QueueWhy } from '../src/net/protocol';
import { limitsOf } from './plan';
import type { Hub } from './socket';
import { STUN_SERVERS } from './turn';
import { DAY_MS, dayStartOf } from './usage';

/** A guard holds at this share of its limit, so the line forms before any limit is reached. */
export const GUARD_SHARE = 0.9;
/** The wait a place counts before two seats have freed. */
export const DEFAULT_SEAT_EVERY_S = 30;
/** The seats freed that the interval is measured over. */
const FREED_KEPT = 20;
/** A player whose seat closed this recently is seated again past any guard (a reload, a lost connection). */
export const SEAT_BACK_MS = 120_000;
/** The waits kept for `/v1/metrics`. */
const WAITS_KEPT = 200;
/** A waiting session hears its estimate again once it moves by more than this share. */
const ETA_MOVE = 0.2;
/** Cloudflare bills TURN in decimal units: a GB is 1,000,000 KB. */
const KB_PER_GB = 1_000_000;

/** The line's memory: when seats freed, whose seat closed lately, and the waits measured. */
export class Admission {
  /** The times the last seats freed, oldest first. */
  private readonly freed: number[] = [];
  /** Each player whose seat closed within `SEAT_BACK_MS`, with when, oldest first. */
  private readonly closed = new Map<string, number>();
  /** The last waits of sessions seated from the line: when, and how long. */
  private readonly waits: { at: number; ms: number }[] = [];

  /** A seat freed at `now` (a seated session left, or an away fighter's fight ended). */
  seatFreed(now: number): void {
    this.freed.push(now);
    if (this.freed.length > FREED_KEPT) this.freed.shift();
  }

  /** A seated player's socket closed at `now`: a sign-in within `SEAT_BACK_MS` takes the seat back. */
  seatClosed(player: string, now: number): void {
    this.closed.delete(player);
    this.closed.set(player, now);
    for (const [p, at] of this.closed) {
      if (now - at <= SEAT_BACK_MS) break;
      this.closed.delete(p);
    }
  }

  /** Whether the player's seat closed within `SEAT_BACK_MS`: true takes it (once). */
  seatBack(player: string, now: number): boolean {
    const at = this.closed.get(player);
    if (at === undefined) return false;
    this.closed.delete(player);
    return now - at <= SEAT_BACK_MS;
  }

  /** A session was seated from the line after `ms`. */
  waited(now: number, ms: number): void {
    this.waits.push({ at: now, ms: Math.max(0, ms) });
    if (this.waits.length > WAITS_KEPT) this.waits.shift();
  }

  /**
   * The mean interval between the last seats that freed, in ms (30 s before two have). A gap open
   * longer than that mean counts as one more interval: a line where nobody leaves waits longer.
   */
  seatEveryMs(now: number): number {
    const n = this.freed.length;
    if (n < 2) return DEFAULT_SEAT_EVERY_S * 1000;
    const first = this.freed[0] as number;
    const last = this.freed[n - 1] as number;
    const mean = (last - first) / (n - 1);
    const open = now - last;
    return open > mean ? (last - first + open) / n : mean;
  }

  /** The ms until the next seat is likely to free: `every` (`seatEveryMs`) less the time since the last one freed. */
  nextSeatMs(now: number, every: number): number {
    const last = this.freed[this.freed.length - 1];
    if (this.freed.length < 2 || last === undefined) return every;
    const open = now - last;
    return open < every ? every - open : every;
  }

  /** The waits measured today (UTC) in seconds: their count, median and 95th percentile, or null. */
  waitsToday(now: number): { n: number; p50: number; p95: number } | null {
    const since = dayStartOf(now);
    const today = this.waits
      .filter((w) => w.at >= since)
      .map((w) => w.ms)
      .sort((a, b) => a - b);
    if (today.length === 0) return null;
    const at = (q: number) => tenths((today[Math.ceil(q * today.length) - 1] as number) / 1000);
    return { n: today.length, p50: at(0.5), p95: at(0.95) };
  }
}

const tenths = (x: number): number => Math.round(x * 10) / 10;

/**
 * Why one more session doesn't fit, by the first guard that holds, or null while the line is
 * open: `storage` (the database at 90% of the plan's), `budget` (the day's request-equivalents,
 * rows written or rows read at 90% of their allowances), `full` (seated sessions and away fighters
 * at the session cap). `MAX_SESSIONS` and `DAILY_REQUEST_BUDGET` override the plan's (`limitsOf`).
 */
export function admission(hub: Hub, now: number): QueueWhy | null {
  const limits = limitsOf(hub.env);
  if (hub.usage.storedBytes() >= GUARD_SHARE * limits.storageBytes) return 'storage';
  const rows = hub.usage.rowsToday(now);
  if (
    hub.usage.requests(now) >= GUARD_SHARE * limits.requestsPerDay ||
    rows.written >= GUARD_SHARE * limits.rowsWrittenPerDay ||
    rows.read >= GUARD_SHARE * limits.rowsReadPerDay
  )
    return 'budget';
  if (hub.seats.size + awaySeats(hub) >= limits.sessions) return 'full';
  return null;
}

/**
 * The seats held world-wide for fighters whose player is away (ADR 0053): every participant of a
 * running fight with no seated socket keeps its place until the fight ends.
 */
export function awaySeats(hub: Hub): number {
  let away = 0;
  for (const { players, fight } of hub.fights.running()) {
    if (fight) away += players.filter((p) => !hub.seats.has(p)).length;
  }
  return away;
}

/**
 * The estimated wait in whole seconds of the session at `place` (1 = next): for `full` the time to
 * the next seat plus the interval for each one ahead; for `budget` the time to the next 00:00 UTC
 * plus the interval for each one ahead; for `storage` none (0).
 */
export function etaS(hub: Hub, why: QueueWhy, place: number, now: number): number {
  if (why === 'storage') return 0;
  const every = hub.admission.seatEveryMs(now);
  const ahead = (place - 1) * every;
  const first =
    why === 'budget' ? dayStartOf(now) + DAY_MS - now : hub.admission.nextSeatMs(now, every);
  return Math.max(0, Math.round((first + ahead) / 1000));
}

/** Whether a waiting session that last heard `was` should hear `eta` (more than 20% away). */
export const etaMoved = (was: number | undefined, eta: number): boolean =>
  was === undefined || Math.abs(eta - was) > ETA_MOVE * was;

/**
 * The TURN guard: false once the month's clamped relay KB, plus yesterday's again (the day of
 * margin for credentials already handed out, which last a day), reach 90% of the plan's TURN
 * allowance. New welcomes then carry STUN only.
 */
export function turnOpen(hub: Hub, now: number): boolean {
  const limit = GUARD_SHARE * limitsOf(hub.env).turnGbPerMonth * KB_PER_GB;
  return hub.usage.turnKb(now) < limit;
}

/** The ICE servers for a welcome: STUN only once the TURN guard holds, else STUN plus TURN when it can be had. */
export function iceFor(hub: Hub, now: number): Promise<{ ice: IceServer[]; turn: boolean }> {
  if (!turnOpen(hub, now)) return Promise.resolve({ ice: STUN_SERVERS, turn: false });
  return hub.turn.ice(hub.env);
}

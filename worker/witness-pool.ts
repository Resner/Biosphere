// Who may witness an event (ADR 0058), and the event's witness commitment. Eligibility is read from
// the hub's witness candidates (`seats.ts`: the seat, `avail`, the IP hash, the saved play and the
// strike, M13 T2) and each candidate's own attachment (the duties of the last hour, the credit
// since its last record), with no SQLite row; nothing here writes but the commitment, or the
// `authority-only` flag when nobody can witness.

import { type Canonical, hashWithDomain } from '../src/ledger/canonical';
import {
  type DutyKind,
  dutyEvent,
  poolOf,
  type WitnessData,
  witnessRound,
} from '../src/ledger/witness';
import type { ClientMsg } from '../src/net/protocol';
import type { SignedCommitment } from './beacons';
import type { PlayLoader } from './seats';
import { type ActiveSession, type Hub, keep, seated } from './socket';

/** The play (Σ of an identity's creatures' active time) needed to witness: 20 minutes. */
export const WITNESS_PLAY_MS = 1_200_000;
/** At most this many duties accepted in any hour. */
export const DUTIES_PER_HOUR = 20;
const HOUR_MS = 3_600_000;
/** A failed or overruled duty bars its player from witnessing for a day. */
export const STRIKE_MS = 86_400_000;

type FixtureEnv = { DRAND_SOURCE?: string; WITNESS_PLAY_MS?: string; WITNESS_IP_CHECK?: string };

/** The play needed, set by `WITNESS_PLAY_MS` (whole ms, 0 or more) in fixture mode only, for E2E. */
export function witnessPlayMs(env: FixtureEnv): number {
  const ms = env.DRAND_SOURCE === 'fixture' ? Number(env.WITNESS_PLAY_MS) : Number.NaN;
  return Number.isInteger(ms) && ms >= 0 && ms <= WITNESS_PLAY_MS ? ms : WITNESS_PLAY_MS;
}

/** Whether witnesses must differ from every participant's IP hash: always, but in fixture mode with `WITNESS_IP_CHECK=off`. */
export function ipCheck(env: FixtureEnv): boolean {
  return !(env.DRAND_SOURCE === 'fixture' && env.WITNESS_IP_CHECK === 'off');
}

/** A socket's address as its attachment keeps it: SHA-256 of the object's salt and the IP. */
export function ipHash(salt: string, ip: string): string {
  return hashWithDomain('bs/ip/v1', `${salt}|${ip}`);
}

/** The duties a session accepted in the hour before `now`. */
export const dutiesInHour = (session: ActiveSession, now: number): number[] =>
  (session.duties ?? []).filter((t) => t > now - HOUR_MS);

/** The player's play: its creatures' active time as their rows hold it, plus what its seated session credited since. */
export function playedMs(hub: Hub, player: string): number {
  const session = seated(hub, player)?.[1];
  return (savedPlay(hub, [player]).get(player) ?? 0) + creditOf(session);
}

/** What the session's life credited since its last record. */
const creditOf = (session: ActiveSession | undefined): number =>
  session?.life ? Math.max(0, session.life.activeMs - session.life.savedMs) : 0;

/** Each player's creatures' active time as their rows hold it, in one query. */
function savedPlay(hub: Pick<Hub, 'sql'>, players: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (players.length === 0) return out;
  const cursor = hub.sql.exec<{ owner: string; ms: number }>(
    `SELECT owner, SUM(active_ms) AS ms FROM creatures
     WHERE owner IN (SELECT value FROM json_each(?)) GROUP BY owner`,
    JSON.stringify(players),
  );
  for (const row of cursor) out.set(row.owner, row.ms);
  return out;
}

/** The players struck at `now`, of `players`, as SQLite holds them (the E2E witness view). */
export function struck(hub: Hub, players: readonly string[], now: number): Set<string> {
  if (players.length === 0) return new Set();
  const rows = hub.sql
    .exec<{ id: string }>(
      'SELECT id FROM players WHERE struck_until > ? AND id IN (SELECT value FROM json_each(?))',
      now,
      JSON.stringify(players),
    )
    .toArray();
  return new Set(rows.map((r) => r.id));
}

/** Each player's saved play and strike as SQLite holds them, in two queries: what a seat starts its candidacy from. */
export const playOf =
  (hub: Pick<Hub, 'sql'>): PlayLoader =>
  (players) => {
    const out = new Map<string, { savedMs: number; struckUntil: number }>();
    if (players.length === 0) return out;
    for (const id of players) out.set(id, { savedMs: 0, struckUntil: 0 });
    for (const [id, ms] of savedPlay(hub, players)) {
      const held = out.get(id);
      if (held) held.savedMs = ms;
    }
    const struck = hub.sql.exec<{ id: string; until: number }>(
      'SELECT id, struck_until AS until FROM players WHERE id IN (SELECT value FROM json_each(?))',
      JSON.stringify(players),
    );
    for (const row of struck) {
      const held = out.get(row.id);
      if (held) held.struckUntil = row.until;
    }
    return out;
  };

/**
 * Every player who may witness an event whose participants are `exclude`, at `now`, sorted: seated
 * with `avail` on, not locked in a fight, holding no duty and under the hourly limit, with an IP
 * hash no participant's session shares, `WITNESS_PLAY_MS` of play and no strike. `among` limits
 * the answer to those players (an offer checks its one). It reads the hub's candidates and each
 * candidate's attachment only: no SQLite row (M13 T2).
 */
export function eligible(
  hub: Hub,
  exclude: readonly string[],
  now: number,
  among?: readonly string[],
): string[] {
  const out = new Set(exclude);
  const banned = new Set<string>();
  if (ipCheck(hub.env)) {
    for (const p of out) {
      const ip = hub.seats.candidate(p)?.ip;
      if (ip !== undefined) banned.add(ip);
    }
  }
  const need = witnessPlayMs(hub.env);
  const ids: string[] = [];
  for (const id of new Set(among ?? hub.seats.available())) {
    const c = hub.seats.candidate(id);
    if (!c?.avail || out.has(id) || c.struckUntil > now) continue;
    if (c.ip !== undefined && banned.has(c.ip)) continue;
    if (hub.fights.playerLocked(id) || hub.duties.holding(id)) continue;
    // Its own seated session: the hour's duties, and its credit since its last record.
    const s = seated(hub, id)?.[1];
    if (!s || dutiesInHour(s, now).length >= DUTIES_PER_HOUR) continue;
    if (c.savedMs + creditOf(s) >= need) ids.push(id);
  }
  return ids.sort();
}

/**
 * The event's witness commitment (ADR 0058): its pool of the eligible, `participants` left out, and
 * the round `round` names (an encounter's `witnessRound` by default; a mating's or a genesis's
 * own). One event has one commitment: asking again returns it. An empty pool, or a commitment
 * that fails (a round already due), writes none and flags the event `authority-only` once; null then.
 */
export async function commitWitnesses(
  hub: Hub,
  kind: DutyKind,
  id: string,
  participants: readonly string[],
  round?: number,
): Promise<SignedCommitment | null> {
  // A failure here never blocks the event it belongs to: it stays authority-only.
  try {
    return await commitPool(hub, kind, id, participants, round);
  } catch (error) {
    console.error('witness commitment failed', error);
    try {
      noWitness(hub, dutyEvent(kind, id), participants);
    } catch (flagError) {
      console.error('witness commitment: the failure is not flagged', flagError);
    }
    return null;
  }
}

/** The event has no witness commitment: it is flagged `authority-only`, once however often this runs. */
function noWitness(hub: Hub, event: string, participants: readonly string[]): void {
  hub.ledger.audit.raise('authority-only', {
    owner: participants[0] ?? '',
    creature: '',
    key: event,
    t: hub.clock.now(),
  });
}

async function commitPool(
  hub: Hub,
  kind: DutyKind,
  id: string,
  participants: readonly string[],
  round?: number,
): Promise<SignedCommitment | null> {
  const event = dutyEvent(kind, id);
  const key = { event };
  const known = hub.beacons.find('witness', '', key);
  if (known) return known;
  const now = hub.clock.now();
  const pool = poolOf(eligible(hub, participants, now), event);
  if (pool.length === 0) {
    noWitness(hub, event, participants);
    return null;
  }
  const data: WitnessData = { event, pool };
  const commit = await hub.beacons.commit('witness', '', data as unknown as Canonical, {
    round: round === undefined ? witnessRound : () => round,
    key,
  });
  hub.duties.committed(event, commit, participants);
  return commit;
}

/** At most one `avail` counts in this long; the others are dropped. */
export const AVAIL_EVERY_MS = 5000;

/**
 * A client's `avail`: whether it can witness now (ADR 0058). An `on` counts at most once every
 * `AVAIL_EVERY_MS` after the last that counted; an `off` always does, since it only takes the
 * player out (a client that just turned on and then starts fighting is never left offered).
 */
export function avail(
  hub: Hub,
  ws: WebSocket,
  session: ActiveSession,
  msg: ClientMsg & { t: 'avail' },
): void {
  const now = hub.clock.now();
  const recent = session.availAt !== undefined && now - session.availAt < AVAIL_EVERY_MS;
  if (msg.on && recent) return;
  keep(hub, ws, { ...session, avail: msg.on, availAt: now });
}

// Who may witness an event (ADR 0058), and the event's witness commitment. Eligibility is read from
// the sockets' attachments (the seat, `avail`, the IP hash, the duties of the last hour), the
// creatures' play and the players' strikes; nothing here writes but the commitment, or the
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
import { type ActiveSession, activeSessions, type Hub, type Session } from './socket';

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
  return playedOf(hub, [player]).get(player) ?? 0;
}

/** `playedMs` of each player, in one query. */
function playedOf(hub: Hub, players: readonly string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (players.length === 0) return out;
  const cursor = hub.ctx.storage.sql.exec<{ owner: string; ms: number }>(
    `SELECT owner, SUM(active_ms) AS ms FROM creatures
     WHERE owner IN (SELECT value FROM json_each(?)) GROUP BY owner`,
    JSON.stringify(players),
  );
  for (const row of cursor) out.set(row.owner, row.ms);
  const wanted = new Set(players);
  for (const [, s] of activeSessions(hub)) {
    if (!wanted.has(s.playerId) || !s.life) continue;
    const credit = Math.max(0, s.life.activeMs - s.life.savedMs);
    out.set(s.playerId, (out.get(s.playerId) ?? 0) + credit);
  }
  return out;
}

/** The players struck at `now`, of `players`. */
export function struck(hub: Hub, players: readonly string[], now: number): Set<string> {
  if (players.length === 0) return new Set();
  const rows = hub.ctx.storage.sql
    .exec<{ id: string }>(
      'SELECT id FROM players WHERE struck_until > ? AND id IN (SELECT value FROM json_each(?))',
      now,
      JSON.stringify(players),
    )
    .toArray();
  return new Set(rows.map((r) => r.id));
}

/**
 * Every player who may witness an event whose participants are `exclude`, at `now`, sorted: seated
 * with `avail` on, not locked in a fight, holding no duty and under the hourly limit, with an IP
 * hash no participant's session shares, `WITNESS_PLAY_MS` of play and no strike. `among` limits
 * the answer to those players (an offer checks its one).
 */
export function eligible(
  hub: Hub,
  exclude: readonly string[],
  now: number,
  among?: readonly string[],
): string[] {
  const out = new Set(exclude);
  const only = among ? new Set(among) : null;
  const sessions: ActiveSession[] = [];
  for (const [, s] of activeSessions(hub)) sessions.push(s);
  const banned = new Set<string>();
  if (ipCheck(hub.env)) {
    for (const s of sessions) if (out.has(s.playerId) && s.ip !== undefined) banned.add(s.ip);
  }
  const candidates = new Set<string>();
  for (const s of sessions) {
    if (out.has(s.playerId) || s.avail !== true || (only && !only.has(s.playerId))) continue;
    if (s.ip !== undefined && banned.has(s.ip)) continue;
    if (hub.fights.playerLocked(s.playerId) || hub.duties.holding(s.playerId)) continue;
    if (dutiesInHour(s, now).length >= DUTIES_PER_HOUR) continue;
    candidates.add(s.playerId);
  }
  const ids = [...candidates];
  const played = playedOf(hub, ids);
  const need = witnessPlayMs(hub.env);
  const barred = struck(hub, ids, now);
  return ids.filter((id) => (played.get(id) ?? 0) >= need && !barred.has(id)).sort();
}

/**
 * The event's witness commitment (ADR 0058): its pool of the eligible, `participants` left out, and
 * the round `round` names (an encounter's `witnessRound` by default; a mating's or a genesis's
 * own). One event has one commitment: asking again returns it. An empty pool writes none and
 * flags the event `authority-only` once; null then.
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
    return null;
  }
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
    hub.ledger.audit.raise('authority-only', {
      owner: participants[0] ?? '',
      creature: '',
      key: event,
      t: now,
    });
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
  ws.serializeAttachment({ ...session, avail: msg.on, availAt: now } satisfies Session);
}

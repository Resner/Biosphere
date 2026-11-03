// Everyone left (ADR 0053, M8 T9). Once no fighter still in a running fight has a connected player,
// the fight runs on in real time for `AWAY_GRACE_MS`, so a reload can still come back; then the
// authority finalizes every remaining frame at once (the inputs already taken, the fallback marker
// for the rest) and settles it. That gives what playing those frames out would, since nobody could
// send an input. Each participant away at the end finds a report of it on its player row, which
// its next `life` carries once.

import type { FighterOutcome, FightReport } from '../src/net/protocol';
import { lifeFight } from '../src/net/protocol-encounter';
import type { Bundle, Referee } from '../src/net/referee';
import { RULES } from '../src/sim/rules';
import type { Fight } from './fights';
import { type Hub, seated } from './socket';

/** How long a fight with nobody left still runs in real time before it is played out at once. */
export const AWAY_GRACE_MS = 10_000;

/** The wait, shortened by `AWAY_GRACE_MS` (whole ms, at most the default) in fixture mode only, for E2E. */
export function awayGraceMs(env: { DRAND_SOURCE?: string; AWAY_GRACE_MS?: string }): number {
  const ms = env.AWAY_GRACE_MS ? Number(env.AWAY_GRACE_MS) : Number.NaN;
  return env.DRAND_SOURCE === 'fixture' && Number.isInteger(ms) && ms > 0 && ms <= AWAY_GRACE_MS
    ? ms
    : AWAY_GRACE_MS;
}

/**
 * Whether a fighter still in the fight has its player connected; a joiner not yet seated counts as
 * in. One that escaped, stood or died no longer holds the fight, connected or not.
 */
function anyoneIn(hub: Hub, fight: Fight): boolean {
  return fight.players.some(
    (player, slot) =>
      (fight.enc.fighters[slot]?.status ?? 'in') === 'in' && seated(hub, player) !== null,
  );
}

/**
 * Looks at who is left: when nobody still in is connected, the fast-forward falls due the wait
 * from the first time that was seen (and the watchdog's alarm is held for it); anyone back cancels
 * it. True once it is due. Run at each tick, at each participant's close and sign-in, and by the
 * alarm (through `tick`).
 */
export function awayDue(hub: Hub, fight: Fight, now: number): boolean {
  if (fight.enc.over || anyoneIn(hub, fight)) {
    fight.awayDue = null;
    return false;
  }
  if (fight.awayDue === null) {
    fight.awayDue = now + awayGraceMs(hub.env);
    hub.rearm().catch(() => {});
  }
  return now >= fight.awayDue;
}

/**
 * Every frame left, each finalized as at its deadline: the inputs already taken and the fallback
 * marker for the rest. The caller stops once the encounter is over (its timeout bounds it).
 */
export function* remaining(referee: Referee): Generator<Bundle> {
  for (let n = 0; n <= RULES.encounter.timeoutFrames; n++) {
    yield* referee.due(referee.nextDeadline());
  }
}

/** A fighter's result as its player is told it later: the killer and the eater by their player names. */
export function reportOf(fight: Fight, f: FighterOutcome, frames: number): FightReport {
  const name = (slot: number | null) => (slot === null ? null : fight.slots[slot]?.name || null);
  return {
    enc: fight.enc.id,
    outcome: f.outcome,
    cause: f.cause,
    by: f.outcome === 'killed' ? name(f.by) : null,
    egg: f.egg,
    eggBy: f.egg === 'eaten' ? name(f.eggBy) : null,
    frames,
  };
}

/**
 * Keeps the report on the player's row (inside the settlement's transaction): a later one replaces
 * an untold one. Throws when it can't, so the settlement rolls back whole.
 */
export function storeReport(hub: Hub, player: string, report: FightReport): void {
  count(
    hub,
    hub.ctx.storage.sql.exec(
      'UPDATE players SET fight_report = ? WHERE id = ?',
      JSON.stringify(report),
      player,
    ),
  );
}

/** The report waiting for the player, cleared as it is taken (one row); none when nothing waits. */
export function takeReport(hub: Hub, player: string): FightReport | undefined {
  const sql = hub.ctx.storage.sql;
  const row = sql
    .exec<{ fight_report: string }>('SELECT fight_report FROM players WHERE id = ?', player)
    .toArray()[0];
  if (!row?.fight_report) return undefined;
  count(hub, sql.exec("UPDATE players SET fight_report = '' WHERE id = ?", player));
  try {
    return lifeFight({ report: JSON.parse(row.fight_report) })?.report;
  } catch {
    return undefined;
  }
}

/** Adds a write's rows to the ledger's count, which the usage meter reads. */
function count(hub: Hub, cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): void {
  cursor.toArray();
  hub.ledger.rowsWritten += cursor.rowsWritten;
}

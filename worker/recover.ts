// Recovery after an authority restart (ADR 0053, M8 T5): every open fight is rebuilt from its saved
// log, the locks with it. The frames the log doesn't hold, and those whose deadline passed while
// the object was down, are finalized afresh with the fallback marker, as for a late input; each
// connected participant hears the fight again from its start, and one that ended meanwhile settles.

import { type EncJoin, encounterStartOf, fighterStartOf } from '../src/net/encounter-start';
import type { HubMsg } from '../src/net/protocol';
import { Referee } from '../src/net/referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { applyJoins } from '../src/sim/encounter/join';
import type { EncounterJoin } from '../src/sim/encounter/types';
import { RULES } from '../src/sim/rules';
import type { FightRow } from './fight-store';
import { type Fight, resend, tick } from './fights';
import { HOLDS_ENCOUNTER } from './ledger-encounter';
import type { PondRow } from './schema';
import { settle } from './settle';
import type { Hub } from './socket';

/**
 * Rebuilds every open fight the object doesn't hold in memory, then ticks it to `now`. The
 * constructor runs it after the migrations, and the alarm runs it too, so an evicted object that
 * only its watchdog wakes still settles its fights. A row whose fight is settled (its records are
 * written, though the close failed) or can't be rebuilt is taken out of the open index.
 */
export function recoverFights(hub: Hub, now: number): void {
  for (const row of hub.fightStore.openRows()) {
    if (hub.fights.get(row.id)) continue;
    try {
      recover(hub, row, now);
    } catch (error) {
      // One fight that fails to rebuild must not keep the object from starting or the others from recovering.
      console.error('fight recovery failed', row.id, error);
      hub.fights.release(row.id);
      closeQuietly(hub, row.id);
    }
  }
}

function recover(hub: Hub, row: FightRow, now: number): void {
  const fight = rebuild(hub, row);
  if (!fight) console.error('fight recovery: the saved log does not rebuild', row.id);
  const creatures = fight ? creaturesOf(fight, row) : [];
  const sql = hub.ctx.storage.sql;
  const settled = creatures.some((c) => sql.exec(HOLDS_ENCOUNTER, c, row.id).toArray().length > 0);
  const busy = fight?.players.some((p) => hub.fights.playerLocked(p));
  if (!fight || settled || busy) {
    hub.fightStore.closeRow(row.id);
    return;
  }
  const lock = hub.fights.adopt(row.id, [...fight.players], creatures);
  lock.fight = fight;
  // The resync first, so no client sees a frame replaced before it hears the fight again.
  for (const player of fight.players) resend(hub, lock, player);
  if (fight.enc.over) {
    // The log ends with the fight, unsettled: it settles now.
    hub.fightStore.close(fight);
    settle(hub, lock, fight);
  } else {
    tick(hub, row.id, now);
  }
  hub.rearm().catch(() => {});
}

/** The creature in each slot: the start's fighters as the encounter seats them, then the joiners. */
const creaturesOf = (fight: Fight, row: FightRow): string[] => [
  ...fight.enc.fighters.slice(0, row.start.fighters.length).map((f) => f.creature),
  ...row.joins.map((j) => j.fighter.creature),
];

/**
 * The fight as the log holds it: the authority's encounter stepped through every saved frame (each
 * join seated before its frame, as `tick` does), the referee resumed at the first frame the log
 * doesn't hold, and the history a resync sends. Null when the pond or the start is gone.
 */
function rebuild(hub: Hub, row: FightRow): Fight | null {
  const pond = hub.ctx.storage.sql
    .exec<Pick<PondRow, 'seed'>>('SELECT seed FROM ponds WHERE id = ?', row.pond)
    .toArray()[0];
  const startOf = pond ? encounterStartOf(row.start, pond.seed) : null;
  if (!startOf) return null;
  const joins: EncounterJoin[] = [];
  for (const j of row.joins) {
    const fighter = fighterStartOf(j.fighter);
    if (!fighter) return null;
    joins.push({ f: j.f, fighter });
  }
  const enc = createEncounter(startOf);
  const referee = new Referee({
    startAt: row.start.at,
    slots: enc.fighters.length,
    next: row.frames.length,
    joins: row.joins.map((j) => j.f),
  });
  const history: HubMsg[] = [];
  // A join was sent when the referee's next frame was `joinAheadFrames` before its own.
  const sentBefore = (j: EncJoin) => j.f - RULES.encounter.joinAheadFrames;
  const pending = [...row.joins];
  for (const [f, i] of row.frames.entries()) {
    while (pending[0] && sentBefore(pending[0]) <= f) history.push(pending.shift() as EncJoin);
    if (enc.over || i.length !== referee.width(f)) return null;
    applyJoins(enc, joins);
    stepFrame(enc, i);
    history.push({ t: 'enc-frame', enc: enc.id, f, i });
  }
  history.push(...pending);
  for (const f of enc.fighters) if (f.status !== 'in') referee.retire(f.slot);
  return {
    referee,
    enc,
    players: [
      ...enc.fighters.slice(0, row.start.fighters.length).map((f) => f.player),
      ...row.joins.map((j) => j.fighter.player),
    ],
    slots: row.fighters,
    start: row.start,
    joins,
    history,
    pond: row.pond,
    t0: row.start.t0,
    persisted: row.frames.length,
  };
}

function closeQuietly(hub: Hub, id: string): void {
  try {
    hub.fightStore.closeRow(id);
  } catch (error) {
    console.error('fight recovery: the row stays open', id, error);
  }
}

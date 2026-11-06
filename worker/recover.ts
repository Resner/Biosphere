// Recovery after an authority restart (ADR 0053, M8 T5): every open fight is rebuilt from its saved
// log, the locks with it. The frames the log doesn't hold, and those whose deadline passed while
// the object was down, are finalized afresh with the fallback marker, as for a late input; each
// connected participant hears the fight again from its start, and one that ended meanwhile settles.

import { type EncJoin, encounterStartOf, fighterStartOf } from '../src/net/encounter-start';
import type { FighterInfo, FighterOutcome, HubMsg } from '../src/net/protocol';
import { Referee } from '../src/net/referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { applyJoins } from '../src/sim/encounter/join';
import type { Encounter, EncounterJoin } from '../src/sim/encounter/types';
import { RULES } from '../src/sim/rules';
import type { FightRow } from './fight-store';
import { type Fight, resend, tick } from './fights';
import { HOLDS_ENCOUNTER } from './ledger-encounter';
import type { PondRow } from './schema';
import { backToLedger, settle } from './settle';
import { type Hub, seated, sendIfOpen } from './socket';

/**
 * Rebuilds every open fight the object doesn't hold in memory, then ticks it to `now`. The
 * constructor runs it after the migrations, and the alarm runs it too, so an evicted object that
 * only its watchdog wakes still settles its fights. A row whose fight is settled (its records are
 * written, though the close failed) is taken out of the open index; one that can't be rebuilt is
 * given up (`giveUp`).
 */
export function recoverFights(hub: Hub, now: number): void {
  for (const row of hub.fightStore.openRows()) {
    if (hub.fights.get(row.id)) continue;
    try {
      recover(hub, row, now);
    } catch (error) {
      // One fight that fails to rebuild must not keep the object from starting or the others from recovering.
      console.error('fight recovery failed', row.id, error);
      giveUp(hub, row, now);
    }
  }
}

function recover(hub: Hub, row: FightRow, now: number): void {
  const fight = rebuild(hub, row);
  if (!fight) {
    console.error('fight recovery: the saved log does not rebuild', row.id);
    giveUp(hub, row, now);
    return;
  }
  const creatures = participants(fight.enc, row, 'creature');
  const sql = hub.ctx.storage.sql;
  const settled = creatures.some((c) => sql.exec(HOLDS_ENCOUNTER, c, row.id).toArray().length > 0);
  const busy = fight.players.some((p) => hub.fights.playerLocked(p));
  if (settled || busy) {
    hub.fightStore.closeRow(row.id);
    return;
  }
  const lock = hub.fights.adopt(row.id, [...fight.players], creatures);
  lock.fight = fight;
  // The resync first, so no client sees a frame replaced before it hears the fight again.
  for (const player of fight.players) resend(hub, lock, player);
  if (fight.enc.over) {
    // The log ends with the fight, unsettled: it settles now.
    settle(hub, lock, fight);
  } else {
    tick(hub, row.id, now);
  }
  hub.rearm().catch(() => {});
}

/** Each slot's player or creature: the start's fighters as the encounter seats them, then the joiners. */
const participants = (enc: Encounter, row: FightRow, key: 'player' | 'creature'): string[] => [
  ...enc.fighters.slice(0, row.start.fighters.length).map((f) => f[key]),
  ...row.joins.map((j) => j.fighter[key]),
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
  if (!pond || !startOf) return null;
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
    players: participants(enc, row, 'player'),
    slots: row.fighters,
    start: row.start,
    joins,
    history,
    pond: row.pond,
    pondSeed: pond.seed,
    t0: row.start.t0,
    persisted: row.frames.length,
    awayDue: null,
  };
}

/**
 * A fight whose saved log no longer rebuilds (M9 T9): flagged `recover-failed` once, its row
 * closed and its locks released, as a settlement that fails is (`settle.ts`). Each connected
 * participant hears `enc-end` without a settlement (each fighter as the log's start or join placed
 * it, standing), then its creature as the ledger holds it. Nothing of the fight is written.
 */
function giveUp(hub: Hub, row: FightRow, now: number): void {
  const named = namedIn(row);
  try {
    hub.ledger.audit.raise('recover-failed', {
      owner: named[0]?.player ?? '',
      creature: named[0]?.creature ?? '',
      key: row.id,
      t: now,
    });
    hub.fightStore.closeRow(row.id);
  } catch (error) {
    console.error('fight recovery: the row stays open', row.id, error);
  }
  hub.fights.release(row.id);
  const players = new Set(named.map((f) => f.player));
  const end: HubMsg = {
    t: 'enc-end',
    enc: row.id,
    f: Array.isArray(row.frames) ? Math.min(row.frames.length, RULES.encounter.timeoutFrames) : 0,
    hash: NO_HASH,
    fighters: named.map(standing),
  };
  for (const player of players) {
    const found = seated(hub, player);
    if (found) sendIfOpen(found[0], end);
  }
  // A player already in a newer lock is that fight's to bind.
  backToLedger(
    hub,
    [...players].filter((p) => !hub.fights.playerLocked(p)),
    now,
  );
}

/** The end state a fight that never settled reports: no encounter was rebuilt to hash. */
const NO_HASH = '0'.repeat(16);

/** Every fighter the row's start and joins still name, as far as they read. */
function namedIn(row: FightRow): FighterInfo[] {
  const start: unknown = row.start;
  const starters = isObj(start) && Array.isArray(start.fighters) ? start.fighters : [];
  const joiners = Array.isArray(row.joins)
    ? row.joins.map((j: unknown) => isObj(j) && j.fighter)
    : [];
  return [...starters, ...joiners].filter(
    (f): f is FighterInfo =>
      isObj(f) && typeof f.player === 'string' && typeof f.creature === 'string',
  );
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** A fighter as its start or join placed it, standing: nothing of the fight is kept. */
const standing = (f: FighterInfo): FighterOutcome => ({
  player: f.player,
  creature: f.creature,
  x: f.x,
  y: f.y,
  vx: f.vx,
  vy: f.vy,
  heading: f.heading,
  biomass: f.biomass,
  energy: f.energy,
  health: f.health,
  outcome: 'stood',
  cause: null,
  by: null,
  egg: 'none',
  eggBy: null,
});

// A fight's end (ADR 0050, ADR 0052, ADR 0054): the results become records, and the countersigned
// settlement document goes into the fight's saved log, in one transaction; each dead fighter hears
// `died` with its fallback, everyone gets `enc-end` with the document, the locks go and each
// connected life takes its result and the locked time. Each kill's carrion goes to the whole pond
// after the records (M7 T14). A settlement that fails leaves every life as the ledger holds it.

import { settlementOf } from '../src/net/encounter-verify';
import type { FighterOutcome, HubMsg } from '../src/net/protocol';
import { FRAME_MS } from '../src/net/referee';
import { hashEncounter, results } from '../src/sim/encounter/encounter';
import { type Encounter, survivedOutcome } from '../src/sim/encounter/types';
import { RULES } from '../src/sim/rules';
import { logOf } from './fight-store';
import type { Fight, Lock } from './fights';
import type { FighterRecord, SettleResult } from './ledger-encounter';
import { type Condition, HUNDREDTHS, isOld, type LifeState, unsaved } from './life';
import { bind, fallbackAfter, finish, sendLife } from './lives';
import { promote, queued } from './sessions';
import { activeSessions, type Hub, seated, sendIfOpen } from './socket';

/** Sends `msg` to every participant who is connected now. */
export function tell(hub: Hub, lock: Lock, msg: HubMsg): void {
  for (const player of lock.players) {
    const found = seated(hub, player);
    if (found) sendIfOpen(found[0], msg);
  }
}

/** Every fighter's result and final state, as `enc-end` carries them. */
function outcomesOf(enc: Encounter, done: ReturnType<typeof results>): FighterOutcome[] {
  return done.map((r, slot) => {
    const f = enc.fighters[slot] as Encounter['fighters'][number];
    const b = f.body;
    return {
      player: f.player,
      creature: f.creature,
      x: b.x,
      y: b.y,
      vx: b.vx,
      vy: b.vy,
      heading: b.heading,
      biomass: b.biomass,
      energy: b.energy,
      health: b.health,
      outcome: r.outcome,
      cause: r.cause,
      by: r.by,
      egg: r.egg,
      eggBy: r.eggBy,
    };
  });
}

const vitalsOf = (f: FighterOutcome): Condition => ({
  biomass: Math.floor(f.biomass * HUNDREDTHS),
  energy: Math.floor(f.energy * HUNDREDTHS),
  health: Math.floor(f.health * HUNDREDTHS),
});

const vitalsFrom = ({ biomass, energy, health }: Condition): Condition => ({
  biomass,
  energy,
  health,
});

const survived = (f: FighterOutcome) => survivedOutcome(f.outcome);

/** The connected socket that plays `creature`, with its live life state. */
function playing(hub: Hub, player: string, creature: string) {
  const found = seated(hub, player);
  const life = found?.[1].life;
  return found && life?.creature === creature && !life.over ? { found, life } : null;
}

/**
 * Each slot's life clock at the end (ADR 0053): its clock at its start or join plus 100 ms for
 * every frame from there to the end, within its lifespan, whether its player was there or not.
 */
function lockedTimes(fight: Fight): number[] {
  const starters = fight.start.fighters.length;
  return fight.slots.map((clock, slot) => {
    const from = slot < starters ? 0 : (fight.joins[slot - starters]?.f ?? fight.enc.frame);
    const locked = clock.activeMs + Math.max(0, fight.enc.frame - from) * FRAME_MS;
    return Math.max(clock.activeMs, Math.min(locked, clock.lifespanMs));
  });
}

/**
 * Settles a fight that is over: its records and its countersigned document (`Ledger.settle`), then
 * `died` to each dead fighter who is connected (the fallback computed after the records), then
 * `enc-end` with the document to everyone. The locks are released and each connected life takes
 * its result and its locked time; old age that fell due during the fight ends a survivor now.
 */
export function settle(hub: Hub, lock: Lock, fight: Fight): void {
  const { enc } = fight;
  const done = results(enc);
  const fighters = outcomesOf(enc, done);
  const creatureAt = (slot: number | null) =>
    slot === null ? null : (enc.fighters[slot]?.creature ?? null);
  const seats = fighters.map((f) => playing(hub, f.player, f.creature));
  const lockedMs = lockedTimes(fight);
  const records: FighterRecord[] = fighters.map((f, slot) => {
    const life = seats[slot]?.life;
    return {
      owner: f.player,
      creature: f.creature,
      outcome: f.outcome,
      cause: f.cause,
      by: creatureAt(f.by),
      frames: done[slot]?.frame ?? enc.frame,
      condition: vitalsOf(f),
      reward: Math.floor((enc.fighters[slot]?.reward ?? 0) * HUNDREDTHS),
      activeMs: lockedMs[slot] ?? 0,
      unsaved: life && unsaved(life) ? vitalsFrom(life) : null,
      eggBy: f.egg === 'eaten' ? creatureAt(f.eggBy) : null,
    };
  });
  let settled: SettleResult;
  try {
    settled = hub.ledger.settle(
      { enc: enc.id, fighters: records, settlement: settlementOf(logOf(fight), enc, Date.now()) },
      {
        stored: () => hub.fightStore.settlement(enc.id),
        seal: (signed) => hub.fightStore.seal(fight, signed),
      },
    );
  } catch (error) {
    // A rule the results break is a bug: nothing is written, and the fight leaves no trace on a life.
    console.error('encounter settlement failed', error);
    unsettled(hub, lock, fight, fighters);
    return;
  }
  for (const [slot, f] of fighters.entries()) {
    const now = survived(f) ? null : seats[slot];
    const record = now ? hub.ledger.deathRecord(f.creature) : null;
    if (!now || !record || f.cause === null) continue;
    // The killer as its player was named when the fight began (it may have left since).
    const by =
      f.cause === 'killed' && f.by !== null ? fight.slots[f.by]?.name || undefined : undefined;
    sendIfOpen(now.found[0], {
      t: 'died',
      cause: f.cause,
      record,
      fallback: fallbackAfter(hub, hub.ledger.head(f.creature)),
      ...(by !== undefined ? { by } : {}),
    });
  }
  const { settlement } = settled;
  tell(hub, lock, {
    t: 'enc-end',
    enc: enc.id,
    f: enc.frame,
    hash: hashEncounter(enc),
    fighters,
    ...(settlement ? { settlement } : {}),
  });
  dropCarrion(hub, fight, fighters);
  hub.fights.release(lock.id);
  for (const [slot, f] of fighters.entries()) settleLife(hub, f, lockedMs[slot] ?? 0);
  freeSeats(hub);
}

/** The seats held for away fighters are free: the first in line takes one. */
function freeSeats(hub: Hub): void {
  if (queued(hub).length > 0) promote(hub).catch(() => {});
}

/**
 * A settlement that threw (the ledger refused a record, or the log's row could not be written):
 * nothing of it was written. The fight is flagged once and its row closed, so nothing settles it
 * later; each connected fighter hears `enc-end` without a document, then its creature as the ledger
 * holds it, alive, and the locks go.
 */
function unsettled(hub: Hub, lock: Lock, fight: Fight, fighters: FighterOutcome[]): void {
  const { enc } = fight;
  const now = Date.now();
  try {
    hub.ledger.flagSettleFailed(enc.id, lock.players[0] ?? '', lock.creatures[0] ?? '', now);
    hub.fightStore.closeRow(enc.id);
  } catch (error) {
    console.error('encounter settlement: the failure is not noted', error);
  }
  tell(hub, lock, { t: 'enc-end', enc: enc.id, f: enc.frame, hash: hashEncounter(enc), fighters });
  hub.fights.release(lock.id);
  for (const player of lock.players) {
    const found = seated(hub, player);
    if (!found) continue;
    const [ws, session] = found;
    // The connection plays the creature from the ledger's head again, as a sign-in would.
    ws.serializeAttachment({ ...session, life: bind(hub, player, now) });
    sendLife(hub, ws, player);
  }
  freeSeats(hub);
}

/**
 * Every client in the fight's pond hears of each kill's carrion, and drops the same pieces from
 * it (`src/sim/carrion.ts`). A victim killed by a creature (not by the water) leaves some; the
 * authority holds nothing of it afterwards. The tick is the pond tick of the kill, and the food is
 * the victim's biomass times its worth.
 */
function dropCarrion(hub: Hub, fight: Fight, fighters: FighterOutcome[]): void {
  const { enc } = fight;
  const tick = fight.t0 + enc.frame * RULES.encounter.frameTicks;
  for (const [slot, f] of fighters.entries()) {
    if (f.outcome !== 'killed') continue;
    const msg: HubMsg = {
      t: 'carrion',
      enc: enc.id,
      x: f.x,
      y: f.y,
      // A victim worth less as prey leaves less food (ADR 0054); its size still sets the pieces.
      biomass: f.biomass * (enc.fighters[slot]?.worth ?? 1),
      radius: Math.sqrt(f.biomass),
      tick,
    };
    for (const [ws, session] of activeSessions(hub)) {
      if (session.pondId === fight.pond) sendIfOpen(ws, msg);
    }
  }
}

/**
 * A connected fighter's life after the end: the result's condition and the locked time, as its
 * records hold them, or over when it died. The next report credits only what follows the end. A
 * survivor's due old age ends it now. Its client takes the result from `enc-end`, and one who died
 * has had its `died`.
 */
function settleLife(hub: Hub, f: FighterOutcome, activeMs: number): void {
  const now = playing(hub, f.player, f.creature);
  if (!now) return;
  const [ws, session] = now.found;
  let life: LifeState = {
    ...now.life,
    ...vitalsOf(f),
    activeMs,
    savedMs: activeMs,
    t: Date.now(),
  };
  if (!survived(f)) life = { ...life, savedN: life.n, over: true };
  else if (isOld(life)) life = finish(hub, ws, life, f.player, 'old-age');
  ws.serializeAttachment({ ...session, life });
}

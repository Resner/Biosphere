// A fight's end (ADR 0050, ADR 0052): the results become records in one transaction, each dead
// fighter hears `died` with its fallback, everyone gets `enc-end`, the locks go and each connected
// life takes its result. T14's carrion broadcast belongs here too.

import { genomeFromBase64url } from '../src/genome/codec';
import { speciesName } from '../src/genome/names';
import type { FighterOutcome, HubMsg } from '../src/net/protocol';
import { hashEncounter, results } from '../src/sim/encounter/encounter';
import type { Encounter } from '../src/sim/encounter/types';
import type { Fight, Lock } from './fights';
import type { FighterRecord, Vitals } from './ledger-encounter';
import { HUNDREDTHS, isOld, type LifeState, takeResult, unsaved } from './life';
import { fallbackAfter, finish, sendLife } from './lives';
import { type Hub, seated, sendIfOpen } from './socket';

/** Sends `msg` to every participant who is connected now. */
export function tell(hub: Hub, lock: Lock, msg: HubMsg): void {
  for (const player of lock.players) {
    const found = seated(hub, player);
    if (found) sendIfOpen(found[0], msg);
  }
}

/** Every fighter's result and final state, as `enc-end` carries them. */
function outcomesOf(enc: Encounter): FighterOutcome[] {
  return results(enc).map((r, slot) => {
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

const vitalsOf = (f: FighterOutcome): Vitals => ({
  biomass: Math.floor(f.biomass * HUNDREDTHS),
  energy: Math.floor(f.energy * HUNDREDTHS),
  health: Math.floor(f.health * HUNDREDTHS),
});

const survived = (f: FighterOutcome) => f.outcome === 'escaped' || f.outcome === 'stood';

/** The connected socket that plays `creature`, with its live life state. */
function playing(hub: Hub, player: string, creature: string) {
  const found = seated(hub, player);
  const life = found?.[1].life;
  return found && life?.creature === creature && !life.over ? { found, life } : null;
}

/** What `died` calls a killer: its player's name while connected, else its creature's species. */
function nameOf(hub: Hub, enc: Encounter, slot: number | null): string | undefined {
  const f = slot === null ? undefined : enc.fighters[slot];
  if (!f) return undefined;
  const found = seated(hub, f.player);
  if (found) return found[1].name;
  const genome = genomeFromBase64url(hub.ledger.head(f.creature)?.genome ?? '');
  return genome ? speciesName(genome) : undefined;
}

/**
 * Settles a fight that is over: its records (`Ledger.settle`), then `died` to each dead fighter
 * who is connected (the fallback computed after the records), then `enc-end` to everyone. The
 * locks are released and each connected life takes its result; old age that fell due during the
 * fight ends a survivor now.
 */
export function settle(hub: Hub, lock: Lock, fight: Fight): void {
  const { enc } = fight;
  const fighters = outcomesOf(enc);
  const done = results(enc);
  const creatureAt = (slot: number | null) =>
    slot === null ? null : (enc.fighters[slot]?.creature ?? null);
  const records: FighterRecord[] = fighters.map((f, slot) => {
    const life = playing(hub, f.player, f.creature)?.life;
    return {
      owner: f.player,
      creature: f.creature,
      outcome: f.outcome,
      cause: f.cause,
      by: creatureAt(f.by),
      frames: done[slot]?.frame ?? enc.frame,
      condition: vitalsOf(f),
      reward: Math.floor((enc.fighters[slot]?.reward ?? 0) * HUNDREDTHS),
      activeMs: life?.activeMs ?? hub.ledger.head(f.creature)?.activeMs ?? 0,
      unsaved: life && unsaved(life) ? savedPart(life) : null,
      eggBy: f.egg === 'eaten' ? creatureAt(f.eggBy) : null,
    };
  });
  let recorded = false;
  try {
    hub.ledger.settle({ enc: enc.id, fighters: records });
    recorded = true;
  } catch (error) {
    // A rule the results break is a bug: nothing is written, and each life still takes its result.
    console.error('encounter settlement failed', error);
  }
  for (const f of fighters) {
    const now = survived(f) ? null : playing(hub, f.player, f.creature);
    const record = now ? hub.ledger.deathRecord(f.creature) : null;
    if (!now || !record || f.cause === null) continue;
    const by = f.cause === 'killed' ? nameOf(hub, enc, f.by) : undefined;
    sendIfOpen(now.found[0], {
      t: 'died',
      cause: f.cause,
      record,
      fallback: fallbackAfter(hub, hub.ledger.head(f.creature)),
      ...(by !== undefined ? { by } : {}),
    });
  }
  tell(hub, lock, { t: 'enc-end', enc: enc.id, f: enc.frame, hash: hashEncounter(enc), fighters });
  hub.fights.release(lock.id);
  for (const f of fighters) settleLife(hub, f, lock.owed.has(f.player), recorded);
}

const savedPart = (life: LifeState) => ({
  biomass: life.biomass,
  energy: life.energy,
  health: life.health,
  activeMs: life.activeMs,
});

/**
 * A connected fighter's life after the end: the result's condition (saved, when the records hold
 * it), or over when it died. A survivor's due old age ends it now. A fighter who signed in again
 * during the fight (`owed`) gets its `life` now; one who died has had its `died`.
 */
function settleLife(hub: Hub, f: FighterOutcome, owed: boolean, recorded: boolean): void {
  const now = playing(hub, f.player, f.creature);
  if (!now) {
    const found = seated(hub, f.player);
    if (found && owed) sendLife(hub, found[0], f.player);
    return;
  }
  const [ws, session] = now.found;
  const condition = vitalsOf(f);
  let life: LifeState;
  if (!survived(f)) {
    life = {
      ...now.life,
      ...condition,
      savedMs: now.life.activeMs,
      savedN: now.life.n,
      over: true,
    };
  } else {
    life = recorded ? { ...now.life, ...condition } : takeResult(now.life, condition);
    if (isOld(life)) life = finish(hub, ws, life, f.player, 'old-age');
  }
  ws.serializeAttachment({ ...session, life });
  if (owed && survived(f)) sendLife(hub, ws, f.player, life);
}

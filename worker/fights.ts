// The fights the authority holds in memory (ADR 0050): who is locked, and each running fight's
// referee, its encounter and the one timer it keeps for the next deadline. Each running fight's
// log goes to SQLite as it runs (`fight-store.ts`, ADR 0053); rebuilding from it is M8 T5's.

import {
  type EncJoin,
  type EncStart,
  encounterStartOf,
  fighterStartOf,
} from '../src/net/encounter-start';
import type { ClientMsg, FighterInfo, HubMsg } from '../src/net/protocol';
import { Referee } from '../src/net/referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import { applyJoins } from '../src/sim/encounter/join';
import type { Encounter, EncounterJoin } from '../src/sim/encounter/types';
import { RULES } from '../src/sim/rules';
import type { Asking } from './engage';
import type { SlotClock } from './fight-store';
import type { LifeState } from './life';
import type { PondRow } from './schema';
import { settle, tell } from './settle';
import { type ActiveSession, type Hub, seated, sendIfOpen } from './socket';

/** The time and timers the fights run on; hub tests swap in a hand-moved one. */
export interface Clock {
  now(): number;
  after(ms: number, run: () => void): unknown;
  cancel(handle: unknown): void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  after: (ms, run) => setTimeout(run, ms),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** A running fight: the referee's frame clock and the authority's own copy of the encounter. */
export interface Fight {
  referee: Referee;
  enc: Encounter;
  /** The player in each slot, joiners included. */
  players: string[];
  /**
   * Each slot's player name ('' when it was away, for `died` to name a killer) and life clock at
   * the start or its join, as the saved log holds them.
   */
  slots: SlotClock[];
  /** The `enc-start` everyone began from; a joiner gets it first (M7 T15). */
  start: EncStart;
  /** The fighters joined so far, each seated before its frame is stepped. */
  joins: EncounterJoin[];
  /** Every `enc-frame` and `enc-join` sent so far, in order: a joiner's catch-up. */
  history: HubMsg[];
  /** The pond it is fought in and the pond tick it started at, to place a kill's carrion. */
  pond: string;
  t0: number;
  /** How many final frames the saved log holds. */
  persisted: number;
}

/** What a slot's saved clock is taken from: the fighter's life on its connection at lock-in. */
export type SlotLife = Pick<LifeState, 'creature' | 'activeMs' | 'lifespanMs'>;

/** A slot's name and life clock as its fight begins or it joins. */
function slotOf(hub: Hub, player: string, life: SlotLife): SlotClock {
  return {
    name: seated(hub, player)?.[1].name ?? '',
    activeMs: life.activeMs,
    lifespanMs: life.lifespanMs,
  };
}

/** One lock: asking the target for its state, then running from `enc-start`. */
export interface Lock {
  id: string;
  /** Player ids and creature ids, attacker first. */
  players: string[];
  creatures: string[];
  /** The checked sides while the target's own state is awaited; null once the fight has started. */
  asking: Asking | null;
  /** The fight once it has started. */
  fight: Fight | null;
  /** Players who signed in again during the fight: their `life` waits for the end. */
  owed: Set<string>;
  /** The pending timer: the lock answer's window while asking, the next deadline while running. */
  timer: unknown;
}

export class Fights {
  private readonly byId = new Map<string, Lock>();
  private readonly byPlayer = new Map<string, Lock>();
  private readonly byCreature = new Map<string, Lock>();
  /** Inputs dropped because they named another fight or came from someone not in one. */
  strays = 0;

  constructor(private readonly clock: () => Clock) {}

  /** Whether the creature is in a lock (asking or running). */
  creatureLocked(creature: string): boolean {
    return this.byCreature.has(creature);
  }

  playerLocked(player: string): boolean {
    return this.byPlayer.has(player);
  }

  get(id: string): Lock | undefined {
    return this.byId.get(id);
  }

  /** The lock the creature is in, if any. */
  ofCreature(creature: string): Lock | undefined {
    return this.byCreature.get(creature);
  }

  /** The lock the player is in, if any. */
  ofPlayer(player: string): Lock | undefined {
    return this.byPlayer.get(player);
  }

  /** Locks the participants at once, while the target's answer is awaited; `onWindow` runs when the window closes. */
  open(
    id: string,
    players: string[],
    creatures: string[],
    windowMs: number,
    onWindow: () => void,
  ): Lock {
    const lock: Lock = {
      id,
      players,
      creatures,
      asking: null,
      fight: null,
      owed: new Set(),
      timer: null,
    };
    this.byId.set(id, lock);
    for (const p of players) this.byPlayer.set(p, lock);
    for (const c of creatures) this.byCreature.set(c, lock);
    this.arm(lock, this.clock().now() + windowMs, onWindow);
    return lock;
  }

  /** Replaces the lock's timer with one that runs `run` at hub time `at` (at once if that has passed). */
  arm(lock: Lock, at: number, run: () => void): void {
    this.clearTimer(lock);
    lock.timer = this.clock().after(Math.max(0, at - this.clock().now()), () => {
      lock.timer = null;
      run();
    });
  }

  /** Adds a joiner to a running lock (M7 T15). */
  join(lock: Lock, player: string, creature: string): void {
    lock.players.push(player);
    lock.creatures.push(creature);
    this.byPlayer.set(player, lock);
    this.byCreature.set(creature, lock);
  }

  /** Ends the lock and its timer; the participants may court, hatch and engage again. */
  release(id: string): void {
    const lock = this.byId.get(id);
    if (!lock) return;
    this.clearTimer(lock);
    this.byId.delete(id);
    for (const p of lock.players) if (this.byPlayer.get(p) === lock) this.byPlayer.delete(p);
    for (const c of lock.creatures) if (this.byCreature.get(c) === lock) this.byCreature.delete(c);
  }

  /** Timers held now (one per lock); none once every fight has ended. */
  timers(): number {
    let n = 0;
    for (const lock of this.byId.values()) if (lock.timer !== null) n++;
    return n;
  }

  private clearTimer(lock: Lock): void {
    if (lock.timer !== null) this.clock().cancel(lock.timer);
    lock.timer = null;
  }
}

/**
 * Starts the fight of `msg` (about to be sent to both): the referee's clock from frame 0 at
 * `msg.at`, the authority's encounter from the same start every client builds, and its row in the
 * log. False (and nothing is kept) when it can't be built or the row can't be written.
 */
export function runFight(
  hub: Hub,
  lock: Lock,
  msg: EncStart,
  pond: Pick<PondRow, 'id' | 'seed'>,
  lives: readonly SlotLife[],
): boolean {
  const start = encounterStartOf(msg, pond.seed);
  if (!start) return false;
  const enc = createEncounter(start);
  const slots: SlotClock[] = [];
  for (const f of enc.fighters) {
    const life = lives.find((l) => l.creature === f.creature);
    if (!life) return false;
    slots.push(slotOf(hub, f.player, life));
  }
  const fight: Fight = {
    referee: new Referee({ startAt: msg.at, slots: enc.fighters.length }),
    enc,
    players: enc.fighters.map((f) => f.player),
    slots,
    start: msg,
    joins: [],
    history: [],
    pond: pond.id,
    t0: msg.t0,
    persisted: 0,
  };
  try {
    hub.fightStore.open(fight, hub.clock.now());
  } catch (error) {
    console.error('fight log insert failed', error);
    return false;
  }
  lock.fight = fight;
  armNext(hub, lock);
  return true;
}

/** The timer for the next deadline, which steps every frame due by then. */
function armNext(hub: Hub, lock: Lock): void {
  const fight = lock.fight;
  if (!fight) return;
  hub.fights.arm(lock, fight.referee.nextDeadline(), () => tick(hub, lock.id, hub.clock.now()));
}

/** A participant's input for a frame. One for another fight, or from someone not fighting, is dropped and counted. */
export function fightInput(
  hub: Hub,
  session: ActiveSession,
  msg: ClientMsg & { t: 'input' },
): void {
  const lock = hub.fights.ofPlayer(session.playerId);
  const fight = lock?.fight;
  if (!lock || !fight || fight.enc.id !== msg.enc) {
    hub.fights.strays++;
    return;
  }
  const now = hub.clock.now();
  const slot = fight.players.indexOf(session.playerId);
  // The last input that completes a frame finalizes it at once.
  if (fight.referee.input(slot, msg.f, msg.i, now) === 'ok') tick(hub, lock.id, now);
}

/** Finalizes every due frame in order, steps the encounter with each and sends the bundles; ends the fight once it is over. */
export function tick(hub: Hub, id: string, now: number): void {
  const lock = hub.fights.get(id);
  const fight = lock?.fight;
  if (!lock || !fight) return;
  const { referee, enc } = fight;
  for (const bundle of referee.due(now)) {
    applyJoins(enc, fight.joins);
    stepFrame(enc, bundle.i);
    const msg: HubMsg = { t: 'enc-frame', enc: enc.id, f: bundle.f, i: bundle.i };
    fight.history.push(msg);
    tell(hub, lock, msg);
    for (const f of enc.fighters) if (f.status !== 'in') referee.retire(f.slot);
    if (enc.over) {
      hub.fightStore.close(fight);
      settle(hub, lock, fight);
      return;
    }
  }
  hub.fightStore.append(fight);
  armNext(hub, lock);
}

/** A participant's socket closed: its fight's log takes every final frame now (ADR 0053). */
export function flushFight(hub: Hub, player: string): void {
  const fight = hub.fights.ofPlayer(player)?.fight;
  if (fight && !fight.enc.over) hub.fightStore.flush(fight);
}

/** Whether a running fight can take one more fighter: not over, and fewer than the limit seated or joining. */
export const joinable = (fight: Fight): boolean =>
  !fight.enc.over && fight.players.length < RULES.encounter.maxFighters;

/**
 * Seats a joiner in the running fight of `lock` from the next frame to be finalized +
 * `joinAheadFrames` (M7 T15), its start `infoAt` that frame's pond tick. The join is written to
 * the log first; then the joiner gets the fight's `enc-start` and its history, and everyone hears
 * the `enc-join`. False (and nothing changes) when its genome does not build or the write fails.
 */
export function admit(
  hub: Hub,
  lock: Lock,
  fight: Fight,
  infoAt: (tick: number) => FighterInfo,
  life: SlotLife,
): boolean {
  const f = fight.referee.next + RULES.encounter.joinAheadFrames;
  const info = infoAt(fight.start.t0 + RULES.encounter.frameTicks * f);
  const fighter = fighterStartOf(info);
  if (!fighter || !joinable(fight)) return false;
  const msg: EncJoin = { t: 'enc-join', enc: fight.enc.id, f, fighter: info };
  const slot = slotOf(hub, info.player, life);
  try {
    hub.fightStore.join(fight, msg, slot);
  } catch (error) {
    console.error('fight log join failed', error);
    return false;
  }
  fight.referee.join(f);
  fight.joins.push({ f, fighter });
  fight.players.push(info.player);
  fight.slots.push(slot);
  hub.fights.join(lock, info.player, info.creature);
  const found = seated(hub, info.player);
  if (found) for (const m of [fight.start, ...fight.history]) sendIfOpen(found[0], m);
  fight.history.push(msg);
  tell(hub, lock, msg);
  return true;
}

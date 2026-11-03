// The fights the authority holds in memory (ADR 0050): who is locked, and each running fight's
// referee, its encounter and the one timer it keeps for the next deadline. No fight survives a
// restart until M8; nothing here touches SQLite while a fight runs.

import { type EncStart, encounterStartOf } from '../src/net/encounter-start';
import type { ClientMsg } from '../src/net/protocol';
import { Referee } from '../src/net/referee';
import { createEncounter, stepFrame } from '../src/sim/encounter/encounter';
import type { Encounter } from '../src/sim/encounter/types';
import type { Asking } from './engage';
import { settle, tell } from './settle';
import { type ActiveSession, type Hub, seated } from './socket';

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
  /** The player in each slot. */
  players: string[];
  /** Each slot's player name at the start ('' when it was away), for `died` to name a killer. */
  names: string[];
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
 * Starts the fight of `msg` (just sent to both): the referee's clock from frame 0 at `msg.at`, and
 * the authority's encounter from the same start every client builds. False when it can't be built.
 */
export function runFight(hub: Hub, lock: Lock, msg: EncStart, pondSeed: string): boolean {
  const start = encounterStartOf(msg, pondSeed);
  if (!start) return false;
  const enc = createEncounter(start);
  lock.fight = {
    referee: new Referee({ startAt: msg.at, slots: enc.fighters.length }),
    enc,
    players: enc.fighters.map((f) => f.player),
    names: enc.fighters.map((f) => seated(hub, f.player)?.[1].name ?? ''),
  };
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
    stepFrame(enc, bundle.i);
    tell(hub, lock, { t: 'enc-frame', enc: enc.id, f: bundle.f, i: bundle.i });
    for (const f of enc.fighters) if (f.status !== 'in') referee.retire(f.slot);
    if (enc.over) {
      settle(hub, lock, fight);
      return;
    }
  }
  armNext(hub, lock);
}

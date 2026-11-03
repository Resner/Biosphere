// The fights the authority holds in memory (ADR 0050): who is locked, and the one timer each lock
// keeps while it lasts. No fight survives a restart until M8; nothing here touches SQLite.

import { RULES, TICK_HZ } from '../src/sim/rules';
import type { Asking } from './engage';

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

/** Until T9's referee ends a fight with its result, a lock lasts the fight's timeout and ends with none. */
export const LOCK_TIMEOUT_MS =
  (RULES.encounter.timeoutFrames * RULES.encounter.frameTicks * 1000) / TICK_HZ;

/** When spawn protection that starts at `now` ends (a genesis, a promoted child or a restore; never a resume). */
export const protectionEnds = (now: number): number =>
  now + RULES.encounter.protectionSeconds * 1000;

/** One lock: asking the target for its state, then running from `enc-start`. */
export interface Lock {
  id: string;
  /** Player ids and creature ids, attacker first. */
  players: string[];
  creatures: string[];
  /** The checked sides while the target's own state is awaited; null once the fight has started. */
  asking: Asking | null;
  /** The pending timer: the lock answer's window while asking, the timeout while running. */
  timer: unknown;
}

export class Fights {
  private readonly byId = new Map<string, Lock>();
  private readonly byPlayer = new Map<string, Lock>();
  private readonly byCreature = new Map<string, Lock>();

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

  /** Locks the participants at once, while the target's answer is awaited; `onWindow` runs when the window closes. */
  open(
    id: string,
    players: string[],
    creatures: string[],
    windowMs: number,
    onWindow: () => void,
  ): Lock {
    const lock: Lock = { id, players, creatures, asking: null, timer: null };
    this.byId.set(id, lock);
    for (const p of players) this.byPlayer.set(p, lock);
    for (const c of creatures) this.byCreature.set(c, lock);
    lock.timer = this.clock().after(windowMs, () => {
      lock.timer = null;
      onWindow();
    });
    return lock;
  }

  /** The fight started: the window's timer (if still set) gives way to the timeout. */
  run(lock: Lock, timeoutMs: number): void {
    this.clearTimer(lock);
    lock.timer = this.clock().after(timeoutMs, () => {
      lock.timer = null;
      this.release(lock.id);
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

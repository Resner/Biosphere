// Keeps the local world tick on the pond clock (ADR 0016): joining sets it, a small drift is
// slewed by running the loop 2% fast or slow, a large one snaps, and a tab that was hidden resnaps.

import { ClockSync, type PondClock } from '../net/clock';
import type { World } from '../sim/types';

/** How often a drift check runs while the tick is on time. */
const CHECK_MS = 10_000;
/** While slewing the check runs often, so the correction does not overshoot. */
const SLEW_CHECK_MS = 1_000;

export class PondTime {
  private readonly sync: ClockSync;
  private nextCheck = 0;
  private speed = 1;

  constructor(
    private readonly clock: PondClock,
    private readonly epoch: number,
  ) {
    this.sync = new ClockSync(clock, epoch);
  }

  /** The pond tick at a local time. */
  tickAt(localNow: number): number {
    return this.clock.pondTick(localNow, this.epoch);
  }

  /** Puts a world on the pond clock. */
  join(world: World, localNow: number): void {
    world.tick = this.tickAt(localNow);
    this.speed = 1;
    this.nextCheck = localNow + CHECK_MS;
  }

  /** Pond time in ms: the hub's clock since the pond's epoch. */
  pondMs(localNow: number): number {
    return this.clock.hubNow(localNow) - this.epoch;
  }

  /** Returns after a hidden tab: the world skips the missed time instead of simulating it. */
  resnap(world: World, localNow: number): void {
    this.join(world, localNow);
  }

  /**
   * Checks the drift now and then; returns the loop speed to use. A snap sets `world.tick`
   * itself and skips the ticks in between.
   */
  update(world: World, localNow: number): number {
    if (localNow < this.nextCheck) return this.speed;
    const correction = this.sync.correct(world.tick, localNow);
    if (correction.snapTo !== undefined) world.tick = Math.floor(correction.snapTo);
    this.speed = correction.speed;
    this.nextCheck = localNow + (this.speed === 1 ? CHECK_MS : SLEW_CHECK_MS);
    return this.speed;
  }
}

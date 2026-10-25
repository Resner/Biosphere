// Pond clock: the hub's wall clock estimated from pings, and the pond tick derived from it (ADR 0007).
// Pure and DOM-free; times are milliseconds, ticks run at TICK_HZ.

import { TICK_HZ } from '../sim/rules';

/** A sample is trusted for this long before a slower one may replace it. */
const SAMPLE_TTL_MS = 120_000;
/** Loop speed change while catching up with the pond tick. */
const SLEW = 0.02;
const SLEW_MIN_TICKS = 1;
const SLEW_MAX_TICKS = 3;

interface Sample {
  offset: number;
  rtt: number;
  at: number;
}

export class PondClock {
  private best: Sample | null = null;

  /** `sent` and `recv` are local times of the ping and its pong; `hubNow` is the hub's reply. */
  addSample(sent: number, recv: number, hubNow: number): void {
    const rtt = recv - sent;
    if (!(rtt >= 0) || !Number.isFinite(hubNow)) return;
    const best = this.best;
    if (best && recv - best.at < SAMPLE_TTL_MS && best.rtt < rtt) return;
    this.best = { offset: hubNow - (sent + rtt / 2), rtt, at: recv };
  }

  /** Hub time minus local time, or null before the first sample. */
  get offset(): number | null {
    return this.best?.offset ?? null;
  }

  get rtt(): number | null {
    return this.best?.rtt ?? null;
  }

  hubNow(localNow: number): number {
    return localNow + (this.best?.offset ?? 0);
  }

  pondTick(localNow: number, epoch: number): number {
    return Math.floor(this.pondTickExact(localNow, epoch));
  }

  /** The pond tick with its fraction. */
  pondTickExact(localNow: number, epoch: number): number {
    return ((this.hubNow(localNow) - epoch) * TICK_HZ) / 1000;
  }
}

export interface Correction {
  /** Multiplier for the loop speed. */
  speed: number;
  /** Set when the loop must jump to this tick. */
  snapTo?: number;
}

/** Keeps a local tick counter within a tick of the pond tick without visible jumps. */
export class ClockSync {
  constructor(
    private readonly clock: PondClock,
    private readonly epoch: number,
  ) {}

  correct(localTick: number, localNow: number): Correction {
    const target = this.clock.pondTickExact(localNow, this.epoch);
    const drift = target - localTick;
    const size = Math.abs(drift);
    if (size > SLEW_MAX_TICKS) return { speed: 1, snapTo: target };
    if (size < SLEW_MIN_TICKS) return { speed: 1 };
    return { speed: 1 + Math.sign(drift) * SLEW };
  }
}

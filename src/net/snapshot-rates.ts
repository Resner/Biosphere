// Snapshot rates by distance (M11 T15, ADR 0062). The two ends of a link see different areas, so
// the receiver decides how often it wants the other's snapshots: 10 Hz for a peer of P0 or P1 or
// one within 1.15 × its view's half-diagonal (so everything on screen arrives at 10 Hz), 5 Hz
// within its AoI, 2 Hz for P3 and 1 Hz for P4. It says so with a `rate` event on a change, at most
// once a second per link (`RateAsker`), and the sender keeps each link to what it asked
// (`SendRates`), 10 Hz until asked. Pure: the session (`src/game/online.ts`) wires both.

import { AOI_PER_HALF_HEIGHT } from './aoi';
import type { LinkClass } from './connection-policy';
import type { SNAPSHOT_RATES } from './protocol';

export type SnapshotRate = (typeof SNAPSHOT_RATES)[number];

/** The rate of a link nobody has asked otherwise: one snapshot every 100 ms. */
export const FULL_RATE: SnapshotRate = 10;
/** Within this many view half-diagonals a peer is asked for every snapshot. */
export const VIEW_RATE_DIAG = 1.15;
/** A link is asked again at most this often (ms). */
export const RATE_EVERY_MS = 1000;
/** The half-diagonal of a 16:9 view, in view half-heights (the AoI's view, ADR 0062). */
const VIEW_DIAG = Math.hypot(1, 16 / 9);

/**
 * The rate to ask of a linked peer in class `cls` (null: held in its grace with no class) at
 * `distance` wu from the own creature, whose view's half-height is `halfHeight` wu.
 */
export function wantedRate(
  cls: LinkClass | null,
  distance: number,
  halfHeight: number,
): SnapshotRate {
  if (cls !== null && cls <= 1) return FULL_RATE;
  if (distance <= VIEW_RATE_DIAG * VIEW_DIAG * halfHeight) return FULL_RATE;
  if (cls === 2 || distance <= AOI_PER_HALF_HEIGHT * halfHeight) return 5;
  return cls === 3 ? 2 : 1;
}

/** The receiver's side: what each link was asked, and when. */
export class RateAsker {
  private readonly asked = new Map<string, { hz: SnapshotRate; at: number }>();

  /**
   * Each link's wanted rate now; gives the `rate` events due: a link whose rate changed, unless
   * it was asked in the last second (it is asked once the second is up, if still changed).
   */
  update(now: number, wants: Iterable<readonly [string, SnapshotRate]>): [string, SnapshotRate][] {
    const out: [string, SnapshotRate][] = [];
    for (const [id, hz] of wants) {
      const last = this.asked.get(id);
      if ((last?.hz ?? FULL_RATE) === hz) continue;
      if (last && now - last.at < RATE_EVERY_MS) continue;
      this.asked.set(id, { hz, at: now });
      out.push([id, hz]);
    }
    return out;
  }

  /** The rate last asked of `id`, 10 Hz before any ask. */
  wanted(id: string): SnapshotRate {
    return this.asked.get(id)?.hz ?? FULL_RATE;
  }

  /** A link closed or opened afresh: its sender starts again at 10 Hz. */
  forget(id: string): void {
    this.asked.delete(id);
  }
}

/**
 * The sender's side: each link's asked rate, as a share of the 10 Hz snapshot frames. `frame(n)`
 * names the frame going out; a link is due on every (10 / rate)th frame from the one after it
 * asked, so a rise takes effect with the next frame.
 */
export class SendRates {
  private readonly rates = new Map<string, { hz: SnapshotRate; from: number }>();
  private n = 0;

  /** The snapshot frame going out now (counted from 0, one per 100 ms). */
  frame(n: number): void {
    this.n = n;
  }

  /** `id` asked for `hz`. */
  set(id: string, hz: SnapshotRate): void {
    if (hz === FULL_RATE) this.rates.delete(id);
    else this.rates.set(id, { hz, from: this.n + 1 });
  }

  /** The rate this side sends `id` at. */
  hz(id: string): SnapshotRate {
    return this.rates.get(id)?.hz ?? FULL_RATE;
  }

  /** Whether the current frame goes to `id`. */
  due(id: string): boolean {
    const r = this.rates.get(id);
    if (!r) return true;
    const every = FULL_RATE / r.hz;
    return (((this.n - r.from) % every) + every) % every === 0;
  }

  forget(id: string): void {
    this.rates.delete(id);
  }
}

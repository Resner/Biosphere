// Riding the current (M12 T7, ADR 0064): the page's side. A page alone for long enough offers
// "Ride the current" (R) for 12 s, and again every 2 minutes while it stays alone; R or the button
// sends `ride`; the hub's `spawn { why: 'ride' }` plays the transition (1.2 s swept along the current
// with streaks of snow and the picture easing toward the water's colour, then the creature drifts
// in at the arrival; a 0.4 s cross-fade under Reduce motion) with input held; a `ride-no` is told.

import type { ClientMsg, HubMsg, RideNo, Vec2 } from '../net/protocol';
import { WHERE_MIN_GAP_MS } from '../net/where';
import type { RideLook } from '../render/ride-fx';

/** How long the page is alone before it offers a ride: the hub's own wait (`worker/ride.ts`). */
export const RIDE_ALONE_MS = 120_000;
/**
 * The hub times its wait from the report the page sends on turning alone, which goes within the
 * reports' gap: the offer waits that much longer, so the hub never answers it "Not yet".
 */
export const RIDE_REPORT_LAG_MS = WHERE_MIN_GAP_MS;
/** The offer shows this long... */
export const RIDE_OFFER_MS = 12_000;
/** ...and again this often while the page stays alone. */
export const RIDE_AGAIN_MS = 120_000;
/** The transition: swept along, then drifting in. */
export const RIDE_MS = 1200;
/** The transition under Reduce motion: a cross-fade. */
export const RIDE_FADE_MS = 400;
/** The creature is carried this many of its radii before the picture turns... */
const SWEEP_RADII = 16;
/** ...and drifts in to the arrival from this many radii short of it. */
const DRIFT_RADII = 6;

export type RidePhase = 'idle' | 'asking' | 'riding' | 'arrived';

/** What a refusal tells the player. */
export const RIDE_NO_TEXT: Readonly<Record<RideNo, string>> = {
  locked: 'Not while fighting',
  busy: 'Not while courting',
  soon: 'Not yet',
  company: 'Someone is near',
  none: 'No one to ride to yet',
};

/** The creature the ride carries: the sim's player. */
export interface RideBody {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Trip {
  from: Vec2;
  to: Vec2;
  /** The unit way from `from` to `to`. */
  dir: Vec2;
  start: number;
  ms: number;
  /** Its radius when the ride began, for the sweep and the drift. */
  radius: number;
  reduced: boolean;
  /** Whether the creature has been put by the arrival (the picture's turn). */
  turned: boolean;
}

const smooth = (u: number): number => {
  const t = Math.min(1, Math.max(0, u));
  return t * t * (3 - 2 * t);
};

export class Ride {
  /** How long the page waits alone before it offers (`debug.aloneMs`). */
  aloneMs = RIDE_ALONE_MS;
  phase: RidePhase = 'idle';
  /** Whether the offer shows now. */
  offered = false;
  /** The hub's last word: `ride` for a ride granted, else the refusal's reason. */
  last: 'ride' | RideNo | null = null;
  private aloneFrom: number | null = null;
  private trip: Trip | null = null;
  private readonly lookNow: RideLook = { sweep: 0, wash: 0, dirX: 1, dirY: 0 };

  /** Each frame: whether the page is alone; returns whether the offer shows. */
  offer(now: number, alone: boolean): boolean {
    if (!alone) {
      this.aloneFrom = null;
      this.offered = false;
      return false;
    }
    this.aloneFrom ??= now;
    const past = now - this.aloneFrom - this.aloneMs - RIDE_REPORT_LAG_MS;
    this.offered = this.phase !== 'riding' && past >= 0 && past % RIDE_AGAIN_MS < RIDE_OFFER_MS;
    return this.offered;
  }

  /** Whether the page thinks it is alone (the menu offers the ride whenever it does). */
  get alone(): boolean {
    return this.aloneFrom !== null;
  }

  /** R or the button: sends `ride` unless one is being asked or played; true when it went. */
  ask(send: (msg: ClientMsg) => boolean): boolean {
    if (this.phase === 'asking' || this.phase === 'riding') return false;
    if (!send({ t: 'ride' })) return false;
    this.phase = 'asking';
    this.offered = false;
    return true;
  }

  /**
   * The hub's word: a ride's `spawn` starts the transition from `from` (the creature now, and its
   * radius); a `ride-no` returns the toast that tells it. Anything else is not the ride's.
   */
  receive(
    msg: HubMsg,
    now: number,
    from: { x: number; y: number; radius: number },
    reduced: boolean,
  ): string | null {
    if (msg.t === 'ride-no') {
      if (this.phase === 'asking') this.phase = 'idle';
      this.last = msg.why;
      return RIDE_NO_TEXT[msg.why];
    }
    if (msg.t !== 'spawn' || msg.why !== 'ride') return null;
    const dx = msg.x - from.x;
    const dy = msg.y - from.y;
    const d = Math.hypot(dx, dy);
    this.trip = {
      from: { x: from.x, y: from.y },
      to: { x: msg.x, y: msg.y },
      dir: d > 0 ? { x: dx / d, y: dy / d } : { x: 1, y: 0 },
      start: now,
      ms: reduced ? RIDE_FADE_MS : RIDE_MS,
      radius: Math.max(1, from.radius),
      reduced,
      turned: false,
    };
    this.phase = 'riding';
    this.offered = false;
    this.aloneFrom = null;
    this.last = 'ride';
    return null;
  }

  /** Whether the player's input is held: the transition is playing. */
  get holding(): boolean {
    return this.phase === 'riding';
  }

  /** Where the hub has the creature while the ride plays (its reports say so), else null. */
  reportAt(): Vec2 | null {
    return this.trip ? this.trip.to : null;
  }

  /**
   * Each tick while riding: moves `body` along the ride at `now`. Returns `turn` the tick it is put
   * by the arrival (the caller snaps the camera and the field there), `moved` before and after,
   * `arrived` the tick it ends exactly at the arrival, and null with no ride.
   */
  carry(body: RideBody, now: number): 'moved' | 'turn' | 'arrived' | null {
    const trip = this.trip;
    if (!trip) return null;
    const u = (now - trip.start) / trip.ms;
    const { dir, to, from, radius } = trip;
    if (u >= 1) {
      body.x = to.x;
      body.y = to.y;
      body.vx = 0;
      body.vy = 0;
      this.trip = null;
      this.phase = 'arrived';
      return 'arrived';
    }
    if (u < 0.5) {
      if (trip.reduced) {
        body.vx = 0;
        body.vy = 0;
        return 'moved';
      }
      // Swept along the current, faster and faster.
      const s = SWEEP_RADII * radius * (u / 0.5) ** 2;
      body.x = from.x + dir.x * s;
      body.y = from.y + dir.y * s;
      body.vx = dir.x * radius;
      body.vy = dir.y * radius;
      return 'moved';
    }
    // Drifting in, slower and slower (under Reduce motion, at the arrival at once).
    const left = trip.reduced ? 0 : DRIFT_RADII * radius * (1 - smooth((u - 0.5) / 0.5));
    body.x = to.x - dir.x * left;
    body.y = to.y - dir.y * left;
    body.vx = trip.reduced ? 0 : dir.x * radius * 0.25;
    body.vy = trip.reduced ? 0 : dir.y * radius * 0.25;
    if (trip.turned) return 'moved';
    trip.turned = true;
    return 'turn';
  }

  /** The transition's look at `now` (the streaks and the wash), or null with no ride. Allocates nothing. */
  look(now: number): RideLook | null {
    const trip = this.trip;
    if (!trip) return null;
    const u = Math.min(1, Math.max(0, (now - trip.start) / trip.ms));
    const l = this.lookNow;
    // The wash rises to the turn and falls after it; the streaks only with motion.
    l.wash = u < 0.5 ? smooth(u / 0.5) : 1 - smooth((u - 0.5) / 0.5);
    l.sweep = trip.reduced ? 0 : u < 0.5 ? smooth(u / 0.25) : 1 - smooth((u - 0.5) / 0.4);
    l.dirX = trip.dir.x;
    l.dirY = trip.dir.y;
    return l;
  }

  /** A new life or the title: nothing of a ride carries over. */
  reset(): void {
    this.trip = null;
    this.phase = 'idle';
    this.offered = false;
    this.aloneFrom = null;
  }

  /** `state().ride`. */
  view(): { offered: boolean; phase: RidePhase; last: 'ride' | RideNo | null } {
    return { offered: this.offered, phase: this.phase, last: this.last };
  }
}

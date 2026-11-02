// Damage lands as hits, in intervals (M6c T9, DESIGN §10), "kinda how you take damage in
// Minecraft": while damage arrives, at most one hit every 0.5 s of sim time, the first at once.
// Each hit kicks the camera 5–8 px by the damage since the last hit and jolts the body, both
// decaying to rest within 0.25 s; between hits everything is still. Every cause shares the cadence.
// Pure presentation: it reads damage events and never feeds back into the sim, the HUD and the DOM
// never move, and Reduce motion drops the kicks (the shell keeps the flash and the sound).

import { clamp, lerp } from '../sim/math';
import type { DeathCause } from '../sim/types';

export const SHAKE = {
  /** At most one hit this often while damage arrives, in sim ticks (0.5 s at 30 Hz). */
  everyTicks: 15,
  /** The camera's kick per hit, in CSS pixels: `min` for the least damage, `max` from `fullHp`. */
  kickPx: { min: 5, max: 8 },
  /** Damage since the last hit (hp) that kicks the most: about half a second in a toxin cloud. */
  fullHp: 6,
  /** The body's jolt per hit, in body radii. */
  bodyRadii: 0.15,
  /** A kick decays to rest over this long, in seconds. */
  decaySeconds: 0.25,
  /** The longest step one update takes, so a long pause does not skip a kick. */
  maxStepSeconds: 0.1,
} as const;

export type ShakeKind = 'uv' | 'pressure' | 'jolt';

/** Which kind a damage over time shows: UV and pressure their own, the rest a jolt. */
export function shakeKind(cause: DeathCause): ShakeKind {
  return cause === 'uv' || cause === 'pressure' ? cause : 'jolt';
}

/** Each kick turns by the golden angle, so successive hits never repeat a direction. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export class Shake {
  /** The body's offset now, in body radii (world axes, y up). */
  readonly body = { x: 0, y: 0 };
  /** The camera's offset now, in CSS pixels (world axes, y up). */
  readonly camera = { x: 0, y: 0 };
  /** The kind of the hit still settling, or null when still. */
  kind: ShakeKind | null = null;
  /** Hits since the life began (the shell resets it with each life). */
  hits = 0;
  /** The damage the last hit carried: everything since the hit before it, in hp. */
  hitDamage = 0;
  /** The sim tick of the last hit; none yet when -Infinity. */
  private lastTick = Number.NEGATIVE_INFINITY;
  /** Damage taken since the last hit, in hp. */
  private pending = 0;
  /** The running kick's age in seconds; < 0 when none. */
  private age = -1;
  private angle = 0;
  /** The running kick's direction (unit), cached at the hit. */
  private dirX = 1;
  private dirY = 0;
  /** The running kick's camera amplitude, in CSS px. */
  private kickPx = 0;
  private hitKind: ShakeKind = 'jolt';

  /**
   * One damage event of this cause and `amount` (hp) on sim tick `tick` of the life. Returns true
   * when it lands a hit: the shell then flashes the hurt tint and plays the hit's sound.
   */
  hit(cause: DeathCause, amount: number, tick: number): boolean {
    this.pending += Math.max(amount, 0);
    if (tick - this.lastTick < SHAKE.everyTicks) return false;
    this.lastTick = tick;
    this.hitDamage = this.pending;
    this.pending = 0;
    this.hits++;
    this.hitKind = shakeKind(cause);
    this.angle += GOLDEN;
    this.dirX = Math.cos(this.angle);
    this.dirY = Math.sin(this.angle);
    this.kickPx = lerp(
      SHAKE.kickPx.min,
      SHAKE.kickPx.max,
      clamp(this.hitDamage / SHAKE.fullHp, 0, 1),
    );
    this.age = 0;
    return true;
  }

  /** Advances by `dt` seconds of wall-clock time; `reduced` (Reduce motion) keeps everything still. */
  update(dt: number, reduced: boolean): void {
    let envelope = 0;
    if (this.age >= 0) {
      const k = 1 - this.age / SHAKE.decaySeconds;
      if (k <= 0) this.age = -1;
      else {
        envelope = k * k;
        this.age += clamp(dt, 0, SHAKE.maxStepSeconds);
      }
    }
    this.kind = envelope > 0 ? this.hitKind : null;
    const level = reduced ? 0 : envelope;
    // The view recoils one way and the body is knocked the other, so the body stands out.
    this.camera.x = level === 0 ? 0 : this.kickPx * level * this.dirX;
    this.camera.y = level === 0 ? 0 : this.kickPx * level * this.dirY;
    this.body.x = level === 0 ? 0 : -SHAKE.bodyRadii * level * this.dirX;
    this.body.y = level === 0 ? 0 : -SHAKE.bodyRadii * level * this.dirY;
  }

  reset(): void {
    this.lastTick = Number.NEGATIVE_INFINITY;
    this.pending = 0;
    this.hitDamage = 0;
    this.hits = 0;
    this.age = -1;
    this.kind = null;
    this.body.x = 0;
    this.body.y = 0;
    this.camera.x = 0;
    this.camera.y = 0;
  }
}

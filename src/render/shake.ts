// Damage shakes the body and the camera slightly (M6b T10, DESIGN §10), in place of the red edge
// vignette and the UV and pressure overlays of M1–M6: UV a fast, fine tremble, pressure a slow
// squeeze, toxin and starvation a short jolt. Pure presentation: it reads damage events and never
// feeds back into the sim, the HUD and the DOM never move, and Reduce motion stills it.

import type { DeathCause } from '../sim/types';

export const SHAKE = {
  /** The most the body is drawn off its place, in body radii. */
  bodyMax: 0.06,
  /** The most the camera moves, in CSS pixels. */
  cameraMaxPx: 1.5,
  /** Time constant of the fade once the hits stop, in seconds. */
  fadeSeconds: 0.2,
  /** The longest step one update takes, so a long pause does not jump the pattern. */
  maxStepSeconds: 0.1,
  /** UV: two pairs of fast sines per axis (Hz), at this amplitude in body radii. */
  uv: { amp: 0.025, hz: [23, 31, 19, 29] as const },
  /** Pressure: a slow press down and release, with a slower sideways sway. */
  pressure: { amp: 0.05, hz: 0.9, swayHz: 0.45, sway: 0.35 },
  /** Toxin and starvation: a decaying kick of `seconds`, ringing at `hz`, at most once per `every` s. */
  jolt: { amp: 0.06, seconds: 0.28, hz: 9, every: 0.8 },
} as const;

export type ShakeKind = 'uv' | 'pressure' | 'jolt';

/** Which shake a damage over time gives: UV and pressure their own, the rest a jolt. */
export function shakeKind(cause: DeathCause): ShakeKind {
  return cause === 'uv' || cause === 'pressure' ? cause : 'jolt';
}

const TAU = Math.PI * 2;
/** Each jolt turns by the golden angle, so successive kicks never repeat a direction. */
const GOLDEN = Math.PI * (3 - Math.sqrt(5));
/** A level below this snaps to 0, so a settled body sits exactly in place. */
const SNAP = 0.01;

export class Shake {
  /** The body's offset now, in body radii (world axes, y up). */
  readonly body = { x: 0, y: 0 };
  /** The camera's offset now, in CSS pixels (world axes, y up). */
  readonly camera = { x: 0, y: 0 };
  /** The strongest shake running, or null when still. */
  kind: ShakeKind | null = null;
  private t = 0;
  private uv = 0;
  private pressure = 0;
  /** The running jolt's age in seconds; < 0 when none. */
  private joltAge = -1;
  private sinceJolt: number = SHAKE.jolt.every;
  private joltAngle = 0;

  /** One damage event of this cause landed. */
  hit(cause: DeathCause): void {
    const kind = shakeKind(cause);
    if (kind === 'uv') this.uv = 1;
    else if (kind === 'pressure') this.pressure = 1;
    else if (this.joltAge < 0 && this.sinceJolt >= SHAKE.jolt.every) {
      this.joltAge = 0;
      this.sinceJolt = 0;
      this.joltAngle += GOLDEN;
    }
  }

  /** Advances by `dt` seconds of wall-clock time; `reduced` (Reduce motion) keeps everything still. */
  update(dt: number, reduced: boolean): void {
    const step = Math.min(Math.max(dt, 0), SHAKE.maxStepSeconds);
    this.t += step;
    this.sinceJolt += step;
    const fade = Math.exp(-step / SHAKE.fadeSeconds);
    this.uv = this.uv * fade < SNAP ? 0 : this.uv * fade;
    this.pressure = this.pressure * fade < SNAP ? 0 : this.pressure * fade;

    const t = this.t;
    let x = 0;
    let y = 0;
    let jolt = 0;
    if (this.joltAge >= 0) {
      const k = 1 - this.joltAge / SHAKE.jolt.seconds;
      if (k <= 0) this.joltAge = -1;
      else {
        jolt = k * k;
        const ring = SHAKE.jolt.amp * jolt * Math.cos(TAU * SHAKE.jolt.hz * this.joltAge);
        x += ring * Math.cos(this.joltAngle);
        y += ring * Math.sin(this.joltAngle);
        this.joltAge += step;
      }
    }
    if (this.uv > 0) {
      const [a, b, c, d] = SHAKE.uv.hz;
      const amp = SHAKE.uv.amp * this.uv;
      x += amp * (0.6 * Math.sin(TAU * a * t) + 0.4 * Math.sin(TAU * b * t + 1.3));
      y += amp * (0.6 * Math.sin(TAU * c * t + 0.7) + 0.4 * Math.sin(TAU * d * t + 2.1));
    }
    if (this.pressure > 0) {
      const p = SHAKE.pressure;
      const amp = p.amp * this.pressure;
      y -= amp * (0.5 - 0.5 * Math.cos(TAU * p.hz * t));
      x += amp * p.sway * Math.sin(TAU * p.swayHz * t);
    }

    const strongest = Math.max(this.uv, this.pressure, jolt);
    this.kind =
      strongest === 0
        ? null
        : strongest === jolt
          ? 'jolt'
          : strongest === this.pressure
            ? 'pressure'
            : 'uv';

    const length = Math.hypot(x, y);
    const k = reduced ? 0 : length > SHAKE.bodyMax ? SHAKE.bodyMax / length : 1;
    this.body.x = x * k;
    this.body.y = y * k;
    // The camera follows the same pattern, scaled to its own cap.
    const toCamera = SHAKE.cameraMaxPx / SHAKE.bodyMax;
    this.camera.x = this.body.x * toCamera;
    this.camera.y = this.body.y * toCamera;
  }

  reset(): void {
    this.t = 0;
    this.uv = 0;
    this.pressure = 0;
    this.joltAge = -1;
    this.sinceJolt = SHAKE.jolt.every;
    this.kind = null;
    this.body.x = 0;
    this.body.y = 0;
    this.camera.x = 0;
    this.camera.y = 0;
  }
}

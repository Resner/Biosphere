import type { StepEvent } from '../sim/types';

/** Presentation constants: how long each cue lasts and how strongly it shows. */
export const FX = {
  popSeconds: 0.55,
  rippleSeconds: 0.85,
  /** Rings drawn at once; the oldest is replaced when a burst overflows the pool. */
  ringCapacity: 24,
  /** The least the vignette shows on any hit, so a trickle of damage still reads. */
  vignetteFloor: 0.4,
  /** Extra vignette per hit point taken in one tick. */
  vignettePerHp: 0.05,
  /** Time constant of the fade once damage stops. */
  vignetteFadeSeconds: 0.25,
  /** The body dissolves for this long before the death screen appears. */
  dissolveSeconds: 1.2,
  /** Size of an eat pop and of a dash ripple, in cell radii. */
  popRadii: 1.7,
  rippleRadii: 3.2,
  /** The longest the first update after a pause may advance the cues, in seconds. */
  resumeCapSeconds: 0.1,
} as const;

export type RingKind = 'pop' | 'ripple';

export interface Ring {
  kind: RingKind;
  x: number;
  y: number;
  /** Half-extent of the quad in world units. */
  size: number;
  /** Seconds since it started. */
  age: number;
  life: number;
}

export interface FxSnapshot {
  eat: number;
  dash: number;
  damage: number;
  /** Rings alive right now. */
  rings: number;
  /** 0..1, how much red edge the screen shows. */
  vignette: number;
  /** 0..1, how far the dying body has dissolved. */
  dissolve: number;
}

export interface FxAnchor {
  x: number;
  y: number;
  radius: number;
}

/**
 * The feedback cues for one creature: pops on eating, ripples on dashing, a red edge while
 * damaged and the dissolve on death. Pure presentation state: it reads sim events and never feeds
 * back into the sim.
 */
export class Effects {
  readonly rings: Ring[] = [];
  vignette = 0;
  dissolve = 0;
  private dissolving = false;
  private resumed = false;
  private eat = 0;
  private dash = 0;
  private damage = 0;

  /**
   * Reacts to one sim event. `at` is where an eat or dash cue belongs: the food for an eat, the
   * creature for a dash.
   */
  onEvent(event: StepEvent, at: FxAnchor): void {
    switch (event.type) {
      case 'eat':
        this.eat++;
        this.addRing('pop', at, FX.popRadii, FX.popSeconds);
        break;
      case 'dash':
        this.dash++;
        this.addRing('ripple', at, FX.rippleRadii, FX.rippleSeconds);
        break;
      case 'damage':
        this.damage++;
        this.vignette = Math.max(
          this.vignette,
          Math.min(1, FX.vignetteFloor + event.amount * FX.vignettePerHp),
        );
        break;
    }
  }

  /** Starts the death dissolve; later calls do nothing. */
  startDissolve(): void {
    this.dissolving = true;
  }

  get dissolved(): boolean {
    return this.dissolve >= 1;
  }

  /** Call when the tab returns: the next update ignores the time spent hidden. */
  resume(): void {
    this.resumed = true;
  }

  /** Advances every cue by `dt` seconds of wall-clock time. */
  update(dt: number): void {
    if (this.resumed) {
      dt = Math.min(dt, FX.resumeCapSeconds);
      this.resumed = false;
    }
    let live = 0;
    for (const ring of this.rings) {
      ring.age += dt;
      if (ring.age < ring.life) this.rings[live++] = ring;
    }
    this.rings.length = live;
    this.vignette *= Math.exp(-dt / FX.vignetteFadeSeconds);
    // Snap to exactly 0 so the shaders can skip the hurt tint.
    if (this.vignette < 0.002) this.vignette = 0;
    if (this.dissolving) this.dissolve = Math.min(1, this.dissolve + dt / FX.dissolveSeconds);
  }

  reset(): void {
    this.rings.length = 0;
    this.vignette = 0;
    this.dissolve = 0;
    this.dissolving = false;
    this.resumed = false;
    this.eat = 0;
    this.dash = 0;
    this.damage = 0;
  }

  snapshot(): FxSnapshot {
    return {
      eat: this.eat,
      dash: this.dash,
      damage: this.damage,
      rings: this.rings.length,
      vignette: this.vignette,
      dissolve: this.dissolve,
    };
  }

  private addRing(kind: RingKind, at: FxAnchor, radii: number, life: number): void {
    // Only events add rings, never frames, so these small objects are not a per-frame cost.
    if (this.rings.length >= FX.ringCapacity) this.rings.shift();
    this.rings.push({ kind, x: at.x, y: at.y, size: at.radius * radii, age: 0, life });
  }
}

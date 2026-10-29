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
  /** The ring that marks a committed mating. */
  mateRadii: 4.5,
  mateSeconds: 1.4,
  /** The soft ring each time the creature grows another tenth, and the wider one for a size tier. */
  growRadii: 2.4,
  growSeconds: 0.9,
  tierRadii: 6,
  tierSeconds: 1.8,
  /** An egg's burst (M6 T20): the first ring's size in egg radii, how much wider each next one is, and how long it runs. */
  burstRadii: 2.2,
  burstStep: 1.6,
  burstSeconds: 0.9,
  /** Paying for a mating (M6 T20): the drawn body eases to its new size, dipping this far below it. */
  shrinkSeconds: 0.7,
  shrinkDip: 0.08,
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
  /** Growth cues shown: every tenth of the adult size, and size tiers entered. */
  grow: number;
  tier: number;
  /** Egg bursts shown, and matings paid for with the shrinking pulse (M6 T20). */
  bursts: number;
  cost: number;
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
  /** The frame that starts the dissolve ends before the body is drawn dissolving, so it is not counted. */
  private dissolveFresh = false;
  private resumed = false;
  private eat = 0;
  private dash = 0;
  private damage = 0;
  private grow = 0;
  private tier = 0;
  private bursts = 0;
  private cost = 0;
  /** The paid-for shrink: the drawn radius it starts from and its age in seconds; age < 0 when none. */
  private shrinkFrom = 0;
  private shrinkAge = -1;

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

  /** A slow ring around the creature when a mating is committed (the ripple art, wider and longer). */
  matePulse(at: FxAnchor): void {
    this.addRing('ripple', at, FX.mateRadii, FX.mateSeconds);
  }

  /** A soft ring when the creature has grown another tenth; `tier` makes it the bigger one for a new size tier. */
  growPulse(at: FxAnchor, tier: boolean): void {
    if (tier) {
      this.tier++;
      this.addRing('ripple', at, FX.tierRadii, FX.tierSeconds);
    } else {
      this.grow++;
      this.addRing('ripple', at, FX.growRadii, FX.growSeconds);
    }
  }

  /**
   * An egg bursting (M6 T20): `rings` rings, each wider and slower than the last, so a rarer child
   * gets a bigger flourish. The first is a pop, the rest ripples.
   */
  burst(at: FxAnchor, rings: number): void {
    this.bursts++;
    for (let i = 0; i < rings; i++) {
      const radii = FX.burstRadii * FX.burstStep ** i;
      this.addRing(i === 0 ? 'pop' : 'ripple', at, radii, FX.burstSeconds * (1 + 0.3 * i));
    }
  }

  /** A mating was paid for: the drawn body shrinks from `fromRadius` to its new size with a pulse. */
  costPulse(fromRadius: number): void {
    this.cost++;
    this.shrinkFrom = fromRadius;
    this.shrinkAge = 0;
  }

  /** The radius to draw a body of `radius` at: itself, unless the paid-for shrink is still running. */
  drawnRadius(radius: number): number {
    if (this.shrinkAge < 0) return radius;
    const t = Math.min(1, this.shrinkAge / FX.shrinkSeconds);
    const eased = 1 - (1 - t) ** 3;
    const dip = 1 - FX.shrinkDip * Math.sin(Math.PI * t);
    return (this.shrinkFrom + (radius - this.shrinkFrom) * eased) * dip;
  }

  /** Starts the death dissolve; later calls do nothing. */
  startDissolve(): void {
    if (!this.dissolving) this.dissolveFresh = true;
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
    if (this.shrinkAge >= 0) {
      this.shrinkAge += dt;
      if (this.shrinkAge >= FX.shrinkSeconds) this.shrinkAge = -1;
    }
    if (this.dissolveFresh) this.dissolveFresh = false;
    else if (this.dissolving) {
      this.dissolve = Math.min(1, this.dissolve + dt / FX.dissolveSeconds);
    }
  }

  reset(): void {
    this.rings.length = 0;
    this.vignette = 0;
    this.dissolve = 0;
    this.dissolving = false;
    this.dissolveFresh = false;
    this.resumed = false;
    this.eat = 0;
    this.dash = 0;
    this.damage = 0;
    this.grow = 0;
    this.tier = 0;
    this.bursts = 0;
    this.cost = 0;
    this.shrinkAge = -1;
  }

  snapshot(): FxSnapshot {
    return {
      eat: this.eat,
      dash: this.dash,
      damage: this.damage,
      grow: this.grow,
      tier: this.tier,
      bursts: this.bursts,
      cost: this.cost,
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

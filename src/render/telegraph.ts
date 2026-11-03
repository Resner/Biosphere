// Fight telegraphs (M7 T12, DESIGN §10): a windup glows the attacker's front and weapon tips,
// brighter as the strike nears; a landed hit flashes its target; a block throws a spark and wobbles
// the staggered attacker; a creature fighting in another fight wears a faint broken ring; and in a
// fight with a choice to make, the player's target wears a bracketed ring (M7 T15). Pure
// presentation: the game says what happened and where, and this keeps the timers and the marks the
// scene draws as instanced quads.

import * as THREE from 'three';
import { RULES, TICK_HZ } from '../sim/rules';
import { FX } from './effects';
import { writeInstance } from './instances';
import { telegraphMaterial } from './materials';

export const TELEGRAPH = {
  /** A windup lasts this many ticks (the sim's). */
  windupTicks: RULES.encounter.strike.windupTicks,
  /** The front's glow sits this far from the centre, and is this big, in body radii. */
  frontRadii: 0.85,
  glowRadii: 1.1,
  /** Each weapon tip's glow, in body radii; a weapon reaching past `tipReach` radii shows its tips. */
  tipRadii: 0.6,
  tipReach: 1.05,
  /** Weapons covering less than this half-angle (rad) show one tip, straight ahead. */
  oneTipArc: 0.2,
  /** A block's spark, in the struck body's radii, and how long it flies. */
  sparkRadii: 1.2,
  sparkSeconds: 0.4,
  /** A landed hit flashes its target this red, fading over this long (as the player's own hit). */
  flashPeak: 0.85,
  flashSeconds: FX.hurtFlashSeconds,
  /** A remote's snapshot health dropping by this share of its maximum flashes it (outside the fight). */
  healthDrop: 0.04,
  /** A stagger wobbles the attacker's heading this much (rad) at this rate, over its 9 ticks. */
  wobbleRad: 0.3,
  wobbleHz: 9,
  wobbleSeconds: RULES.encounter.brace.staggerTicks / TICK_HZ,
  /** A fighting creature's ring, in its radii, and its strength. */
  ringRadii: 1.7,
  ringAlpha: 0.35,
  /** The player's target's ring (M7 T15), in its radii; full strength when chosen, fainter for the default nearest. */
  targetRadii: 1.6,
  targetChosen: 0.95,
  targetDefault: 0.5,
  /** Marks drawn at once. */
  capacity: 64,
} as const;

/**
 * A windup's glow from the ticks left until it lands (fractional between frames): it rises from an
 * eighth on its first tick to full on its last, and is gone (0) once the strike has landed (null).
 */
export function windupGlow(ticksLeft: number | null): number {
  if (ticksLeft === null || !Number.isFinite(ticksLeft)) return 0;
  const w = TELEGRAPH.windupTicks;
  if (ticksLeft > w) return 0;
  return Math.min(1, Math.max(0, (w + 1 - ticksLeft) / w));
}

export type TelegraphKind = 'glow' | 'spark' | 'ring' | 'target';

/** One quad: its kind, centre and half-size in wu, and its value 0..1 (strength or progress). */
export interface TelegraphMark {
  kind: TelegraphKind;
  x: number;
  y: number;
  size: number;
  value: number;
}

interface Spark {
  x: number;
  y: number;
  size: number;
  age: number;
}

/** What `render.info().telegraphs` reports: the marks drawn this frame, by kind, and the flashes and wobbles running. */
export interface TelegraphInfo {
  glows: number;
  sparks: number;
  rings: number;
  targets: number;
  flashes: number;
  wobbles: number;
  /** Since the page loaded: hits flashed, blocks sparked, staggers wobbled. */
  flashed: number;
  sparked: number;
  wobbled: number;
}

const SIDES = [-1, 1] as const;

const KIND: Readonly<Record<TelegraphKind, number>> = { glow: 0, spark: 1, ring: 2, target: 3 };

type Counts = Record<'glows' | 'sparks' | 'rings' | 'targets', number>;
const COUNTED: Readonly<Record<TelegraphKind, keyof Counts>> = {
  glow: 'glows',
  spark: 'sparks',
  ring: 'rings',
  target: 'targets',
};

/** The telegraphs' timers and this frame's marks. Allocates only as the pools grow. */
export class Telegraphs {
  private readonly marks: TelegraphMark[] = [];
  private used = 0;
  private readonly sparks: Spark[] = [];
  private readonly flashes = new Map<string, number>();
  private readonly wobbles = new Map<string, number>();
  /** Per remote: the highest snapshot health since its last flash. */
  private readonly health = new Map<string, number>();
  private readonly seen = new Map<string, number>();
  private frameNo = 0;
  private counts: Counts = { glows: 0, sparks: 0, rings: 0, targets: 0 };
  private flashed = 0;
  private sparked = 0;
  private wobbled = 0;

  /** A landed hit: `id`'s body flashes red. */
  flash(id: string): void {
    this.flashes.set(id, 0);
    this.flashed++;
  }

  /** A block at (x, y) on a body (or egg) of `radius`: a spark flies. */
  spark(x: number, y: number, radius: number): void {
    if (this.sparks.length >= 8) this.sparks.shift();
    this.sparks.push({ x, y, size: radius * TELEGRAPH.sparkRadii, age: 0 });
    this.sparked++;
  }

  /** A stagger: `id`'s drawn heading wobbles. */
  wobble(id: string): void {
    this.wobbles.set(id, 0);
    this.wobbled++;
  }

  /**
   * A remote's newest snapshot health (a share of its maximum): a drop of `healthDrop` from the
   * highest seen since its last flash flashes it, so a trickle of damage flashes now and then.
   */
  watchHealth(id: string, health: number): void {
    this.seen.set(id, this.frameNo);
    const top = this.health.get(id);
    if (top === undefined || health > top) {
      this.health.set(id, health);
      return;
    }
    if (top - health >= TELEGRAPH.healthDrop) {
      this.health.set(id, health);
      this.flash(id);
    }
  }

  /** How red `id` is drawn now, 0..1. */
  hurt(id: string): number {
    const age = this.flashes.get(id);
    if (age === undefined) return 0;
    return TELEGRAPH.flashPeak * Math.max(0, 1 - age / TELEGRAPH.flashSeconds);
  }

  /** How far `id`'s drawn heading turns now (rad): none under reduced motion. */
  wobbleOf(id: string, reduced: boolean): number {
    const age = this.wobbles.get(id);
    if (reduced || age === undefined) return 0;
    const left = Math.max(0, 1 - age / TELEGRAPH.wobbleSeconds);
    return TELEGRAPH.wobbleRad * left * Math.sin(2 * Math.PI * TELEGRAPH.wobbleHz * age);
  }

  /** Advances the flashes, wobbles and sparks by `dt` seconds. */
  update(dt: number): void {
    const step = Math.max(0, dt);
    for (const [id, age] of this.flashes) {
      if (age + step >= TELEGRAPH.flashSeconds) this.flashes.delete(id);
      else this.flashes.set(id, age + step);
    }
    for (const [id, age] of this.wobbles) {
      if (age + step >= TELEGRAPH.wobbleSeconds) this.wobbles.delete(id);
      else this.wobbles.set(id, age + step);
    }
    let live = 0;
    for (const s of this.sparks) {
      s.age += step;
      if (s.age < TELEGRAPH.sparkSeconds) this.sparks[live++] = s;
    }
    this.sparks.length = live;
  }

  /** Starts this frame's marks; remotes no longer watched are forgotten. */
  begin(): void {
    this.frameNo++;
    this.used = 0;
    this.counts.glows = 0;
    this.counts.rings = 0;
    this.counts.sparks = 0;
    this.counts.targets = 0;
    if (this.seen.size > 0 && this.frameNo % 60 === 0) {
      for (const [id, at] of this.seen) {
        if (this.frameNo - at < 60) continue;
        this.seen.delete(id);
        this.health.delete(id);
      }
    }
  }

  /**
   * A windup of strength `glow` (`windupGlow`) on a body at (x, y) facing `heading`: its front
   * glows, and so do its weapon tips, `reach` body radii out across the half-angle `arc`.
   */
  glow(
    x: number,
    y: number,
    heading: number,
    radius: number,
    reach: number,
    arc: number,
    glow: number,
  ): void {
    if (glow <= 0) return;
    const front = TELEGRAPH.frontRadii * radius;
    this.add(
      'glow',
      x + Math.cos(heading) * front,
      y + Math.sin(heading) * front,
      TELEGRAPH.glowRadii * radius,
      glow,
    );
    if (reach < TELEGRAPH.tipReach) return;
    const out = reach * radius * 0.95;
    const size = TELEGRAPH.tipRadii * radius;
    if (arc < TELEGRAPH.oneTipArc) {
      this.add('glow', x + Math.cos(heading) * out, y + Math.sin(heading) * out, size, glow);
      return;
    }
    for (const side of SIDES) {
      const a = heading + side * arc;
      this.add('glow', x + Math.cos(a) * out, y + Math.sin(a) * out, size, glow);
    }
  }

  /** A creature fighting in another fight: its faint ring. */
  ring(x: number, y: number, radius: number): void {
    this.add('ring', x, y, TELEGRAPH.ringRadii * radius, TELEGRAPH.ringAlpha);
  }

  /** The player's target in a fight (M7 T15): a bracketed ring, brighter when the player chose it. */
  target(x: number, y: number, radius: number, chosen: boolean): void {
    const value = chosen ? TELEGRAPH.targetChosen : TELEGRAPH.targetDefault;
    this.add('target', x, y, TELEGRAPH.targetRadii * radius, value);
  }

  /** This frame's marks, the running sparks last. The array and its marks are reused. */
  end(): readonly TelegraphMark[] {
    for (const s of this.sparks)
      this.add('spark', s.x, s.y, s.size, s.age / TELEGRAPH.sparkSeconds);
    this.marks.length = this.used;
    return this.marks;
  }

  info(): TelegraphInfo {
    return {
      ...this.counts,
      flashes: this.flashes.size,
      wobbles: this.wobbles.size,
      flashed: this.flashed,
      sparked: this.sparked,
      wobbled: this.wobbled,
    };
  }

  private add(kind: TelegraphKind, x: number, y: number, size: number, value: number): void {
    if (this.used >= TELEGRAPH.capacity) return;
    let mark = this.marks[this.used];
    if (!mark) {
      mark = { kind, x, y, size, value };
      this.marks[this.used] = mark;
    } else {
      mark.kind = kind;
      mark.x = x;
      mark.y = y;
      mark.size = size;
      mark.value = value;
    }
    this.used++;
    this.counts[COUNTED[kind]]++;
  }
}

/** The marks as instanced quads; the shader draws each kind. */
export class TelegraphLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = telegraphMaterial();
  private readonly drawn: Counts = { glows: 0, sparks: 0, rings: 0, targets: 0 };

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, TELEGRAPH.capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  set(marks: readonly TelegraphMark[]): void {
    const n = Math.min(marks.length, TELEGRAPH.capacity);
    const { drawn } = this;
    drawn.glows = 0;
    drawn.sparks = 0;
    drawn.rings = 0;
    drawn.targets = 0;
    for (let i = 0; i < n; i++) {
      const m = marks[i] as TelegraphMark;
      drawn[COUNTED[m.kind]]++;
      const phase = KIND[m.kind] + Math.min(Math.max(m.value, 0), 0.999);
      writeInstance(this.mesh.instanceMatrix.array, i, m.x, m.y, m.size, 0, phase);
    }
    this.mesh.count = n;
    // Most frames have none: skip the upload and the draw call.
    this.mesh.visible = n > 0;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The marks drawn by the last `set`, by kind. */
  counts(): Counts {
    return { ...this.drawn };
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }
}

// The egg (M6 T20): the beacon reveal, the carried egg on its tether and the hatch. `EggReveal` is
// the reveal's timeline on wall-clock time, `EggTether` the spring that drags a carried egg behind
// its parent, and `EggLayer` draws every egg and tether as instanced quads in one call. All of it is
// presentation: nothing here feeds back into the sim.

import * as THREE from 'three';
import type { RarityTier } from '../genome/rarity';
import { clamp } from '../sim/math';
import { writeInstance } from './instances';
import { eggMaterial, setUniform } from './materials';

export type EggPhase = 'none' | 'waiting' | 'cracking' | 'revealed';

type ByTier = Readonly<Record<RarityTier, number>>;

/** Presentation constants for the egg (DESIGN §10). */
export const EGG = {
  /** A beacon later than this stops the build-up: the egg settles into a calm idle. */
  settleMs: 10_000,
  /** How long the build-up takes to calm down once settled. */
  settleBlendMs: 1500,
  /** The wiggle at the start of the wait and at `settleMs`: frequency (Hz) and swing (radians). */
  wiggleHz: { from: 0.6, to: 3.2 },
  wiggleAmp: { from: 0.1, to: 0.3 },
  /** The calm idle after a long wait. */
  idleHz: 0.35,
  idleAmp: 0.05,
  idleGlow: 0.55,
  /** The inner light while waiting: from dim to full at `settleMs`. */
  glow: { from: 0.25, to: 1 },
  /** The trembling while the shell cracks. */
  crackHz: 7,
  crackAmp: { from: 0.05, to: 0.2 },
  /** A held crack (waiting for the hub to hatch the child) stops short of breaking. */
  heldCrack: 0.85,
  /** The flourish by the child's rarity: crack time, burst time, burst light and rings. */
  crackMs: { common: 900, uncommon: 1200, rare: 1600, exotic: 2100 } as ByTier,
  burstMs: { common: 600, uncommon: 800, rare: 1000, exotic: 1500 } as ByTier,
  burstLight: { common: 0.35, uncommon: 0.6, rare: 0.9, exotic: 1.6 } as ByTier,
  burstRings: { common: 1, uncommon: 2, rare: 3, exotic: 5 } as ByTier,
  /** Exotic bursts run the effects at this share of real time for `slowMs`. */
  slowExotic: 0.3,
  slowMs: 900,
  /** After a reveal that does not open, the cracks heal over this long into the carried look. */
  healMs: 700,
  /** A hatched creature pops out of the shell over this long, overshooting a little. */
  emergeMs: 450,
  /** The carried egg's faint glow by the child's rarity; peers see `plainGlow`. */
  carriedGlow: { common: 0.16, uncommon: 0.28, rare: 0.4, exotic: 0.56 } as ByTier,
  plainGlow: 0.3,
  /** Reduced motion breathes the egg's opacity instead of shaking it. */
  fadeHz: 0.5,
  /** The visited phases kept for the test hook. */
  visitedKept: 16,
} as const;

/** The egg's tint by the child's rarity (the badge colours); `plain` is a peer's egg or an unknown child. */
export const EGG_TINT: Readonly<Record<RarityTier | 'plain', readonly [number, number, number]>> = {
  plain: [0.7, 0.92, 0.88],
  common: [0.8, 0.9, 0.95],
  uncommon: [0.55, 0.91, 0.54],
  rare: [0.48, 0.78, 1],
  exotic: [1, 0.82, 0.48],
};

/** How one egg is drawn this frame. */
export interface EggPose {
  shown: boolean;
  /** The wiggle, in radians (always 0 under reduced motion). */
  angle: number;
  /** 0..1, the inner light. */
  glow: number;
  /** 0..1, the shell's opacity (it fades under reduced motion and as an opened shell flies apart). */
  alpha: number;
  /** 0..1, how far the cracks have run. */
  crack: number;
  /** 0..1, the burst's progress (0 before it). */
  burst: number;
  /** The burst's brightness for the child's rarity. */
  light: number;
  /** 0..1, how far the halves of an opened shell fly apart (0 for a reveal and under reduced motion). */
  spread: number;
  tier: RarityTier | null;
}

export const emptyPose = (): EggPose => ({
  shown: false,
  angle: 0,
  glow: 0,
  alpha: 0,
  crack: 0,
  burst: 0,
  light: 0,
  spread: 0,
  tier: null,
});

const TAU = Math.PI * 2;
const INSTANCE_ATTRIBUTES = ['aEggA', 'aEggB', 'aEggTint'] as const;
const clamp01 = (v: number): number => clamp(v, 0, 1);
const smooth = (v: number): number => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const easeOutBack = (t: number): number => {
  const c = 1.6;
  const u = t - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
};

export interface CrackOptions {
  /** The child's rarity, when it is known yet (a genesis learns it after the check). */
  tier: RarityTier | null;
  /** The shell breaks open and a creature grows out (a genesis or a hatch), rather than flashing. */
  opens: boolean;
  /** Keep cracking until `release`: the creature to grow out is not there yet. */
  hold?: boolean;
}

/**
 * The reveal's timeline: `waiting` while the beacon is awaited (a wiggle that builds for 10 s, then
 * a calm idle), `cracking` once it arrives, and `revealed` from the burst on. Times are wall-clock
 * milliseconds, so the reveal never depends on the sim's speed.
 */
export class EggReveal {
  phase: EggPhase = 'none';
  /** The phases entered, oldest first (the last 16), for the test hook. */
  readonly visited: EggPhase[] = [];
  tier: RarityTier | null = null;
  opens = false;
  private waitAt = 0;
  private crackAt = 0;
  private burstAt = 0;
  private held = false;
  private releasedAt = 0;

  /** The beacon is awaited: the egg appears (a no-op while it already waits). */
  wait(now: number): void {
    if (this.phase === 'waiting') return;
    this.enter('waiting');
    this.waitAt = now;
    this.tier = null;
    this.opens = false;
  }

  /** The beacon arrived (or a hatch began): the shell cracks, and bursts after the tier's crack time. */
  crack(now: number, options: CrackOptions): void {
    if (this.phase === 'cracking') {
      // A hatch that starts mid-crack takes over the burst: the child must grow out of it.
      if (options.opens && !this.opens) {
        this.opens = true;
        this.held = options.hold === true;
        this.releasedAt = 0;
      }
      return;
    }
    this.enter('cracking');
    this.crackAt = now;
    this.tier = options.tier;
    this.opens = options.opens;
    this.held = options.hold === true;
    this.releasedAt = 0;
  }

  /** Learns the child's rarity after the crack began. */
  setTier(tier: RarityTier): void {
    this.tier = tier;
  }

  /** A held crack may burst: the creature to grow out of it is there. */
  release(now: number): void {
    if (!this.held) return;
    this.held = false;
    this.releasedAt = now;
  }

  /** Back to no egg (a failed hatch, a new life). */
  reset(): void {
    if (this.phase !== 'none') this.enter('none');
    this.tier = null;
    this.opens = false;
    this.held = false;
  }

  /** Advances the phase; true on the frame the shell bursts. */
  update(now: number): boolean {
    if (this.phase !== 'cracking' || this.held) return false;
    const due = Math.max(this.crackAt + EGG.crackMs[this.tierOr()], this.releasedAt);
    if (now < due) return false;
    this.enter('revealed');
    this.burstAt = now;
    return true;
  }

  /** Effect time since the burst: the first `slowMs` of an exotic burst run slow. */
  private burstClock(now: number): number {
    const real = Math.max(0, now - this.burstAt);
    if (this.tierOr() !== 'exotic') return real;
    const slow = Math.min(real, EGG.slowMs);
    return slow * EGG.slowExotic + (real - slow);
  }

  /** The share of real time the effects run at now (below 1 during an exotic burst's slow motion). */
  slowFactor(now: number, reduced = false): number {
    if (reduced || this.phase !== 'revealed' || this.tierOr() !== 'exotic') return 1;
    return now - this.burstAt < EGG.slowMs ? EGG.slowExotic : 1;
  }

  /** Whether the burst has played out (and an opened shell is gone). */
  done(now: number): boolean {
    return this.phase === 'revealed' && this.burstClock(now) >= EGG.burstMs[this.tierOr()];
  }

  /**
   * The drawn size of the creature that grows out of an opened shell: 0 until the burst, then a
   * pop that overshoots and settles at 1. Without an opening reveal it is 1.
   */
  emerge(now: number): number {
    if (!this.opens) return 1;
    if (this.phase === 'cracking') return 0;
    if (this.phase !== 'revealed') return 1;
    const t = clamp01((now - this.burstAt) / EGG.emergeMs);
    return t >= 1 ? 1 : Math.max(0, easeOutBack(t));
  }

  /** Fills `out` with the reveal egg's pose; `shown` is false when the reveal draws nothing. */
  pose(now: number, reduced: boolean, out: EggPose): EggPose {
    out.tier = this.tier;
    out.burst = 0;
    out.light = 0;
    out.spread = 0;
    out.crack = 0;
    out.angle = 0;
    out.alpha = 1;
    switch (this.phase) {
      case 'none':
        out.shown = false;
        out.glow = 0;
        break;
      case 'waiting':
        this.waitingPose(now - this.waitAt, reduced, out);
        break;
      case 'cracking':
        this.crackingPose(now - this.crackAt, reduced, out);
        break;
      case 'revealed':
        this.burstPose(now, reduced, out);
        break;
    }
    return out;
  }

  private waitingPose(ms: number, reduced: boolean, out: EggPose): void {
    out.shown = true;
    const t = Math.max(0, ms) / 1000;
    const settle = EGG.settleMs / 1000;
    const blend = EGG.settleBlendMs / 1000;
    const { from: f0, to: f1 } = EGG.wiggleHz;
    const { from: a0, to: a1 } = EGG.wiggleAmp;
    let phase: number;
    let amp: number;
    let glow: number;
    if (t <= settle) {
      // Frequency rises linearly, so the phase is its integral.
      const k = t / settle;
      phase = TAU * (f0 * t + ((f1 - f0) * t * t) / (2 * settle));
      amp = a0 + (a1 - a0) * k;
      glow = EGG.glow.from + (EGG.glow.to - EGG.glow.from) * k;
    } else {
      // Settled: the frequency eases down to the idle's over the blend, with the phase kept continuous.
      const atSettle = TAU * (f0 * settle + ((f1 - f0) * settle) / 2);
      const tau = t - settle;
      const u = Math.min(tau, blend);
      phase =
        atSettle +
        TAU * (f1 * u + ((EGG.idleHz - f1) * u * u) / (2 * blend)) +
        TAU * EGG.idleHz * Math.max(0, tau - blend);
      const s = smooth(tau / blend);
      amp = a1 + (EGG.idleAmp - a1) * s;
      const breathe = 0.08 * Math.sin(TAU * EGG.idleHz * tau);
      glow = EGG.glow.to + (EGG.idleGlow - EGG.glow.to) * s + breathe * s;
    }
    out.glow = glow;
    if (reduced) {
      out.alpha = 0.7 + 0.3 * Math.cos(TAU * EGG.fadeHz * t);
    } else {
      out.angle = amp * Math.sin(phase);
    }
  }

  private crackingPose(ms: number, reduced: boolean, out: EggPose): void {
    out.shown = true;
    const t = Math.max(0, ms);
    const full = EGG.crackMs[this.tierOr()];
    const k = clamp01(t / full);
    out.crack = this.held ? Math.min(EGG.heldCrack, smooth(k)) : smooth(k);
    out.glow = EGG.glow.to * (0.8 + 0.4 * out.crack);
    if (reduced) {
      out.alpha = 1;
    } else {
      const amp = EGG.crackAmp.from + (EGG.crackAmp.to - EGG.crackAmp.from) * out.crack;
      out.angle = amp * Math.sin((TAU * EGG.crackHz * t) / 1000);
    }
  }

  private burstPose(now: number, reduced: boolean, out: EggPose): void {
    const tier = this.tierOr();
    const b = clamp01(this.burstClock(now) / EGG.burstMs[tier]);
    out.light = EGG.burstLight[tier] * (reduced ? 0.5 : 1);
    if (this.opens) {
      out.shown = b < 1;
      out.burst = b;
      out.crack = 1;
      out.glow = EGG.glow.to * (1 - b);
      out.alpha = 1 - smooth(b);
      out.spread = reduced ? 0 : smooth(b);
      return;
    }
    // A reveal: the light bursts out of the cracks, then they heal into the carried egg.
    out.shown = true;
    out.burst = b;
    const heal = clamp01((now - this.burstAt - EGG.burstMs[tier]) / EGG.healMs);
    out.crack = 1 - smooth(heal);
    const carried = EGG.carriedGlow[tier];
    out.glow = EGG.glow.to + (carried - EGG.glow.to) * smooth(Math.max(b, heal));
  }

  private tierOr(): RarityTier {
    return this.tier ?? 'common';
  }

  private enter(phase: EggPhase): void {
    this.phase = phase;
    if (this.visited.push(phase) > EGG.visitedKept) this.visited.shift();
  }
}

/** The pose of a carried egg at rest: the owner's glows by its child's rarity, a peer's plainly. */
export function carriedPose(tier: RarityTier | null, out: EggPose): EggPose {
  out.shown = true;
  out.angle = 0;
  out.glow = tier ? EGG.carriedGlow[tier] : EGG.plainGlow;
  out.alpha = 1;
  out.crack = 0;
  out.burst = 0;
  out.light = 0;
  out.spread = 0;
  out.tier = tier;
  return out;
}

/** The parent an egg hangs behind: its centre, heading (radians) and core radius in wu. */
export interface TetherParent {
  x: number;
  y: number;
  heading: number;
  radius: number;
}

/** The tether, in parent radii: the gap between the body and the egg, and the most it stretches. */
export const TETHER = {
  gap: 0.45,
  stretch: 1.5,
  /** Spring stiffness (1/s²) and damping (1/s): a little bob, no wobble that lasts. */
  stiffness: 55,
  damping: 10,
  /** A jump this many parent radii away (a teleport, a respawn) snaps the egg instead. */
  snapRadii: 12,
  /** The longest step the spring integrates at once. */
  maxStep: 1 / 120,
} as const;

/** A carried egg on a short tether behind its parent, following on a spring (render only). */
export class EggTether {
  x = 0;
  y = 0;
  private vx = 0;
  private vy = 0;
  private placed = false;

  /** Rest length from the parent's centre to the egg's centre. */
  static rest(parent: TetherParent, eggRadius: number): number {
    return parent.radius * (1 + TETHER.gap) + eggRadius;
  }

  /** Puts the egg at a point, at rest. */
  pin(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.vx = 0;
    this.vy = 0;
    this.placed = true;
  }

  /** Forgets the egg's place: the next `follow` puts it behind the parent at once. */
  drop(): void {
    this.placed = false;
  }

  /** Advances the spring by `dt` seconds towards the point behind the parent. */
  follow(dt: number, parent: TetherParent, eggRadius: number): void {
    const rest = EggTether.rest(parent, eggRadius);
    const tx = parent.x - Math.cos(parent.heading) * rest;
    const ty = parent.y - Math.sin(parent.heading) * rest;
    const far = Math.hypot(this.x - parent.x, this.y - parent.y) > TETHER.snapRadii * parent.radius;
    if (!this.placed || far || !Number.isFinite(this.x + this.y)) {
      this.pin(tx, ty);
      return;
    }
    let left = Math.min(Math.max(dt, 0), 0.25);
    while (left > 1e-6) {
      const h = Math.min(left, TETHER.maxStep);
      left -= h;
      this.vx += (TETHER.stiffness * (tx - this.x) - TETHER.damping * this.vx) * h;
      this.vy += (TETHER.stiffness * (ty - this.y) - TETHER.damping * this.vy) * h;
      this.x += this.vx * h;
      this.y += this.vy * h;
    }
    // The tether is short: the egg never trails more than `stretch` rest lengths behind.
    const dx = this.x - parent.x;
    const dy = this.y - parent.y;
    const d = Math.hypot(dx, dy);
    const max = rest * TETHER.stretch;
    if (d > max) {
      this.x = parent.x + (dx / d) * max;
      this.y = parent.y + (dy / d) * max;
    }
    // Nor does it sink into the body.
    const min = parent.radius + eggRadius * 0.6;
    if (d < min && d > 1e-9) {
      this.x = parent.x + (dx / d) * min;
      this.y = parent.y + (dy / d) * min;
    }
  }
}

/** One egg for the layer: where, how big, how it looks and, when carried, the parent it hangs from. */
export interface EggView {
  x: number;
  y: number;
  /** The egg's half-height in wu. */
  radius: number;
  /** Where the egg's narrow top points, in radians (π/2 is up the screen); the pose's wiggle adds to it. */
  heading: number;
  pose: EggPose;
  /** A stable 0..1 per egg, so eggs shimmer out of step. */
  seed: number;
  /** The parent the tether runs to; null draws no tether. */
  parent: TetherParent | null;
}

/** Eggs and tethers drawn at once: the player's, 24 peers' and their tethers. */
export const EGG_CAPACITY = 72;
/** The quad's half-extent in egg half-heights: room for the halo and for an opened shell's halves. */
export const EGG_QUAD = 2.4;

/** Every egg and tether as instanced quads; the shader draws the shell, cracks, glow and burst. */
export class EggLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = eggMaterial();
  /** Per instance: kind (0 egg, 1 tether), glow, crack, burst. */
  private readonly a = new Float32Array(EGG_CAPACITY * 4);
  /** Per instance: alpha, burst light, spread, seed. */
  private readonly b = new Float32Array(EGG_CAPACITY * 4);
  private readonly tint = new Float32Array(EGG_CAPACITY * 3);
  private eggs = 0;

  constructor() {
    this.geometry.setAttribute('aEggA', new THREE.InstancedBufferAttribute(this.a, 4));
    this.geometry.setAttribute('aEggB', new THREE.InstancedBufferAttribute(this.b, 4));
    this.geometry.setAttribute('aEggTint', new THREE.InstancedBufferAttribute(this.tint, 3));
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, EGG_CAPACITY);
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Rewrites the instances from this frame's eggs; with none it issues no draw call. */
  set(eggs: readonly EggView[], time: number): void {
    const matrix = this.mesh.instanceMatrix.array;
    let n = 0;
    this.eggs = 0;
    for (const egg of eggs) {
      const { pose } = egg;
      if (!pose.shown || n >= EGG_CAPACITY) continue;
      const tint = EGG_TINT[pose.tier ?? 'plain'];
      const p = egg.parent;
      if (p && n + 1 < EGG_CAPACITY) {
        // The tether: from the parent's skin to the egg's shell, as a thin stretched quad.
        const dx = egg.x - p.x;
        const dy = egg.y - p.y;
        const d = Math.hypot(dx, dy);
        const from = p.radius * 0.85;
        const to = d - egg.radius * 0.8;
        if (to > from) {
          const ux = dx / d;
          const uy = dy / d;
          const half = (to - from) / 2;
          const mid = from + half;
          const width = Math.max(egg.radius * 0.09, 0.3);
          const o = n * 16;
          matrix[o] = ux * half;
          matrix[o + 1] = uy * half;
          matrix[o + 2] = 0;
          matrix[o + 3] = 0;
          matrix[o + 4] = -uy * width;
          matrix[o + 5] = ux * width;
          matrix[o + 6] = 0;
          matrix[o + 7] = 0;
          matrix[o + 8] = 0;
          matrix[o + 9] = 0;
          matrix[o + 10] = 1;
          matrix[o + 11] = 0;
          matrix[o + 12] = p.x + ux * mid;
          matrix[o + 13] = p.y + uy * mid;
          matrix[o + 14] = 0;
          matrix[o + 15] = 1;
          this.write(n, 1, pose, tint, egg.seed);
          n++;
        }
      }
      const angle = egg.heading - Math.PI / 2 + pose.angle;
      writeInstance(matrix, n, egg.x, egg.y, egg.radius * EGG_QUAD, angle, 1);
      this.write(n, 0, pose, tint, egg.seed);
      n++;
      this.eggs++;
    }
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n === 0) return;
    setUniform(this.material, 'uTime', time);
    this.mesh.instanceMatrix.needsUpdate = true;
    for (const name of INSTANCE_ATTRIBUTES) {
      (this.geometry.getAttribute(name) as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** Eggs (not tethers) drawn by the last `set`. */
  count(): number {
    return this.eggs;
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  private write(
    n: number,
    kind: number,
    pose: EggPose,
    tint: readonly [number, number, number],
    seed: number,
  ): void {
    const i = n * 4;
    this.a[i] = kind;
    this.a[i + 1] = pose.glow;
    this.a[i + 2] = pose.crack;
    this.a[i + 3] = pose.burst;
    this.b[i] = pose.alpha;
    this.b[i + 1] = pose.light;
    this.b[i + 2] = pose.spread;
    this.b[i + 3] = seed;
    const j = n * 3;
    this.tint[j] = tint[0];
    this.tint[j + 1] = tint[1];
    this.tint[j + 2] = tint[2];
  }
}

// The egg (M6 T20, M6b T11): the beacon reveal, the carried egg on its tether and the hatch.
// `EggReveal` is the reveal's timeline on wall-clock time, `EggTether` the spring that drags a
// carried egg behind its parent, and `EggLayer` draws every egg and tether as instanced quads in one
// call. All of it is presentation: nothing here feeds back into the sim.

import * as THREE from 'three';
import type { RarityTier } from '../genome/rarity';
import { clamp, lerp } from '../sim/math';
import { writeInstance } from './instances';
import { eggMaterial, setUniform } from './materials';

export type EggPhase = 'none' | 'waiting' | 'stirring' | 'cracking' | 'revealed';

type ByTier = Readonly<Record<RarityTier, number>>;

/** One twitch burst of the stir: its span as shares of the stir, and its swing in radians. */
export interface StirBurst {
  from: number;
  to: number;
  amp: number;
}

/** Presentation constants for the egg (DESIGN §10). */
export const EGG = {
  /** The egg drops into place over this long, from this many egg half-heights above it. */
  dropMs: 400,
  dropHeight: 1.4,
  /** While it waits it rests, its light breathing slowly around `restGlow`. */
  restGlow: 0.42,
  breatheHz: 0.2,
  breatheGlow: 0.08,
  /** A poke (a click on the egg, or Space during a genesis): one damped wobble. */
  poke: { amp: 0.22, hz: 2.2, decayMs: 250, lastsMs: 2000 },
  /** The most the wobbles of a flurry of pokes swing together. */
  pokeMax: 0.2,
  pokesKept: 3,
  /** During a genesis the egg leans at most this far toward a cursor within `leanReach` half-heights. */
  lean: 0.05,
  leanReach: 3,
  /** After this long without a beacon a small line says the egg is waiting for it. */
  waitLineMs: 10_000,
  /** The stir once the beacon arrives: its length by the child's rarity and its three bursts. */
  stirMs: { common: 1200, uncommon: 1400, rare: 1600, exotic: 1800 } as ByTier,
  stirBursts: [
    { from: 0, to: 0.16, amp: 0.06 },
    { from: 0.42, to: 0.62, amp: 0.11 },
    { from: 0.76, to: 1, amp: 0.17 },
  ] as readonly StirBurst[],
  stirHz: 12,
  /** Each burst flashes the light by this much (times its number); the rarity's colour leaks over this share of the stir. */
  stirFlash: 0.12,
  leakSpan: 0.45,
  /** The inner light in full (a crack runs from 80% of it to 120%). */
  glow: { to: 1 },
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
  /** Shell shards thrown out by the burst, and light rays for the rarer children. */
  burstShards: { common: 5, uncommon: 6, rare: 8, exotic: 10 } as ByTier,
  burstRays: { common: 0, uncommon: 0, rare: 6, exotic: 10 } as ByTier,
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
  /** Reduced motion pulses the egg's light (and breathes its opacity) instead of moving it. */
  fadeHz: 0.5,
  pulseGlow: 0.16,
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
  /** How far above its place the egg is drawn while it drops in, in egg half-heights. */
  lift: number;
  /** 0..1, how much of the rarity's colour shows (a stir leaks it in); the rest is the plain tint. */
  tint: number;
  /** The burst's shell shards and light rays (0 for none). */
  shards: number;
  rays: number;
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
  lift: 0,
  tint: 1,
  shards: 0,
  rays: 0,
  tier: null,
});

const TAU = Math.PI * 2;
const INSTANCE_ATTRIBUTES = ['aEggA', 'aEggB', 'aEggC', 'aEggTint'] as const;
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
 * The reveal's timeline (M6b T11): `waiting` while the beacon is awaited (the egg drops in, then
 * rests and answers pokes), `stirring` once it arrives (three twitch bursts as the rarity's colour
 * leaks out), `cracking`, and `revealed` from the burst on. Times are wall-clock milliseconds, so
 * the reveal never depends on the sim's speed.
 */
export class EggReveal {
  phase: EggPhase = 'none';
  /** The phases entered, oldest first (the last 16), for the test hook. */
  readonly visited: EggPhase[] = [];
  tier: RarityTier | null = null;
  opens = false;
  private waitAt = 0;
  private stirAt = 0;
  private crackAt = 0;
  private burstAt = 0;
  private held = false;
  /** The times of the last few pokes, as a ring. */
  private readonly pokes: number[] = Array.from({ length: EGG.pokesKept }, () => Number.NaN);
  private pokeNext = 0;

  /** The beacon is awaited: the egg drops in (a no-op while it already waits). */
  wait(now: number): void {
    if (this.phase === 'waiting') return;
    this.enter('waiting');
    this.waitAt = now;
    this.tier = null;
    this.opens = false;
    this.pokes.fill(Number.NaN);
  }

  /** A click on the waiting egg (or Space during a genesis): one damped wobble. False when it is not waiting. */
  poke(now: number): boolean {
    if (this.phase !== 'waiting') return false;
    this.pokes[this.pokeNext] = now;
    this.pokeNext = (this.pokeNext + 1) % this.pokes.length;
    return true;
  }

  /** Whether the small "Waiting for the beacon…" line shows. */
  waitLine(now: number): boolean {
    return this.phase === 'waiting' && now - this.waitAt >= EGG.waitLineMs;
  }

  /**
   * The beacon arrived: the egg stirs for its rarity's stir time, then cracks and bursts. During a
   * stir or a crack it is `crack`'s take-over instead.
   */
  stir(now: number, options: CrackOptions): void {
    if (this.takeOver(options)) return;
    this.enter('stirring');
    this.stirAt = now;
    this.start(options);
  }

  /** The shell cracks at once (a hatch with H), and bursts after the tier's crack time. */
  crack(now: number, options: CrackOptions): void {
    if (this.takeOver(options)) return;
    this.enter('cracking');
    this.crackAt = now;
    this.start(options);
  }

  /** A click or Enter while it stirs or cracks: the burst comes now (or at the release of a held egg). */
  skip(now: number): boolean {
    if (this.phase === 'stirring') this.enter('cracking');
    else if (this.phase !== 'cracking') return false;
    this.crackAt = now - EGG.crackMs[this.tierOr()];
    return true;
  }

  /** Whether the stir and crack times have passed: a held egg would burst now if released. */
  ripe(now: number): boolean {
    const crackAt =
      this.phase === 'stirring'
        ? this.stirAt + EGG.stirMs[this.tierOr()]
        : this.phase === 'cracking'
          ? this.crackAt
          : Number.NaN;
    return now >= crackAt + EGG.crackMs[this.tierOr()];
  }

  /** Learns the child's rarity after the stir or crack began. */
  setTier(tier: RarityTier): void {
    this.tier = tier;
  }

  /** A held crack may burst (at its crack time, or at once once that has passed): the creature to grow out of it is there. */
  release(): void {
    this.held = false;
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
    if (this.phase === 'stirring') {
      const end = this.stirAt + EGG.stirMs[this.tierOr()];
      if (now < end) return false;
      this.enter('cracking');
      this.crackAt = end;
    }
    if (this.phase !== 'cracking' || this.held) return false;
    if (now < this.crackAt + EGG.crackMs[this.tierOr()]) return false;
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
    if (this.phase === 'stirring' || this.phase === 'cracking') return 0;
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
    out.lift = 0;
    out.tint = 1;
    out.shards = 0;
    out.rays = 0;
    switch (this.phase) {
      case 'none':
        out.shown = false;
        out.glow = 0;
        break;
      case 'waiting':
        this.waitingPose(now, reduced, out);
        break;
      case 'stirring':
        this.stirringPose(now - this.stirAt, reduced, out);
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

  private waitingPose(now: number, reduced: boolean, out: EggPose): void {
    out.shown = true;
    const ms = Math.max(0, now - this.waitAt);
    const t = ms / 1000;
    if (reduced) {
      // No drop and no wobble: the light pulses and the shell breathes.
      out.glow = EGG.restGlow + EGG.pulseGlow * Math.sin(TAU * EGG.fadeHz * t);
      out.alpha = 0.7 + 0.3 * Math.cos(TAU * EGG.fadeHz * t);
      return;
    }
    // The drop: it falls into place as if under its own weight, fading in as it comes.
    const k = clamp01(ms / EGG.dropMs);
    out.lift = k >= 1 ? 0 : EGG.dropHeight * (1 - k * k);
    out.alpha = smooth(k * 2);
    out.glow = EGG.restGlow + EGG.breatheGlow * Math.sin(TAU * EGG.breatheHz * t);
    // At rest, but for the wobbles of recent pokes.
    const { amp, hz, decayMs, lastsMs } = EGG.poke;
    let angle = 0;
    for (const at of this.pokes) {
      const since = now - at;
      if (!(since >= 0 && since < lastsMs)) continue;
      angle += amp * Math.exp(-since / decayMs) * Math.sin((TAU * hz * since) / 1000);
    }
    out.angle = clamp(angle, -EGG.pokeMax, EGG.pokeMax);
  }

  private stirringPose(ms: number, reduced: boolean, out: EggPose): void {
    out.shown = true;
    const span = EGG.stirMs[this.tierOr()];
    const u = clamp01(Math.max(0, ms) / span);
    // Which burst, and how far into it (a sine envelope, so each starts and ends still).
    let envelope = 0;
    let amp = 0;
    let index = 0;
    for (let i = 0; i < EGG.stirBursts.length; i++) {
      const b = EGG.stirBursts[i] as StirBurst;
      if (u < b.from || u > b.to) continue;
      envelope = Math.sin((Math.PI * (u - b.from)) / (b.to - b.from));
      amp = b.amp;
      index = i + 1;
    }
    // The light gathers towards the crack's, and each burst flashes it, harder each time.
    const flash = EGG.stirFlash * index * envelope;
    const base = lerp(EGG.restGlow, 0.8 * EGG.glow.to, u);
    out.glow = base + (reduced ? 2.4 * flash : flash);
    // From the second burst, the rarity's colour leaks through.
    const second = EGG.stirBursts[1]?.from ?? 0;
    out.tint = u < second ? 0 : smooth((u - second) / EGG.leakSpan);
    if (!reduced) out.angle = amp * envelope * Math.sin((TAU * EGG.stirHz * ms) / 1000);
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
    out.rays = EGG.burstRays[tier];
    out.shards = reduced ? 0 : EGG.burstShards[tier];
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

  /** A hatch that starts mid-stir or mid-crack takes over the burst: the child must grow out of it. */
  private takeOver(options: CrackOptions): boolean {
    if (this.phase !== 'stirring' && this.phase !== 'cracking') return false;
    if (options.opens && !this.opens) {
      this.opens = true;
      this.held = options.hold === true;
    }
    return true;
  }

  private start(options: CrackOptions): void {
    this.tier = options.tier;
    this.opens = options.opens;
    this.held = options.hold === true;
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
  out.lift = 0;
  out.tint = 1;
  out.shards = 0;
  out.rays = 0;
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
  /** Per instance: the burst's shards and rays. */
  private readonly c = new Float32Array(EGG_CAPACITY * 2);
  private readonly tint = new Float32Array(EGG_CAPACITY * 3);
  private eggs = 0;

  constructor() {
    this.geometry.setAttribute('aEggA', new THREE.InstancedBufferAttribute(this.a, 4));
    this.geometry.setAttribute('aEggB', new THREE.InstancedBufferAttribute(this.b, 4));
    this.geometry.setAttribute('aEggC', new THREE.InstancedBufferAttribute(this.c, 2));
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
          this.write(n, 1, pose, egg.seed);
          n++;
        }
      }
      const angle = egg.heading - Math.PI / 2 + pose.angle;
      // A dropping egg is drawn above its place (π/2, up the screen, is +y).
      const y = egg.y + pose.lift * egg.radius;
      writeInstance(matrix, n, egg.x, y, egg.radius * EGG_QUAD, angle, 1);
      this.write(n, 0, pose, egg.seed);
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

  private write(n: number, kind: number, pose: EggPose, seed: number): void {
    const i = n * 4;
    this.a[i] = kind;
    this.a[i + 1] = pose.glow;
    this.a[i + 2] = pose.crack;
    this.a[i + 3] = pose.burst;
    this.b[i] = pose.alpha;
    this.b[i + 1] = pose.light;
    this.b[i + 2] = pose.spread;
    this.b[i + 3] = seed;
    this.c[n * 2] = pose.shards;
    this.c[n * 2 + 1] = pose.rays;
    // The rarity's colour over the plain one, by how much of it shows (a stir leaks it in).
    const plain = EGG_TINT.plain;
    const tier = pose.tier ? EGG_TINT[pose.tier] : plain;
    const k = pose.tier ? pose.tint : 0;
    const j = n * 3;
    for (let m = 0; m < 3; m++) {
      this.tint[j + m] = lerp(plain[m] as number, tier[m] as number, k);
    }
  }
}

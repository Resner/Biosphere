// Ambient swarms (M11 T17, ADR 0062): a giant never links to players two or more tiers smaller, so
// it sees each one the directory reports in its area of interest as a faint cloud of motes at the
// reported place, drifting with the current. Every cloud stands for a real player (ADR 0014), and
// none can be touched. One `Points` draw for all of them; nothing is allocated per frame.

import * as THREE from 'three';
import { clamp, lerp, smoothstep, TAU } from '../sim/math';
import { swarmMaterial } from './materials';
import { ORIGIN } from './origin';

/** A swarm point as `near` gives it: x and y in wu. */
export type SwarmPoint = readonly [x: number, y: number];

/** The most clouds drawn at once (`SWARM_MAX`, the most a `near` lists). */
export const SWARM_CLOUDS = 64;
/** A cloud fades in, fades out and glides to a new report over this many seconds. */
export const SWARM_FADE_S = 1;
/** The motes in one cloud, by its seed. */
export const SWARM_MOTES = { min: 5, max: 9 } as const;
/** A point in the next `near` within this many wu of a cloud is the same player moved: it keeps its cloud. */
export const SWARM_MATCH_WU = 2048;
/** A cloud's radius and a mote's diameter in wu at a starter's scale; both grow with the look. */
const CLOUD_WU = 14;
const MOTE_WU = 3;

/** One cloud as drawn, for tests (`SwarmLayer.clouds`). */
export interface SwarmCloud {
  /** Its centre, wu. */
  x: number;
  y: number;
  /** 0 to 1: its fade in and out. */
  alpha: number;
  motes: number;
  /** Its layout's seed, from the place it was first reported. */
  seed: number;
}

interface Cloud {
  seed: number;
  motes: number;
  /** Where it glides from and to, in the water's frame (the place less the currents' carry then). */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  movedAt: number;
  bornAt: number;
  /** When it began to fade out, or infinity while its player is still in the swarm. */
  goneAt: number;
  /** Matched by the newest `near` (scratch for `report`). */
  kept: boolean;
}

/** A seed from a reported place, whole wu, so the same place lays out the same cloud on any page. */
function seedOf(x: number, y: number): number {
  let h = Math.imul(Math.round(x) | 0, 0x9e3779b1) ^ Math.imul(Math.round(y) | 0, 0x85ebca77);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}

/** The `k`th fraction in [0, 1) of a seed. */
function frac(seed: number, k: number): number {
  let h = (seed ^ Math.imul(k + 1, 0x632be5ab)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** The per-mote attributes, written every frame. */
const ATTRIBUTES = ['position', 'aSize', 'aAlpha'] as const;

export class SwarmLayer {
  readonly points: THREE.Points;
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material = swarmMaterial();
  private readonly positions: Float32Array;
  private readonly sizes: Float32Array;
  private readonly alphas: Float32Array;
  private readonly held: Cloud[] = [];
  /** The `near` list last taken: a new answer is a new array. */
  private last: readonly SwarmPoint[] | null = null;
  private drawn = 0;
  /** The last frame's time and currents' carry, for `clouds`. */
  private now = 0;
  private readonly flow = { x: 0, y: 0 };

  constructor() {
    const capacity = SWARM_CLOUDS * SWARM_MOTES.max;
    this.positions = new Float32Array(capacity * 3);
    this.sizes = new Float32Array(capacity);
    this.alphas = new Float32Array(capacity);
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1));
    this.geometry.setAttribute('aAlpha', new THREE.BufferAttribute(this.alphas, 1));
    this.geometry.setDrawRange(0, 0);
    this.points = new THREE.Points(this.geometry, this.material);
    this.points.visible = false;
  }

  /**
   * Draws the swarm at `time` (seconds): `swarm` is the newest `near`'s list, `flow` how far the
   * currents have carried the water (wu), `look` the look's scale and `pxPerWu` target pixels per wu.
   */
  update(
    swarm: readonly SwarmPoint[],
    time: number,
    flow: { readonly x: number; readonly y: number },
    look: number,
    pxPerWu: number,
  ): void {
    this.now = time;
    this.flow.x = flow.x;
    this.flow.y = flow.y;
    if (swarm !== this.last) {
      this.last = swarm;
      this.report(swarm, time, flow);
    }
    const clouds = this.held;
    for (let i = clouds.length - 1; i >= 0; i--) {
      const c = clouds[i] as Cloud;
      if (c.goneAt <= time && this.alphaOf(c, time) <= 0) clouds.splice(i, 1);
    }
    let n = 0;
    const { positions, sizes, alphas } = this;
    for (const c of clouds) {
      const alpha = this.alphaOf(c, time);
      const cx = this.waterX(c, time) + flow.x - ORIGIN.x;
      const cy = this.waterY(c, time) + flow.y - ORIGIN.y;
      for (let m = 0; m < c.motes; m++) {
        // Each mote circles the centre at its own distance, speed and direction, and twinkles.
        const spin = (0.12 + 0.3 * frac(c.seed, 4 * m + 1)) * (m % 2 === 0 ? 1 : -1);
        const angle = TAU * frac(c.seed, 4 * m) + time * spin;
        const reach = CLOUD_WU * look * (0.3 + 0.7 * frac(c.seed, 4 * m + 2));
        positions[n * 3] = cx + Math.cos(angle) * reach;
        positions[n * 3 + 1] = cy + Math.sin(angle) * reach * 0.8;
        positions[n * 3 + 2] = 0;
        const f = frac(c.seed, 4 * m + 3);
        sizes[n] = MOTE_WU * look * pxPerWu * (0.7 + 0.6 * f);
        alphas[n] = alpha * (0.55 + 0.45 * Math.sin(time * (1.1 + f) + TAU * f) ** 2);
        n++;
      }
    }
    this.drawn = n;
    this.geometry.setDrawRange(0, n);
    this.points.visible = n > 0;
    if (n > 0) {
      for (const name of ATTRIBUTES) {
        (this.geometry.getAttribute(name) as THREE.BufferAttribute).needsUpdate = true;
      }
    }
  }

  /** Clouds held this frame, fading ones included. */
  count(): number {
    return this.held.length;
  }

  /** Motes drawn this frame. */
  motes(): number {
    return this.drawn;
  }

  /** The clouds as last drawn, for tests; it allocates. */
  clouds(): SwarmCloud[] {
    const t = this.now;
    return this.held.map((c) => ({
      x: this.waterX(c, t) + this.flow.x,
      y: this.waterY(c, t) + this.flow.y,
      alpha: this.alphaOf(c, t),
      motes: c.motes,
      seed: c.seed,
    }));
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
    this.held.length = 0;
  }

  /** A new `near`: points near a cloud move it, the rest start clouds, and clouds left over fade out. */
  private report(
    swarm: readonly SwarmPoint[],
    time: number,
    flow: { readonly x: number; readonly y: number },
  ): void {
    const clouds = this.held;
    for (const c of clouds) c.kept = false;
    for (const [x, y] of swarm) {
      const wx = x - flow.x;
      const wy = y - flow.y;
      let best: Cloud | null = null;
      let bestD = SWARM_MATCH_WU;
      for (const c of clouds) {
        if (c.kept || c.goneAt <= time) continue;
        const d = Math.hypot(c.toX - wx, c.toY - wy);
        if (d <= bestD) {
          best = c;
          bestD = d;
        }
      }
      if (best) {
        best.fromX = this.waterX(best, time);
        best.fromY = this.waterY(best, time);
        best.toX = wx;
        best.toY = wy;
        best.movedAt = time;
        best.kept = true;
        continue;
      }
      if (!this.room(time)) continue;
      const seed = seedOf(x, y);
      clouds.push({
        seed,
        motes: SWARM_MOTES.min + (seed % (SWARM_MOTES.max - SWARM_MOTES.min + 1)),
        fromX: wx,
        fromY: wy,
        toX: wx,
        toY: wy,
        movedAt: time,
        bornAt: time,
        goneAt: Number.POSITIVE_INFINITY,
        kept: true,
      });
    }
    for (const c of clouds) if (!c.kept && c.goneAt > time) c.goneAt = time;
  }

  /** Whether a new cloud fits: below the cap, or once the faintest fading cloud makes way. */
  private room(time: number): boolean {
    const clouds = this.held;
    if (clouds.length < SWARM_CLOUDS) return true;
    let faintest = -1;
    for (let i = 0; i < clouds.length; i++) {
      const c = clouds[i] as Cloud;
      if (c.goneAt > time || c.kept) continue;
      const f = clouds[faintest];
      if (!f || this.alphaOf(c, time) < this.alphaOf(f, time)) faintest = i;
    }
    if (faintest < 0) return false;
    clouds.splice(faintest, 1);
    return true;
  }

  private alphaOf(c: Cloud, time: number): number {
    const fadeIn = clamp((time - c.bornAt) / SWARM_FADE_S, 0, 1);
    const fadeOut = clamp(1 - (time - c.goneAt) / SWARM_FADE_S, 0, 1);
    return fadeIn * fadeOut;
  }

  private glide(c: Cloud, time: number): number {
    return smoothstep(0, 1, (time - c.movedAt) / SWARM_FADE_S);
  }

  private waterX(c: Cloud, time: number): number {
    const k = this.glide(c, time);
    return lerp(c.fromX, c.toX, k);
  }

  private waterY(c: Cloud, time: number): number {
    const k = this.glide(c, time);
    return lerp(c.fromY, c.toY, k);
  }
}

// Size outlines (M6 T21): a creature at least a tier bigger than the player wears a pulsing broken
// ring, a smaller one a faint, still ring of dots, and a comparable one nothing. Shape and pulse
// carry the meaning, so colour is never the only signal. The ring hugs the body's hull, so long
// antennae and tentacles do not blow it up. Render only: the tiers are the sim's (`sizeClass`).

import * as THREE from 'three';
import { type BodyPlan, extentOf } from '../genome/develop';
import { sizeClass } from '../sim/size';
import type { CreatureSource } from './creature-cache';
import { idFraction, writeInstance } from './instances';
import { outlineMaterial } from './materials';
import type { RemoteCellView } from './remotes';

export type OutlineKind = 'bigger' | 'smaller';

export const OUTLINE = {
  /** Outlines drawn at once; a pond holds 24 players. */
  capacity: 32,
  /** The ring sits this share of the hull's radius outside it... */
  gap: 0.3,
  /** ...and at least this many CSS pixels. */
  minGapPx: 6,
  /** The quad's half-size over the ring's radius: room for the pulse and the line's halo. */
  quad: 1.25,
  /** Seconds per beat of the bigger creature's pulse. */
  period: 0.9,
} as const;

/** Below this opacity a remote gets no outline. */
const MIN_ALPHA = 0.01;
/** Hulls remembered at once, by genome hash. */
const HULL_CACHE = 64;

/** The outline a creature of `otherRadius` gets from a player of `ownRadius`; null for none. */
export function outlineKind(ownRadius: number, otherRadius: number): OutlineKind | null {
  const size = sizeClass(ownRadius, otherRadius);
  return size === 'comparable' ? null : size;
}

/** 0..1, the pulse at `time` seconds: a bigger creature's ring beats, a smaller one's holds at 0. */
export function outlinePulse(kind: OutlineKind, time: number, phase: number): number {
  if (kind === 'smaller') return 0;
  return 0.5 - 0.5 * Math.cos(2 * Math.PI * (time / OUTLINE.period + phase));
}

export interface Hull {
  /** Centre in core radii, in the body's frame. */
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

const CELL_HULL: Hull = { x: 0, y: 0, radius: 1 };

/** The circle around a plan's body segments (and carapace), in core radii; the unit circle for the plain cell. */
export function hullOf(plan: BodyPlan | null): Hull {
  if (!plan || plan.segments.length === 0) return CELL_HULL;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  const shells = plan.carapace.count > 0 ? [...plan.segments, plan.carapace] : plan.segments;
  for (const s of shells) {
    const e = extentOf(s);
    minX = Math.min(minX, s.x - e.x);
    maxX = Math.max(maxX, s.x + e.x);
    minY = Math.min(minY, s.y - e.y);
    maxY = Math.max(maxY, s.y + e.y);
  }
  const x = (minX + maxX) / 2;
  const y = (minY + maxY) / 2;
  let radius = 0;
  for (const s of shells)
    radius = Math.max(radius, Math.hypot(s.x - x, s.y - y) + Math.max(s.rx, s.ry));
  return { x, y, radius };
}

/** The ring's radius in world units around a hull of `hull` core radii on a creature of `radius` wu. */
export function ringRadius(hull: number, radius: number, pxPerWu: number): number {
  const body = hull * radius;
  return body + Math.max(body * OUTLINE.gap, OUTLINE.minGapPx / pxPerWu);
}

/** Where the camera looks, to report outlines in CSS pixels. */
export interface OutlineProjection {
  camX: number;
  camY: number;
  pxPerWu: number;
  width: number;
  height: number;
}

/** An outline as drawn, in CSS pixels (for the test hook). */
export interface DrawnOutline {
  id: string;
  kind: OutlineKind;
  x: number;
  y: number;
  radius: number;
  pulse: number;
}

/** The size outlines as instanced quads: one draw call, none on a frame without outlines. */
export class OutlineLayer {
  readonly mesh: THREE.InstancedMesh;
  private readonly geometry = new THREE.PlaneGeometry(2, 2);
  private readonly material = outlineMaterial(1 / OUTLINE.quad);
  private readonly hulls = new Map<string, Hull>();
  /** Reused records of the last frame's outlines; `shown` of them are live. */
  private readonly records: DrawnOutline[] = [];
  private shown = 0;
  private bigger = 0;

  constructor() {
    this.mesh = new THREE.InstancedMesh(this.geometry, this.material, OUTLINE.capacity);
    this.mesh.count = 0;
    this.mesh.visible = false;
  }

  /** Outlines the remotes against a player of `ownRadius` wu (null: no player, no outlines). */
  set(
    remotes: readonly RemoteCellView[],
    ownRadius: number | null,
    time: number,
    view: OutlineProjection,
  ): void {
    const array = this.mesh.instanceMatrix.array;
    let n = 0;
    let bigger = 0;
    if (ownRadius !== null) {
      for (const r of remotes) {
        if (n >= OUTLINE.capacity) break;
        if (r.alpha < MIN_ALPHA || (r.dissolve ?? 0) > 0) continue;
        const kind = outlineKind(ownRadius, r.radius);
        if (!kind) continue;
        const hull = this.hullFor(r.body ?? null);
        const c = Math.cos(r.heading);
        const s = Math.sin(r.heading);
        const x = r.x + (hull.x * c - hull.y * s) * r.radius;
        const y = r.y + (hull.x * s + hull.y * c) * r.radius;
        const ring = ringRadius(hull.radius, r.radius, view.pxPerWu);
        const pulse = outlinePulse(kind, time, idFraction(r.id));
        // The phase packs the kind (0 smaller, 1 bigger) and the pulse; the spare slot the alpha.
        writeInstance(
          array,
          n,
          x,
          y,
          ring * OUTLINE.quad,
          0,
          (kind === 'bigger' ? 1 : 0) + pulse * 0.99,
          r.alpha,
        );
        this.record(n, r.id, kind, x, y, ring, pulse, view);
        if (kind === 'bigger') bigger++;
        n++;
      }
    }
    this.shown = n;
    this.bigger = bigger;
    this.mesh.count = n;
    this.mesh.visible = n > 0;
    if (n > 0) this.mesh.instanceMatrix.needsUpdate = true;
  }

  /** The outlines drawn by the last `set`. */
  drawn(): DrawnOutline[] {
    return this.records.slice(0, this.shown).map((o) => ({ ...o }));
  }

  counts(): { bigger: number; smaller: number } {
    return { bigger: this.bigger, smaller: this.shown - this.bigger };
  }

  dispose(): void {
    this.mesh.dispose();
    this.geometry.dispose();
    this.material.dispose();
  }

  private record(
    n: number,
    id: string,
    kind: OutlineKind,
    x: number,
    y: number,
    ring: number,
    pulse: number,
    view: OutlineProjection,
  ): void {
    let o = this.records[n];
    if (!o) {
      o = { id, kind, x: 0, y: 0, radius: 0, pulse: 0 };
      this.records[n] = o;
    }
    o.id = id;
    o.kind = kind;
    o.x = view.width / 2 + (x - view.camX) * view.pxPerWu;
    o.y = view.height / 2 - (y - view.camY) * view.pxPerWu;
    o.radius = ring * view.pxPerWu;
    o.pulse = pulse;
  }

  private hullFor(body: CreatureSource | null): Hull {
    if (!body) return CELL_HULL;
    let hull = this.hulls.get(body.hash);
    if (!hull) {
      if (this.hulls.size >= HULL_CACHE) this.hulls.clear();
      hull = hullOf(body.plan);
      this.hulls.set(body.hash, hull);
    }
    return hull;
  }
}

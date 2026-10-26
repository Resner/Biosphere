// Development (ADR 0006): traits become a bounded, repaired body plan. Total and deterministic;
// the caps live here, never in the renderer. Lengths are in core radii (the core is radius 1 at the
// origin, x forward, y left). Appendages are built for the left side and mirrored, so every repair
// keeps the body bilateral.

import type { Collider } from '../sim/body';
import { Hasher } from '../sim/hash';
import { clamp, cos, length as hypot, PI, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Traits } from './express';

const D = RULES.develop;

/** An ellipse along the spine: centre `x` (0 for the core, negative behind it), half-length `rx`, half-width `ry`. */
export interface PlanSegment {
  x: number;
  rx: number;
  ry: number;
}

/** One appendage instance; a mirrored pair is two instances that differ in `side`. */
export interface Appendage {
  /** Module slot 0-7, or -1 for the default ciliary band. */
  module: number;
  /** 1 left, -1 right. */
  side: 1 | -1;
  segment: number;
  /** Attach angle from the heading, around the segment outline, 0..π (before applying `side`). */
  angle: number;
  /** Growth direction, same convention. */
  dir: number;
  length: number;
  width: number;
  taper: number;
  curvature: number;
  joints: number;
  /** Children at the single branching level (0-2). */
  branches: number;
  /** 0 blunt, then point, hook, paddle, 1 whip. */
  tip: number;
  stiffness: number;
  beat: number;
  /** Fraction of a beat cycle. */
  phase: number;
}

export interface Plate {
  segment: number;
  coverage: number;
  thickness: number;
}

export interface PlanMouth {
  offset: number;
  radius: number;
  arc: number;
  type: number;
  digestion: number;
}

export interface BodyPlan {
  segments: PlanSegment[];
  appendages: Appendage[];
  plates: Plate[];
  mouth: PlanMouth;
  /** 1-12 circles, the core first. */
  colliders: Collider[];
  flexibility: number;
}

export type Detail = 'full' | 'low';

type Part = Omit<Appendage, 'side'> & { pair: number };

const STRETCH = D.stretch as readonly [number, number];
const WIDTH = D.width as readonly [number, number];

const unit = (byte: number): number => byte / 255;
const span = (range: readonly [number, number] | readonly number[], f: number): number =>
  (range[0] as number) + ((range[1] as number) - (range[0] as number)) * f;
const branchFactor = (branches: number): number => (branches > 0 ? 1 + D.branchScale : 1);
const maxAngle = PI - D.angleMargin;

function buildSegments(body: Traits['body']): PlanSegment[] {
  const n = clamp(Math.floor(body.segments), 1, D.caps.segments);
  const stretch = clamp(body.aspect / D.aspectNeutral, STRETCH[0], STRETCH[1]);
  const radius = (i: number): number => (n > 1 ? 1 - body.taper * D.taperDrop * (i / (n - 1)) : 1);
  // The chain from the core, then one scale for every segment behind it so the rear stays in reach.
  const lead = D.segmentSpacing * stretch;
  const rear: number[] = [0];
  let k = 1;
  for (let i = 1; i < n; i++) {
    const behind =
      (rear[i - 1] as number) + D.segmentSpacing * stretch * (radius(i - 1) + radius(i));
    rear.push(behind);
    const m = radius(i) * Math.max(stretch, 1);
    k = Math.min(k, (D.segmentReach - lead) / (behind - lead + m));
  }
  const out: PlanSegment[] = [{ x: 0, rx: stretch, ry: 1 }];
  for (let i = 1; i < n; i++) {
    const r = radius(i) * k;
    out.push({ x: -(lead + k * ((rear[i] as number) - lead)), rx: r * stretch, ry: r });
  }
  return out;
}

/** Distance from the core centre to where an appendage leaves segment `s` at `angle`. */
function rootOf(s: PlanSegment, angle: number): { x: number; y: number } {
  return { x: s.x + s.rx * cos(angle), y: s.ry * sin(angle) };
}

function buildParts(traits: Traits, segments: PlanSegment[]): Part[] {
  const n = segments.length;
  const parts: Part[] = [];
  let malformed = traits.defects.partScale;
  traits.modules.forEach((mod, slot) => {
    if (!mod.present) return;
    const p = mod.params;
    const scale = malformed;
    malformed = 1; // only the first present module is the malformed part
    const pairs = 1 + Math.floor((p.pairs * 3) / 256);
    const t0 = unit(p.attachStart);
    const reach = unit(p.attachSpan) * (1 - t0);
    for (let k = 0; k < pairs; k++) {
      const t = pairs > 1 ? t0 + (reach * k) / (pairs - 1) : t0;
      parts.push({
        module: slot,
        pair: k,
        segment: Math.min(n - 1, Math.floor(t * n)),
        angle: D.angleMargin + (PI - 2 * D.angleMargin) * unit(p.angle),
        dir: 0,
        length: span(D.length, unit(p.length)) * scale,
        width: span(D.width, unit(p.thickness)) * scale,
        taper: span(D.taper, unit(p.taper)),
        curvature: span(D.curvature, unit(p.curvature)),
        joints: 1 + Math.floor((p.joints * D.caps.joints) / 256),
        branches: Math.floor((p.branching * (D.caps.branches + 1)) / 256),
        tip: unit(p.tipShape),
        stiffness: unit(p.stiffness),
        beat: unit(p.beat),
        phase: unit(p.phase),
      });
    }
  });
  return parts;
}

const byAngle = (a: Part, b: Part): number =>
  a.angle - b.angle || a.module - b.module || a.pair - b.pair;

/** Parts on one segment keep `minAngleGap` apart: later ones are pushed round, and one with no room merges into its neighbour. */
function separate(parts: Part[], count: number): Part[] {
  const fate = new Map<Part, Part | null>();
  for (let s = 0; s < count; s++) {
    const kept: Part[] = [];
    for (const p of parts.filter((q) => q.segment === s).sort(byAngle)) {
      const prev = kept[kept.length - 1];
      if (prev === undefined) {
        kept.push(p);
        fate.set(p, p);
        continue;
      }
      const angle = Math.max(p.angle, prev.angle + D.minAngleGap);
      if (angle <= maxAngle + 1e-12) {
        const moved = { ...p, angle };
        kept.push(moved);
        fate.set(p, moved);
      } else {
        const merged = { ...prev, width: Math.min(WIDTH[1], hypot(prev.width, p.width)) };
        kept[kept.length - 1] = merged;
        for (const [from, to] of fate) if (to === prev) fate.set(from, merged);
        fate.set(p, null);
      }
    }
  }
  const out: Part[] = [];
  for (const p of parts) {
    const to = fate.get(p);
    if (to) out.push(to);
  }
  return out;
}

/** Sets the growth direction and clamps lengths so root plus reach stays inside the bounds. */
function shape(parts: Part[], segments: PlanSegment[]): Part[] {
  return parts.map((p) => {
    const root = rootOf(segments[p.segment] as PlanSegment, p.angle);
    const room = (D.caps.bounds - D.boundsSlack - hypot(root.x, root.y)) / branchFactor(p.branches);
    return {
      ...p,
      dir: p.angle + D.sweep * (PI - p.angle),
      length: Math.min(p.length, room),
    };
  });
}

/** Motile area: length × width × beat over parts that beat at all, both sides, counting branches. */
export function motileArea(plan: BodyPlan): number {
  let area = 0;
  for (const a of plan.appendages) {
    if (a.beat >= D.minBeat) area += partArea(a);
  }
  return area;
}

const partArea = (a: Pick<Appendage, 'length' | 'width' | 'beat' | 'branches'>): number =>
  a.length * a.width * a.beat * (1 + a.branches * D.branchScale * D.branchScale);

export function estimateVertices(plan: BodyPlan, detail: Detail): number {
  return verticesOf(plan.segments.length, plan.appendages, detail);
}

function verticesOf(
  segments: number,
  appendages: readonly Pick<Appendage, 'joints' | 'branches'>[],
  detail: Detail,
): number {
  const v = D.vertices[detail];
  let total = segments * v.bodyRings * v.bodyRing;
  for (const a of appendages) {
    total += (1 + a.branches) * ((a.joints * v.jointRings + 1) * v.partRing + 1);
  }
  return total;
}

const fits = (segments: number, parts: Part[]): boolean => {
  const both = parts.flatMap((p) => [p, p]);
  return (
    both.length <= D.caps.appendages &&
    verticesOf(segments, both, 'full') <= D.vertices.full.cap &&
    verticesOf(segments, both, 'low') <= D.vertices.low.cap
  );
};

function bandParts(parts: Part[], segment: number): Part[] | null {
  // The free angles on the rear segment, rearmost first.
  const taken = parts.filter((p) => p.segment === segment).map((p) => p.angle);
  const slots = Math.floor((PI - 2 * D.angleMargin) / D.minAngleGap);
  const band: Part[] = [];
  for (let j = slots; j >= 0 && band.length < D.band.pairs; j--) {
    const angle = D.angleMargin + j * D.minAngleGap;
    if (taken.every((a) => Math.abs(a - angle) >= D.minAngleGap - 1e-9)) {
      band.push({
        module: -1,
        pair: band.length,
        segment,
        angle,
        dir: 0,
        length: D.band.length,
        width: D.band.width,
        taper: 0.3,
        curvature: 0,
        joints: 2,
        branches: 0,
        tip: D.band.tip,
        stiffness: 0.3,
        beat: D.band.beat,
        phase: band.length / D.band.pairs,
      });
    }
  }
  return band.length === D.band.pairs ? band : null;
}

/** Both sides of every part, pairs adjacent: left then right. */
function mirror(parts: Part[]): Appendage[] {
  const out: Appendage[] = [];
  for (const { pair: _pair, ...rest } of parts) {
    out.push({ ...rest, side: 1 }, { ...rest, side: -1 });
  }
  return out;
}

function buildMouth(m: Traits['mouth']): PlanMouth {
  const jaw = Math.max(0, m.type - 0.5);
  return {
    offset: D.mouthReach * jaw,
    radius: m.size * (D.mouthRadiusBase - m.type),
    arc: PI * (1 - D.mouthNarrow * jaw),
    type: m.type,
    digestion: m.digestion,
  };
}

function buildColliders(segments: PlanSegment[], appendages: Appendage[]): Collider[] {
  const out: Collider[] = [{ x: 0, y: 0, r: 1 }];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i] as PlanSegment;
    out.push({
      x: s.x,
      y: 0,
      r: clamp(s.ry, RULES.body.minColliderRadius, RULES.body.maxColliderRadius),
    });
  }
  // The biggest parts get what circles are left; ties keep instance order.
  const ranked = appendages
    .map((a, i) => ({ a, i, score: a.length * a.width }))
    .sort((p, q) => q.score - p.score || p.i - q.i);
  for (const { a } of ranked) {
    if (out.length >= D.caps.colliders) break;
    const root = rootOf(segments[a.segment] as PlanSegment, a.angle);
    const along = a.length * D.colliderAlong;
    out.push({
      x: root.x + along * cos(a.dir),
      y: a.side * (root.y + along * sin(a.dir)),
      r: clamp(a.width * D.colliderWidth, RULES.body.minColliderRadius, 0.5),
    });
  }
  return out;
}

export function develop(traits: Traits): BodyPlan {
  const segments = buildSegments(traits.body);
  const count = segments.length;
  let parts = shape(separate(buildParts(traits, segments), count), segments);
  // Trim in module order, pair by pair, until the plan fits the caps and the vertex budget.
  while (!fits(count, parts)) parts = parts.slice(0, -1);

  const probe = (list: Part[]): number => motileArea({ appendages: mirror(list) } as BodyPlan);
  if (probe(parts) < D.minThrustArea) {
    for (;;) {
      const band = bandParts(parts, count - 1);
      const trial = band && shape(band, segments);
      if (trial && fits(count, [...parts, ...trial])) {
        parts = [...parts, ...trial];
        break;
      }
      parts = parts.slice(0, -1);
    }
  }

  const appendages = mirror(parts);
  const plating = traits.skin.plating;
  const plates: Plate[] =
    plating < D.plateMin
      ? []
      : segments.map((_, segment) => ({
          segment,
          coverage: plating,
          thickness: span(D.plateThickness, plating),
        }));
  return {
    segments,
    appendages,
    plates,
    mouth: buildMouth(traits.mouth),
    colliders: buildColliders(segments, appendages),
    flexibility: traits.body.flexibility,
  };
}

/** The furthest any part of the plan can reach from the core centre. */
export function planBounds(plan: BodyPlan): number {
  let bound = 0;
  for (const s of plan.segments) bound = Math.max(bound, Math.abs(s.x) + Math.max(s.rx, s.ry));
  for (const a of plan.appendages) {
    const s = plan.segments[a.segment];
    if (s === undefined) return Number.POSITIVE_INFINITY;
    const root = rootOf(s, a.angle);
    bound = Math.max(bound, hypot(root.x, root.y) + a.length * branchFactor(a.branches));
  }
  return bound;
}

function allFinite(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(allFinite);
  if (typeof value === 'object' && value !== null) return Object.values(value).every(allFinite);
  return true;
}

/** Every ADR 0006 cap and guarantee a plan must hold; an empty list means the plan is valid. */
export function bodyViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  if (!allFinite(plan)) return ['non-finite number in the plan'];
  const { caps } = D;
  const n = plan.segments.length;
  if (n < 1 || n > caps.segments) bad.push(`segments: ${n} is outside 1-${caps.segments}`);
  const core = plan.colliders[0];
  if (!core || core.x !== 0 || core.y !== 0 || core.r !== 1)
    bad.push('colliders: the core must come first');
  if (plan.colliders.length < 1 || plan.colliders.length > caps.colliders) {
    bad.push(`colliders: ${plan.colliders.length} is outside 1-${caps.colliders}`);
  }
  if (plan.appendages.length > caps.appendages) {
    bad.push(`appendages: ${plan.appendages.length} is more than ${caps.appendages}`);
  }
  const seen = new Map<string, number[]>();
  for (const a of plan.appendages) {
    if (a.segment < 0 || a.segment >= n) bad.push(`appendage on missing segment ${a.segment}`);
    if (a.joints < 1 || a.joints > caps.joints)
      bad.push(`appendage joints: ${a.joints} is outside 1-${caps.joints}`);
    if (a.branches < 0 || a.branches > caps.branches) {
      bad.push(`appendage branches: ${a.branches} is outside 0-${caps.branches}`);
    }
    const key = `${a.segment}/${a.side}`;
    seen.set(key, [...(seen.get(key) ?? []), a.angle]);
  }
  for (const [key, angles] of seen) {
    angles.sort((p, q) => p - q);
    for (let i = 1; i < angles.length; i++) {
      if ((angles[i] as number) - (angles[i - 1] as number) < D.minAngleGap - 1e-9) {
        bad.push(`appendages overlap on segment/side ${key}`);
        break;
      }
    }
  }
  const m = plan.mouth;
  if (!m || !(m.radius > 0) || !(m.arc > 0) || !(m.offset >= 0)) bad.push('no mouth at the front');
  if (motileArea(plan) < D.minThrustArea) bad.push('no propulsion source');
  const bound = planBounds(plan);
  if (bound > caps.bounds) bad.push(`bounds: ${bound} is beyond ${caps.bounds} core radii`);
  if (estimateVertices(plan, 'full') > D.vertices.full.cap)
    bad.push('too many vertices at full detail');
  if (estimateVertices(plan, 'low') > D.vertices.low.cap)
    bad.push('too many vertices at low detail');
  return bad;
}

/** A 64-bit hash of every number in the plan, in a fixed order. */
export function hashPlan(plan: BodyPlan): string {
  const h = new Hasher();
  const f = (...values: number[]): void => {
    for (const v of values) h.f64(v);
  };
  f(plan.segments.length, plan.flexibility);
  for (const s of plan.segments) f(s.x, s.rx, s.ry);
  f(plan.appendages.length);
  for (const a of plan.appendages) {
    f(a.module, a.side, a.segment, a.angle, a.dir, a.length, a.width, a.taper, a.curvature);
    f(a.joints, a.branches, a.tip, a.stiffness, a.beat, a.phase);
  }
  f(plan.plates.length);
  for (const p of plan.plates) f(p.segment, p.coverage, p.thickness);
  const m = plan.mouth;
  f(m.offset, m.radius, m.arc, m.type, m.digestion);
  f(plan.colliders.length);
  for (const c of plan.colliders) f(c.x, c.y, c.r);
  return h.digest();
}

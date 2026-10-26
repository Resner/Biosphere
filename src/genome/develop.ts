// Development (ADR 0006): traits become a bounded, repaired body plan. Total and deterministic;
// the caps live here, never in the renderer. Lengths are in core radii (the core is radius 1 at the
// origin, x forward, y left). Appendages are built for the left side and mirrored, so every repair
// keeps the body bilateral.

import type { Collider } from '../sim/body';
import { Hasher } from '../sim/hash';
import { clamp, cos, length as hypot, lerp, PI, sin } from '../sim/math';
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

/** One left-side appendage; `develop` builds these and mirrors them at the end. */
type Part = Omit<Appendage, 'side'>;
type Range = readonly [number, number];

const range = (r: readonly number[]): Range => [r[0] as number, r[1] as number];
const STRETCH = range(D.stretch);
const LENGTH = range(D.length);
const WIDTH = range(D.width);
const TAPER = range(D.taper);
const CURVATURE = range(D.curvature);
const PLATE_THICKNESS = range(D.plateThickness);

const unit = (byte: number): number => byte / 255;
/** Area weight of a part counting its branches. */
export const branchWeight = (a: Pick<Appendage, 'branches'>): number =>
  1 + a.branches * D.branchScale * D.branchScale;
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

/** Where an appendage leaves segment `s` at `angle`, from the core centre. */
export function rootOf(s: PlanSegment, angle: number): { x: number; y: number } {
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
    const pairs = 1 + Math.floor((p.pairs * D.caps.pairs) / 256);
    const t0 = unit(p.attachStart);
    const reach = unit(p.attachSpan) * (1 - t0);
    for (let k = 0; k < pairs; k++) {
      const t = pairs > 1 ? t0 + (reach * k) / (pairs - 1) : t0;
      parts.push({
        module: slot,
        segment: Math.min(n - 1, Math.floor(t * n)),
        angle: D.angleMargin + (PI - 2 * D.angleMargin) * unit(p.angle),
        dir: 0,
        length: lerp(LENGTH[0], LENGTH[1], unit(p.length)) * scale,
        width: lerp(WIDTH[0], WIDTH[1], unit(p.thickness)) * scale,
        taper: lerp(TAPER[0], TAPER[1], unit(p.taper)),
        curvature: lerp(CURVATURE[0], CURVATURE[1], unit(p.curvature)),
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

/**
 * Parts on one segment keep `minAngleGap` apart: later ones are pushed round, and one with no room
 * merges into its neighbour. Edits the parts in place; the stable sort keeps module and pair order
 * among equal angles.
 */
function separate(parts: Part[], count: number): Part[] {
  const dropped = new Set<Part>();
  for (let s = 0; s < count; s++) {
    let prev: Part | undefined;
    for (const p of parts.filter((q) => q.segment === s).sort((x, y) => x.angle - y.angle)) {
      if (prev === undefined) {
        prev = p;
        continue;
      }
      const angle = Math.max(p.angle, prev.angle + D.minAngleGap);
      if (angle <= maxAngle + D.epsilon) {
        p.angle = angle;
        prev = p;
      } else {
        prev.width = Math.min(WIDTH[1], hypot(prev.width, p.width));
        prev.beat = Math.max(prev.beat, p.beat);
        dropped.add(p);
      }
    }
  }
  return parts.filter((p) => !dropped.has(p));
}

/** Sets the growth direction and clamps lengths so root plus reach stays inside the bounds. Edits in place. */
function shape(parts: Part[], segments: PlanSegment[]): Part[] {
  for (const p of parts) {
    const root = rootOf(segments[p.segment] as PlanSegment, p.angle);
    const room = (D.caps.bounds - D.boundsSlack - hypot(root.x, root.y)) / branchFactor(p.branches);
    p.dir = p.angle + D.sweep * (PI - p.angle);
    p.length = Math.min(p.length, room);
  }
  return parts;
}

type Piece = Pick<Appendage, 'length' | 'width' | 'beat' | 'branches'>;

/** Motile area: length × width × beat over parts that beat at all, counting branches. */
export function motileArea(appendages: readonly Piece[]): number {
  let area = 0;
  for (const a of appendages) {
    if (a.beat >= D.minBeat) {
      area += a.length * a.width * a.beat * branchWeight(a);
    }
  }
  return area;
}

export function estimateVertices(plan: BodyPlan, detail: Detail): number {
  return verticesOf(plan.segments.length, plan.appendages, 1, detail);
}

/** Mesh vertices for a body and `sides` copies of each appendage. */
function verticesOf(
  segments: number,
  appendages: readonly Pick<Appendage, 'joints' | 'branches'>[],
  sides: number,
  detail: Detail,
): number {
  const v = D.vertices[detail];
  let total = segments * v.bodyRings * v.bodyRing;
  for (const a of appendages) {
    total += sides * (1 + a.branches) * ((a.joints * v.jointRings + 1) * v.partRing + 1);
  }
  return total;
}

/** Whether the left-side `parts`, mirrored, hold the instance and vertex caps. */
const fits = (segments: number, parts: Part[]): boolean =>
  parts.length * 2 <= D.caps.appendages &&
  verticesOf(segments, parts, 2, 'full') <= D.vertices.full.cap &&
  verticesOf(segments, parts, 2, 'low') <= D.vertices.low.cap;

function bandParts(parts: Part[], segment: number): Part[] | null {
  // The free angles on the rear segment, rearmost first.
  const taken = parts.filter((p) => p.segment === segment).map((p) => p.angle);
  const slots = Math.floor((PI - 2 * D.angleMargin) / D.minAngleGap);
  const band: Part[] = [];
  for (let j = slots; j >= 0 && band.length < D.band.pairs; j--) {
    const angle = D.angleMargin + j * D.minAngleGap;
    if (taken.every((a) => Math.abs(a - angle) >= D.minAngleGap - D.epsilon)) {
      band.push({
        module: -1,
        segment,
        angle,
        dir: 0,
        length: D.band.length,
        width: D.band.width,
        taper: D.band.taper,
        curvature: 0,
        joints: D.band.joints,
        branches: 0,
        tip: D.band.tip,
        stiffness: D.band.stiffness,
        beat: D.band.beat,
        phase: band.length / D.band.pairs,
      });
    }
  }
  return band.length === D.band.pairs ? band : null;
}

/** Both sides of every part, pairs adjacent: left then right. */
const mirror = (parts: Part[]): Appendage[] =>
  parts.flatMap((p) => [
    { ...p, side: 1 as const },
    { ...p, side: -1 as const },
  ]);

function buildMouth(m: Traits['mouth']): PlanMouth {
  const jaw = Math.max(0, m.type - D.jawStart);
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
  // The biggest pairs get what circles are left, both sides or neither; ties keep instance order.
  const ranked = appendages
    .map((a, i) => ({ i, score: a.length * a.width }))
    .filter(
      ({ i }) =>
        i % 2 === 0 &&
        (appendages[i] as Appendage).width * D.colliderWidth >= RULES.body.minColliderRadius,
    )
    .sort((p, q) => q.score - p.score || p.i - q.i);
  for (const { i } of ranked) {
    if (out.length + 2 > D.caps.colliders) break;
    for (const a of [appendages[i], appendages[i + 1]] as Appendage[]) {
      const root = rootOf(segments[a.segment] as PlanSegment, a.angle);
      const along = a.length * D.colliderAlong;
      out.push({
        x: root.x + along * cos(a.dir),
        y: a.side * (root.y + along * sin(a.dir)),
        r: clamp(
          a.width * D.colliderWidth,
          RULES.body.minColliderRadius,
          RULES.body.maxColliderRadius,
        ),
      });
    }
  }
  return out;
}

export function develop(traits: Traits): BodyPlan {
  const segments = buildSegments(traits.body);
  const count = segments.length;
  let parts = shape(separate(buildParts(traits, segments), count), segments);
  // Trim in module order, pair by pair, until the plan fits the caps and the vertex budget.
  while (!fits(count, parts)) parts = parts.slice(0, -1);

  if (2 * motileArea(parts) < D.minThrustArea) {
    // Try the rear segment first, then the ones in front of it, before giving up any part.
    const withBand = (): Part[] | null => {
      for (let seg = count - 1; seg >= 0; seg--) {
        const band = bandParts(parts, seg);
        const trial = band && shape(band, segments);
        if (trial && fits(count, [...parts, ...trial])) return [...parts, ...trial];
      }
      return null;
    };
    for (let banded = withBand(); ; banded = withBand()) {
      if (banded) {
        parts = banded;
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
          thickness: lerp(PLATE_THICKNESS[0], PLATE_THICKNESS[1], plating),
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

/** Every ADR 0006 cap and guarantee a plan must hold; an empty list means the plan is valid. */
export function bodyViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  try {
    hashPlan(plan); // throws on a non-finite number or a missing field
  } catch {
    return ['malformed plan: a number is missing or not finite'];
  }
  const { caps } = D;
  const n = plan.segments.length;
  if (n < 1 || n > caps.segments) bad.push(`segments: ${n} is outside 1-${caps.segments}`);
  const core = plan.colliders[0] ?? { x: NaN, y: NaN, r: NaN };
  if (core.x !== 0 || core.y !== 0 || core.r !== 1) bad.push('colliders: the core must come first');
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
      if ((angles[i] as number) - (angles[i - 1] as number) < D.minAngleGap - D.epsilon) {
        bad.push(`appendages overlap on segment/side ${key}`);
        break;
      }
    }
  }
  for (const c of plan.colliders) {
    if (hypot(c.x, c.y) + c.r > RULES.body.maxReach)
      bad.push('colliders: a circle reaches past the body limit');
  }
  for (const c of plan.colliders) {
    if (c.r < RULES.body.minColliderRadius || c.r > RULES.body.maxColliderRadius) {
      bad.push(`colliders: radius ${c.r} is outside the body limits`);
    }
  }
  for (const a of plan.appendages) {
    if (!(a.length > 0) || !(a.width > 0)) bad.push('appendage with no length or width');
    if (a.angle < 0 || a.angle > PI) bad.push(`appendage angle ${a.angle} is outside 0-π`);
  }
  for (let i = 0; i + 1 < plan.appendages.length; i += 2) {
    const [l, r] = [plan.appendages[i], plan.appendages[i + 1]] as [Appendage, Appendage];
    if (l.side !== 1 || r.side !== -1 || l.segment !== r.segment || l.angle !== r.angle) {
      bad.push('appendages are not mirrored in pairs');
      break;
    }
  }
  if (plan.appendages.length % 2 === 1) bad.push('appendages are not mirrored in pairs');
  const m = plan.mouth;
  const b = RULES.body;
  if (
    !m ||
    !(m.offset >= 0 && m.offset <= b.maxReach) ||
    !(m.radius >= b.minMouthRadius && m.radius <= b.maxMouthRadius) ||
    !(m.arc >= b.minMouthArc && m.arc <= PI) ||
    !(m.digestion >= b.digestionMin && m.digestion <= b.digestionMax)
  ) {
    bad.push('no usable mouth at the front');
  }
  if (motileArea(plan.appendages) < D.minThrustArea) bad.push('no propulsion source');
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

// Development (ADR 0006, ADR 0025): traits become a bounded, repaired body plan. Total and
// deterministic; the caps live here, never in the renderer. Lengths are in core radii (the core is
// radius 1 at the origin, x forward, y left). Appendages are built for the left side and mirrored,
// so every repair keeps the body bilateral. Development v2 (rules 6) bends, profiles and fuses the
// segment chain, rings a radial body's parts and adds eyes; with every v2 locus at 0 it builds the
// v1 body exactly as `develop-v5.ts` does (a property test pins that).

import type { Collider } from '../sim/body';
import { Hasher } from '../sim/hash';
import { atan2, clamp, cos, length as hypot, lerp, PI, pow, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Traits } from './express';

const D = RULES.develop;

/**
 * An ellipse on the spine: centre (`x`, `y`) (the core at 0, 0; the chain runs back along −x and
 * bends with the curve), half-length `rx` along its own axis, half-width `ry`, and `angle`, its
 * axis's heading from forward (0 on a straight body).
 */
export interface PlanSegment {
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
}

/** One appendage instance; a mirrored pair is two instances that differ in `side`. */
export interface Appendage {
  /** Module slot 0-7, or -1 for the default ciliary band. */
  module: number;
  /** 1 left, -1 right. */
  side: 1 | -1;
  segment: number;
  /** Attach angle from the segment's heading, around its outline, 0..π (before applying `side`). */
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

/** How the spine was laid out: `turn` is the total turn of its tangent, `mode` 0 C, 1 S, 2 coil. */
export interface PlanForm {
  turn: number;
  mode: number;
  /** 1 when the parts ring the core at even angles (symmetry ≥ `RULES.develop.radial.at`). */
  radial: number;
}

/**
 * One shell over the front `count` segments (0: none): an ellipse at (`x`, `y`) with half-axes
 * `rx`, `ry` along `angle`. The fused segments stay in `segments` for the gut, joints and stats.
 */
export interface Carapace {
  count: number;
  x: number;
  y: number;
  rx: number;
  ry: number;
  angle: number;
  thickness: number;
}

/** A pair of eyes on the head (`count` 0 or 2): radius `size` on a stalk; (`x`, `y`) is the left eye's centre, the right one mirrors it. */
export interface PlanEyes {
  count: number;
  size: number;
  stalk: number;
  angle: number;
  x: number;
  y: number;
}

export interface BodyPlan {
  segments: PlanSegment[];
  appendages: Appendage[];
  plates: Plate[];
  mouth: PlanMouth;
  /** 1-12 circles, the core first. */
  colliders: Collider[];
  flexibility: number;
  form: PlanForm;
  carapace: Carapace;
  eyes: PlanEyes;
}

export type Detail = 'full' | 'low';

/** One left-side appendage; `develop` builds these and mirrors them at the end. */
type Part = Omit<Appendage, 'side'>;
type Range = readonly [number, number];
type Point = { x: number; y: number };

const range = (r: readonly number[]): Range => [r[0] as number, r[1] as number];
const STRETCH = range(D.stretch);
const LENGTH = range(D.length);
const WIDTH = range(D.width);
const TAPER = range(D.taper);
const CURVATURE = range(D.curvature);
const PLATE_THICKNESS = range(D.plateThickness);
const EYE_SIZE = range(D.eyes.size);
const EYE_STALK = range(D.eyes.stalk);

const unit = (byte: number): number => byte / 255;
/** Area weight of a part counting its branches. */
export const branchWeight = (a: Pick<Appendage, 'branches'>): number =>
  1 + a.branches * D.branchScale * D.branchScale;
const branchFactor = (branches: number): number => (branches > 0 ? 1 + D.branchScale : 1);
const maxAngle = PI - D.angleMargin;
/** 1 at `centre`, falling linearly to 0 at `spread` either side. */
export const peak = (x: number, centre: number, spread: number): number =>
  clamp(1 - Math.abs(x - centre) / spread, 0, 1);

/** A direction given in segment `s`'s own frame, in body coordinates. Exact on an unturned segment. */
export function turnTo(s: PlanSegment, dx: number, dy: number): Point {
  if (s.angle === 0) return { x: dx, y: dy };
  const c = cos(s.angle);
  const n = sin(s.angle);
  return { x: dx * c - dy * n, y: dx * n + dy * c };
}

/** A point given in segment `s`'s own frame, in body coordinates. */
export function placeOn(s: PlanSegment, lx: number, ly: number): Point {
  const d = turnTo(s, lx, ly);
  return { x: s.x + d.x, y: s.y + d.y };
}

/** Where an appendage on `side` leaves segment `s` at `angle`, from the core centre. */
export function rootOf(s: PlanSegment, angle: number, side: 1 | -1 = 1): Point {
  return placeOn(s, s.rx * cos(angle), side * (s.ry * sin(angle)));
}

/** The body-frame growth direction of an appendage: a unit vector. */
export function dirOf(s: PlanSegment, a: Pick<Appendage, 'dir' | 'side'>): Point {
  return turnTo(s, cos(a.dir), a.side * sin(a.dir));
}

/** How far an ellipse's outline lies from its centre along the body-frame unit direction (`dx`, `dy`). */
function radiusAlong(s: PlanSegment, dx: number, dy: number): number {
  const c = cos(s.angle);
  const n = sin(s.angle);
  const lx = (dx * c + dy * n) / s.rx;
  const ly = (dy * c - dx * n) / s.ry;
  return 1 / Math.sqrt(lx * lx + ly * ly);
}

/** Half-extents of a turned ellipse along the body's x and y axes. */
export function extentOf(e: { rx: number; ry: number; angle: number }): Point {
  if (e.angle === 0) return { x: e.rx, y: e.ry };
  const c = cos(e.angle);
  const n = sin(e.angle);
  return {
    x: Math.sqrt(e.rx * e.rx * c * c + e.ry * e.ry * n * n),
    y: Math.sqrt(e.rx * e.rx * n * n + e.ry * e.ry * c * c),
  };
}

/** The spine's tangent heading at `t` (0 the core, 1 the tail), for a total turn and a mode. */
function heading(turn: number, mode: number, bunch: number, t: number): number {
  if (mode === 1) return turn * (t <= 0.5 ? t : 1 - t);
  if (mode === 2) return t > 0 ? turn * pow(t, 1 + bunch) : 0;
  return turn * t;
}

function formOf(shape: Traits['shape'], count: number): PlanForm & { coil: number } {
  const C = D.curve;
  const radial = shape.symmetry >= D.radial.at ? 1 : 0;
  if (count < 2 || !(shape.curve > 0)) return { turn: 0, mode: 0, radial, coil: 0 };
  const coil = shape.curve > C.coilStart ? (shape.curve - C.coilStart) / (1 - C.coilStart) : 0;
  const mode = shape.curve > C.coilStart ? 2 : shape.curveMode >= C.sMode ? 1 : 0;
  return { turn: PI * (shape.curve + coil * (C.coilTurn - 1)), mode, radial, coil };
}

function buildSegments(traits: Traits, form: ReturnType<typeof formOf>): PlanSegment[] {
  const { body, shape } = traits;
  const T = D.tagmata;
  const n = clamp(Math.floor(body.segments), 1, D.caps.segments);
  const aspect = clamp(body.aspect / D.aspectNeutral, STRETCH[0], STRETCH[1]);
  // Symmetry rounds the body toward an aspect of 1.
  const stretch = lerp(aspect, 1, shape.symmetry);
  const tail = (i: number): number =>
    n > 1 ? clamp((i / (n - 1) - (1 - T.tailShare)) / T.tailShare, 0, 1) : 0;
  // The tagma profile behind the head: swollen in the trunk, tapered in the tail.
  const profile = (i: number): number =>
    (1 + T.trunk * shape.trunkSwell * peak(i / (n - 1), T.trunkAt, T.trunkSpread)) *
    (1 - T.tailTaper * shape.tailTaper * tail(i));
  const radius = (i: number): number =>
    n > 1 ? (1 - body.taper * D.taperDrop * (i / (n - 1))) * (i > 0 ? profile(i) : 1) : 1;
  const stretchOf = (i: number): number =>
    stretch * (1 + T.tailLength * shape.tailLength * tail(i));
  // The chain from the core, then one scale for every segment behind it so the rear stays in reach.
  const lead = D.segmentSpacing * stretchOf(0);
  const rear: number[] = [0];
  let k = 1;
  for (let i = 1; i < n; i++) {
    const link = (stretchOf(i - 1) + stretchOf(i)) / 2;
    const behind = (rear[i - 1] as number) + D.segmentSpacing * link * (radius(i - 1) + radius(i));
    rear.push(behind);
    const m = radius(i) * Math.max(stretchOf(i), 1);
    k = Math.min(k, (D.segmentReach - lead) / (behind - lead + m));
  }
  // The head is the unit: after the reach scale, its scale shrinks the whole chain behind it.
  const scale = k * (1 / (1 + T.head * shape.headScale));
  const out: PlanSegment[] = [{ x: 0, y: 0, rx: stretchOf(0), ry: 1, angle: 0 }];
  for (let i = 1; i < n; i++) {
    const r = radius(i) * scale;
    out.push({
      x: -(lead + scale * ((rear[i] as number) - lead)),
      y: 0,
      rx: r * stretchOf(i),
      ry: r,
      angle: 0,
    });
  }
  return form.turn > 0 ? bend(out, form) : out;
}

/** Lays the straight chain along the curve: same links, turned by the tangent, a coil's shrinking. */
function bend(straight: PlanSegment[], form: ReturnType<typeof formOf>): PlanSegment[] {
  const C = D.curve;
  const n = straight.length;
  const bunch = C.coilBunch * form.coil;
  const out: PlanSegment[] = [straight[0] as PlanSegment];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1] as PlanSegment;
    const s = straight[i] as PlanSegment;
    const mid = (i - 0.5) / (n - 1);
    const phi = PI + heading(form.turn, form.mode, bunch, mid);
    const dx = cos(phi);
    const dy = sin(phi);
    const seg = { ...s, angle: heading(form.turn, form.mode, bunch, i / (n - 1)) };
    // The link keeps its straight length, a coil's shrinks toward the tail, and neighbours overlap.
    let d = ((straight[i - 1] as PlanSegment).x - s.x) * (1 - C.coilShrink * form.coil * mid);
    d = Math.min(d, C.overlap * (radiusAlong(prev, dx, dy) + radiusAlong(seg, -dx, -dy)));
    out.push({ ...seg, x: prev.x + d * dx, y: prev.y + d * dy });
  }
  return out;
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

/**
 * Sets the growth direction (bent `sweep` of the way toward the tail) and clamps lengths so root
 * plus reach stays inside the bounds. Edits in place.
 */
function shape(parts: Part[], segments: PlanSegment[], sweep: number): Part[] {
  for (const p of parts) {
    // On a turned segment the two sides' roots lie at different distances; the farther one counts.
    const s = segments[p.segment] as PlanSegment;
    const [l, r] = [rootOf(s, p.angle, 1), rootOf(s, p.angle, -1)];
    const far = Math.max(hypot(l.x, l.y), hypot(r.x, r.y));
    const room = (D.caps.bounds - D.boundsSlack - far) / branchFactor(p.branches);
    p.dir = p.angle + sweep * (PI - p.angle);
    p.length = Math.min(p.length, room);
  }
  return parts;
}

/** The even angle of ring slot `k` of `pairs` on the left side: the instances share the circle. */
export const ringAngle = (k: number, pairs: number): number => (PI * (2 * k + 1)) / (2 * pairs);

/** A radial body: the parts, in order, ring the core at even angles. Copies them. */
function ring(parts: Part[], segments: PlanSegment[], sweep: number): Part[] {
  const ringed = parts.map((p, k) => ({ ...p, segment: 0, angle: ringAngle(k, parts.length) }));
  return shape(ringed, segments, sweep);
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

function bandPart(segment: number, angle: number, index: number): Part {
  return {
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
    phase: index / D.band.pairs,
  };
}

function bandParts(parts: Part[], segment: number): Part[] | null {
  // The free angles on the rear segment, rearmost first.
  const taken = parts.filter((p) => p.segment === segment).map((p) => p.angle);
  const slots = Math.floor((PI - 2 * D.angleMargin) / D.minAngleGap);
  const band: Part[] = [];
  for (let j = slots; j >= 0 && band.length < D.band.pairs; j--) {
    const angle = D.angleMargin + j * D.minAngleGap;
    if (taken.every((a) => Math.abs(a - angle) >= D.minAngleGap - D.epsilon)) {
      band.push(bandPart(segment, angle, band.length));
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

/** Bilateral parts: spread, shaped, trimmed in module order, then a ciliary band if nothing swims. */
function bilateralParts(traits: Traits, segments: PlanSegment[], sweep: number): Part[] {
  const count = segments.length;
  let parts = shape(separate(buildParts(traits, segments), count), segments, sweep);
  // Trim in module order, pair by pair, until the plan fits the caps and the vertex budget.
  while (!fits(count, parts)) parts = parts.slice(0, -1);
  if (2 * motileArea(parts) >= D.minThrustArea) return parts;
  // Try the rear segment first, then the ones in front of it, before giving up any part.
  for (;;) {
    for (let seg = count - 1; seg >= 0; seg--) {
      const band = bandParts(parts, seg);
      const trial = band && shape(band, segments, sweep);
      if (trial && fits(count, [...parts, ...trial])) return [...parts, ...trial];
    }
    parts = parts.slice(0, -1);
  }
}

/** Radial parts: ringed, trimmed in module order, and a ciliary band joins the ring if nothing swims. */
function radialParts(traits: Traits, segments: PlanSegment[], sweep: number): Part[] {
  const count = segments.length;
  const all = buildParts(traits, segments);
  let keep = Math.min(all.length, D.radial.maxPairs);
  let parts = ring(all.slice(0, keep), segments, sweep);
  while (keep > 0 && !fits(count, parts)) parts = ring(all.slice(0, --keep), segments, sweep);
  if (2 * motileArea(parts) >= D.minThrustArea) return parts;
  const band = Array.from({ length: D.band.pairs }, (_, j) => bandPart(0, 0, j));
  for (keep = Math.min(keep, D.radial.maxPairs - D.band.pairs); keep > 0; keep--) {
    const trial = ring([...all.slice(0, keep), ...band], segments, sweep);
    if (fits(count, trial)) return trial;
  }
  return ring(band, segments, sweep);
}

function buildMouth(m: Traits['mouth'], radial: number): PlanMouth {
  const jaw = Math.max(0, m.type - D.jawStart);
  return {
    // A radial body's mouth is central.
    offset: radial ? 0 : D.mouthReach * jaw,
    radius: m.size * (D.mouthRadiusBase - m.type),
    arc: PI * (1 - D.mouthNarrow * jaw),
    type: m.type,
    digestion: m.digestion,
  };
}

/** Unit-circle points that a carapace hull must contain, per fused segment. */
const HULL_SAMPLES: readonly Point[] = Array.from({ length: D.fusion.samples }, (_, j) => {
  const a = (2 * PI * j) / D.fusion.samples;
  return { x: cos(a), y: sin(a) };
});

/** The outline points of segment `s` in body coordinates. */
const outline = (s: PlanSegment): Point[] =>
  HULL_SAMPLES.map((p) => placeOn(s, s.rx * p.x, s.ry * p.y));

const NO_CARAPACE: Carapace = { count: 0, x: 0, y: 0, rx: 0, ry: 0, angle: 0, thickness: 0 };

/** One ellipse over the front `count` segments: along the axis from the rearmost fused centre to the core. */
function buildCarapace(segments: PlanSegment[], fusion: number, plating: number): Carapace {
  const count = Math.min(segments.length, Math.round(fusion * segments.length));
  if (count < 1) return { ...NO_CARAPACE };
  const last = segments[count - 1] as PlanSegment;
  const angle = count > 1 && (last.y !== 0 || last.angle !== 0) ? atan2(-last.y, -last.x) : 0;
  const axis: PlanSegment = { x: 0, y: 0, rx: 1, ry: 1, angle };
  // The points in the hull's frame: u along its axis, v across.
  const pts = segments.slice(0, count).flatMap(outline);
  const local = pts.map((p) => turnTo({ ...axis, angle: -angle }, p.x, p.y));
  const us = local.map((p) => p.x);
  const vs = local.map((p) => p.y);
  const cu = (Math.max(...us) + Math.min(...us)) / 2;
  const cv = (Math.max(...vs) + Math.min(...vs)) / 2;
  let rx = (Math.max(...us) - Math.min(...us)) / 2;
  let ry = (Math.max(...vs) - Math.min(...vs)) / 2;
  // Grow the box's ellipse until it holds every outline point, then keep it inside the bounds.
  let grow = 1;
  for (const p of local) grow = Math.max(grow, hypot((p.x - cu) / rx, (p.y - cv) / ry));
  rx *= grow;
  ry *= grow;
  const centre = placeOn(axis, cu, cv);
  const room = D.caps.bounds - D.boundsSlack - hypot(centre.x, centre.y);
  const fit = clamp(room / Math.max(rx, ry), D.epsilon, 1);
  return {
    count,
    x: centre.x,
    y: centre.y,
    rx: rx * fit,
    ry: ry * fit,
    angle,
    thickness: lerp(D.fusion.thickness, PLATE_THICKNESS[1], plating),
  };
}

/** The hull's half-width at the point of its axis nearest to `p`, and that point. */
function hullAt(c: Carapace, p: Point): Point & { r: number } {
  const frame: PlanSegment = { x: c.x, y: c.y, rx: 1, ry: 1, angle: c.angle };
  const u = turnTo({ ...frame, angle: -c.angle }, p.x - c.x, p.y - c.y).x;
  const along = clamp(u, -c.rx, c.rx);
  const q = placeOn(frame, along, 0);
  return { ...q, r: c.ry * Math.sqrt(Math.max(0, 1 - (along / c.rx) * (along / c.rx))) };
}

function buildEyes(shape: Traits['shape'], head: PlanSegment): PlanEyes {
  const E = D.eyes;
  if (!(shape.eyeSize > E.min)) return { count: 0, size: 0, stalk: 0, angle: 0, x: 0, y: 0 };
  const size = lerp(EYE_SIZE[0], EYE_SIZE[1], (shape.eyeSize - E.min) / (1 - E.min));
  const root = rootOf(head, E.angle);
  const room = D.caps.bounds - D.boundsSlack - hypot(root.x, root.y) - 2 * size;
  const stalk = clamp(lerp(EYE_STALK[0], EYE_STALK[1], shape.eyeStalk), 0, Math.max(0, room));
  const out = turnTo(head, cos(E.angle), sin(E.angle));
  return {
    count: 2,
    size,
    stalk,
    angle: E.angle,
    x: root.x + (stalk + size) * out.x,
    y: root.y + (stalk + size) * out.y,
  };
}

const colliderRadius = (r: number): number =>
  clamp(r, RULES.body.minColliderRadius, RULES.body.maxColliderRadius);

function buildColliders(
  segments: PlanSegment[],
  appendages: Appendage[],
  carapace: Carapace,
): Collider[] {
  const out: Collider[] = [{ x: 0, y: 0, r: 1 }];
  for (let i = 1; i < segments.length; i++) {
    const s = segments[i] as PlanSegment;
    if (i < carapace.count) {
      // A fused segment's circle sits on the shell's axis and fills its width there.
      const h = hullAt(carapace, s);
      const room = RULES.body.maxReach - D.epsilon - hypot(h.x, h.y);
      out.push({ x: h.x, y: h.y, r: colliderRadius(Math.min(h.r, room)) });
    } else {
      out.push({ x: s.x, y: s.y, r: colliderRadius(s.ry) });
    }
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
      const s = segments[a.segment] as PlanSegment;
      const root = rootOf(s, a.angle, a.side);
      const dir = dirOf(s, a);
      const along = a.length * D.colliderAlong;
      out.push({
        x: root.x + along * dir.x,
        y: root.y + along * dir.y,
        r: colliderRadius(a.width * D.colliderWidth),
      });
    }
  }
  return out;
}

export function develop(traits: Traits): BodyPlan {
  const shape = traits.shape;
  const form = formOf(shape, clamp(Math.floor(traits.body.segments), 1, D.caps.segments));
  const segments = buildSegments(traits, form);
  const count = segments.length;
  const R = D.radial;
  const parts = form.radial
    ? radialParts(traits, segments, shape.drape * R.drapeSweep)
    : bilateralParts(traits, segments, lerp(D.sweep, R.drapeSweep, shape.drape));

  const appendages = mirror(parts);
  const plating = traits.skin.plating;
  const carapace = buildCarapace(segments, shape.fusion, plating);
  const plates: Plate[] =
    plating < D.plateMin
      ? []
      : segments
          .map((_, segment) => ({
            segment,
            coverage: plating,
            thickness: lerp(PLATE_THICKNESS[0], PLATE_THICKNESS[1], plating),
          }))
          .slice(carapace.count); // the carapace covers the fused segments
  return {
    segments,
    appendages,
    plates,
    mouth: buildMouth(traits.mouth, form.radial),
    colliders: buildColliders(segments, appendages, carapace),
    flexibility: traits.body.flexibility * (1 - (D.fusion.stiffen * carapace.count) / count),
    form: { turn: form.turn, mode: form.mode, radial: form.radial },
    carapace,
    eyes: buildEyes(shape, segments[0] as PlanSegment),
  };
}

/** The furthest any part of the plan can reach from the core centre. */
export function planBounds(plan: BodyPlan): number {
  let bound = 0;
  for (const s of plan.segments) bound = Math.max(bound, hypot(s.x, s.y) + Math.max(s.rx, s.ry));
  for (const a of plan.appendages) {
    const s = plan.segments[a.segment];
    if (s === undefined) return Number.POSITIVE_INFINITY;
    const root = rootOf(s, a.angle, a.side);
    bound = Math.max(bound, hypot(root.x, root.y) + a.length * branchFactor(a.branches));
  }
  const c = plan.carapace;
  if (c.count > 0) bound = Math.max(bound, hypot(c.x, c.y) + Math.max(c.rx, c.ry));
  const e = plan.eyes;
  if (e.count > 0) bound = Math.max(bound, hypot(e.x, e.y) + e.size);
  return bound;
}

/** The v2 checks: curved neighbours overlap, the carapace, the eyes and a radial ring. */
function shapeViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  const n = plan.segments.length;
  for (const s of plan.segments) {
    if (!(s.rx > 0) || !(s.ry > 0)) bad.push('segment with no length or width');
  }
  for (let i = 1; i < n; i++) {
    const [p, s] = [plan.segments[i - 1], plan.segments[i]] as [PlanSegment, PlanSegment];
    const d = hypot(s.x - p.x, s.y - p.y);
    if (d === 0) continue;
    const [dx, dy] = [(s.x - p.x) / d, (s.y - p.y) / d];
    if (d >= radiusAlong(p, dx, dy) + radiusAlong(s, -dx, -dy)) {
      bad.push(`segments ${i - 1} and ${i} do not overlap`);
    }
  }
  const c = plan.carapace;
  if (c.count < 0 || c.count > n || c.count !== Math.floor(c.count)) {
    bad.push(`carapace: ${c.count} fused segments of ${n}`);
  } else if (c.count > 0 && (!(c.rx > 0) || !(c.ry > 0) || !(c.thickness > 0))) {
    bad.push('carapace with no size or thickness');
  }
  for (const p of plan.plates) {
    if (p.segment < c.count) bad.push(`plate under the carapace on segment ${p.segment}`);
  }
  const e = plan.eyes;
  if (e.count !== 0 && e.count !== 2) bad.push(`eyes: ${e.count} is not 0 or 2`);
  if (e.count > 0 && !(e.size >= EYE_SIZE[0] && e.size <= EYE_SIZE[1] && e.stalk >= 0)) {
    bad.push(`eyes: radius ${e.size} or stalk ${e.stalk} is outside the limits`);
  }
  if (plan.form.radial !== 0 && plan.form.radial !== 1) bad.push('form: radial is not 0 or 1');
  if (plan.form.radial === 1) {
    const left = plan.appendages.filter((a) => a.side === 1);
    if (left.length > D.radial.maxPairs) bad.push(`radial ring: ${left.length} pairs`);
    left.forEach((a, k) => {
      if (a.segment !== 0 || Math.abs(a.angle - ringAngle(k, left.length)) > D.epsilon) {
        bad.push('radial ring: parts are not evenly spaced round the core');
      }
    });
    if (plan.mouth.offset !== 0) bad.push('radial body: the mouth is not central');
  }
  return bad.length < 2 ? bad : [...new Set(bad)];
}

/** Every ADR 0006 and ADR 0025 cap and guarantee a plan must hold; an empty list means the plan is valid. */
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
  bad.push(...shapeViolations(plan));
  return bad;
}

/** A 64-bit hash of every number in the plan, in a fixed order. */
export function hashPlan(plan: BodyPlan): string {
  const h = new Hasher();
  const f = (...values: number[]): void => {
    for (const v of values) h.f64(v);
  };
  f(plan.segments.length, plan.flexibility);
  for (const s of plan.segments) f(s.x, s.y, s.rx, s.ry, s.angle);
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
  const { form: o, carapace: c, eyes: e } = plan;
  f(o.turn, o.mode, o.radial);
  f(c.count, c.x, c.y, c.rx, c.ry, c.angle, c.thickness);
  f(e.count, e.size, e.stalk, e.angle, e.x, e.y);
  return h.digest();
}

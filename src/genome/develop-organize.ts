// Development, organize stage: moved verbatim out of develop.ts (ADR 0045).

import { length as hypot, PI } from '../sim/math';
import type { Outline, Piece } from './develop-fit';
import * as fromFit from './develop-fit';
import * as fromParts from './develop-parts';
import type { Appendage, Part, PlanSegment } from './develop-plan';
import * as fromPlan from './develop-plan';
import {
  LEG_DIR,
  longest,
  measure,
  type Role,
  regionOf,
  rolesOf,
  SPOKE_PAIRS,
  spineShare,
  spokeVary,
} from './organism';

// Bound once: the test runner reads an import through a getter on every use, which costs a fifth of the
// 0.15 ms development budget (stats.test.ts) in these hot loops.
const { uncover, shape, ring } = fromFit;
const { D, branchWeight, rootOf, onAxis, dirOf, X } = fromPlan;
const { PLAIN, LAYOUT, separate } = fromParts;

/** Motile area: length × girth × beat over parts that beat at all, counting branches. */
export function motileArea(appendages: readonly Piece[]): number {
  let area = 0;
  for (const a of appendages) area += motileOf(a);
  return area;
}

/** One part's motile area: length × girth × beat, counting branches, if it beats at all. */
const motileOf = (a: Piece): number =>
  a.beat >= D.minBeat ? a.length * a.girth * a.beat * branchWeight(a) : 0;

/** Whether the left-side `parts`, mirrored, hold the instance cap: parts are capped by count only (ADR 0025). */
export const fits = (parts: Part[]): boolean => parts.length * 2 <= D.caps.appendages;

/** How thick the default ciliary band is drawn on a segment: at most `part.root` of its half-width (M6b T7). */
export const room = (segments: readonly PlanSegment[], seg: number): number =>
  D.part.root * (segments[seg] as PlanSegment).ry;

/** A pair of the default ciliary band, drawn at most `room` thick. */
function bandPart(segment: number, angle: number, index: number, room: number): Part {
  return {
    module: -1,
    segment,
    angle,
    dir: 0,
    length: D.band.length,
    base: D.band.length,
    width: Math.min(D.band.width, room),
    girth: D.band.width,
    taper: D.band.taper,
    curvature: 0,
    joints: D.band.joints,
    branches: 0,
    tip: D.band.tip,
    stiffness: D.band.stiffness,
    beat: D.band.beat,
    phase: index / D.band.pairs,
    ...PLAIN,
    ...LAYOUT,
    fringe: true,
  };
}

function bandParts(parts: Part[], segment: number, room: number): Part[] | null {
  // The free angles on the rear segment, rearmost first.
  const taken = parts.filter((p) => p.segment === segment).map((p) => p.angle);
  const slots = Math.floor((PI - 2 * D.angleMargin) / D.minAngleGap);
  const band: Part[] = [];
  for (let j = slots; j >= 0 && band.length < D.band.pairs; j--) {
    const angle = D.angleMargin + j * D.minAngleGap;
    if (taken.every((a) => Math.abs(a - angle) >= D.minAngleGap - D.epsilon)) {
      band.push(bandPart(segment, angle, band.length, room));
    }
  }
  return band.length === D.band.pairs ? band : null;
}

/**
 * A part turned to fringe (M6c T3, ADR 0041): cilia where it stood, at most `fringe.length` body
 * widths long, drawn `fringe.width` wide (a fine stroke), with the band's girth at most, beating as
 * the band does, with no branches or detail.
 */
function toFringe(p: Part, segments: readonly PlanSegment[], m = measure(segments)): Part {
  const B = D.band;
  const length = Math.min(p.length, longest('fringe', segments, m));
  const girth = Math.min(p.girth, B.width);
  const { role: _r, lo: _l, hi: _h, inner: _i, ...rest } = p;
  return {
    ...rest,
    ...PLAIN,
    ...LAYOUT,
    role: 'fringe',
    fringe: true,
    length,
    base: Math.min(p.base, length),
    girth,
    width: Math.min(p.width, girth, D.organism.fringe.width),
    taper: B.taper,
    curvature: 0,
    joints: B.joints,
    branches: 0,
    tip: B.tip,
    stiffness: B.stiffness,
    beat: B.beat,
  };
}

/**
 * Both sides of every part, pairs adjacent: left then right. A coil's leg shows only on the outer
 * side of its curve (ADR 0041): its inner instance is fringe, as long as the bounds leave room.
 */
export function mirror(parts: Part[], segments: readonly PlanSegment[]): Appendage[] {
  const m = parts.some((p) => p.inner) ? measure(segments) : undefined;
  const out: Appendage[] = [];
  for (const p of parts) {
    out.push(appendageOf(p, 1));
    if (!p.inner) {
      out.push(appendageOf(p, -1));
      continue;
    }
    const s = segments[p.segment] as PlanSegment;
    const root = rootOf(s, p.angle, -1);
    const free = D.caps.bounds - D.boundsSlack - hypot(root.x, root.y);
    const cilia = toFringe(p, segments, m);
    cilia.length = Math.min(cilia.length, free);
    out.push(appendageOf(cilia, -1));
  }
  return out;
}

/** One side of a part: its plan fields only, in the plan's order (no layout state). */
function appendageOf(p: Part, side: 1 | -1): Appendage {
  return {
    module: p.module,
    segment: p.segment,
    angle: p.angle,
    dir: p.dir,
    length: p.length,
    width: p.width,
    girth: p.girth,
    taper: p.taper,
    curvature: p.curvature,
    joints: p.joints,
    branches: p.branches,
    tip: p.tip,
    stiffness: p.stiffness,
    beat: p.beat,
    phase: p.phase,
    webbing: p.webbing,
    setae: p.setae,
    setaeLength: p.setaeLength,
    bulb: p.bulb,
    chela: p.chela,
    beads: p.beads,
    fringe: p.fringe,
    side,
  };
}

/**
 * Reads a bilateral body's parts by region (M6c T3, ADR 0041) and edits them in place: each keeps
 * to its role's length, legs to their sweep, and the parts past a region's count or the budget
 * become fringe (copies). Parts already fringe (the band) keep as they are.
 */
function organize(parts: Part[], segments: PlanSegment[]): Part[] {
  const limbs = parts.filter((p) => !p.fringe);
  const plan = { segments };
  const m = measure(segments);
  const roles = rolesOf(
    limbs.map((p) => regionOf(p, plan, m)),
    limbs.map((p) => p.length),
    limbs.map((p) => spineShare(segments, p.segment, p.angle, m)),
  );
  const role = new Map(limbs.map((p, i) => [p, roles[i] as Role]));
  return parts.map((p) => {
    const r = role.get(p);
    if (r === undefined) return p;
    if (r === 'fringe') return toFringe(p, segments, m);
    p.role = r;
    p.length = Math.min(p.length, longest(r, segments, m));
    p.base = Math.min(p.base, p.length);
    if (r === 'leg') [p.lo, p.hi] = LEG_DIR;
    return p;
  });
}

/** The motile area of `parts` once mirrored: a coil's leg counts once, and its inner fringe. */
function swimArea(parts: Part[], segments: readonly PlanSegment[]): number {
  const m = parts.some((p) => p.inner) ? measure(segments) : undefined;
  let area = 0;
  for (const p of parts) {
    const one = motileOf(p);
    area += p.inner ? one + motileOf(toFringe(p, segments, m)) : 2 * one;
  }
  return area;
}

/** `parts` without one pair: the last fringe pair if any (it shows least), else the last pair. */
function dropOne(parts: Part[]): Part[] {
  for (let i = parts.length - 1; i >= 0; i--) {
    if ((parts[i] as Part).fringe) return parts.filter((_, j) => j !== i);
  }
  return parts.slice(0, -1);
}

/**
 * Bilateral parts: spread, read by region (M6c T3), shaped, trimmed (fringe first, then in module
 * order), then a ciliary band if nothing swims.
 */
export function bilateralParts(
  built: Part[],
  segments: PlanSegment[],
  sweep: number,
  body: Outline,
  scales: readonly number[],
  coil: boolean,
): Part[] {
  const count = segments.length;
  for (const p of built) uncover(p, built, segments, body);
  const organized = organize(separate(built, count, scales), segments);
  // A coil's legs show on the outer side of its curve only (ADR 0041).
  if (coil) for (const p of organized) p.inner = p.role === 'leg';
  let parts = shape(organized, segments, sweep, body);
  // Trim pair by pair until the plan fits the part cap.
  while (!fits(parts)) parts = dropOne(parts);
  if (swimArea(parts, segments) >= D.minThrustArea) return parts;
  // Try the rear segment first, then the ones in front of it, before giving up any part.
  for (;;) {
    for (let seg = count - 1; seg >= 0; seg--) {
      const band = bandParts(parts, seg, room(segments, seg));
      const trial = band && shape(band, segments, sweep, body);
      if (trial && fits([...parts, ...trial])) return [...parts, ...trial];
    }
    parts = dropOne(parts);
  }
}

/**
 * A radial ring (M6c T3, ADR 0041): its first `SPOKE_PAIRS[1]` parts in module order are spokes,
 * repeated round the ring to at least `SPOKE_PAIRS[0]`, each `spokeVary` as long; the rest, and
 * `extra` (a band) before them, are fringe, set evenly between the spokes, `maxPairs` in all.
 */
function radialRing(all: Part[], extra: Part[], segments: readonly PlanSegment[]): Part[] {
  const [least, most] = SPOKE_PAIRS;
  const first = all.slice(0, most);
  const spokes: Part[] = [];
  for (let k = 0; first.length > 0 && (k < first.length || k < least); k++) {
    const p = { ...(first[k % first.length] as Part), role: 'spoke' as const };
    const vary = spokeVary(k, p);
    spokes.push({ ...p, length: p.length * vary, base: p.base * vary });
  }
  const m = measure(segments);
  const fringe = [...extra, ...all.slice(most).map((p) => toFringe(p, segments, m))].slice(
    0,
    D.radial.maxPairs - spokes.length,
  );
  const total = spokes.length + fringe.length;
  const out: Part[] = [];
  let [j, f] = [0, 0];
  for (let slot = 0; slot < total; slot++) {
    // Spoke j takes slot ⌊j × total ÷ spokes⌋, so the spokes stand evenly round the ring.
    const spoke = j < spokes.length && slot === Math.floor((j * total) / spokes.length);
    out.push(spoke ? (spokes[j++] as Part) : (fringe[f++] as Part));
  }
  return out;
}

/** Radial parts: spokes and fringe ringed, and a ciliary band joins the fringe if nothing swims. */
export function radialParts(
  all: Part[],
  segments: PlanSegment[],
  sweep: number,
  body: Outline,
): Part[] {
  const parts = ring(radialRing(all, [], segments), segments, sweep, body);
  if (2 * motileArea(parts) >= D.minThrustArea) return parts;
  const band = Array.from({ length: D.band.pairs }, (_, j) => bandPart(0, 0, j, room(segments, 0)));
  return ring(radialRing(all, band, segments), segments, sweep, body);
}

/** Where bristle `k` of `count` sits along a part, as a share of its length. */
export const bristleAt = (k: number, count: number): number => (k + 0.5) / count;

/** The farthest a point between `t0` and `t1` of a part's length lies from the core, on either side. */
function farAlong(s: PlanSegment, p: Part, t0: number, t1: number): number {
  let far = 0;
  // A segment on the axis mirrors its two sides exactly, so one side tells.
  for (const side of onAxis(s) ? ([1] as const) : ([1, -1] as const)) {
    const root = rootOf(s, p.angle, side);
    const dir = dirOf(s, { dir: p.dir, side });
    for (const t of [t0, t1]) {
      far = Math.max(far, hypot(root.x + t * p.length * dir.x, root.y + t * p.length * dir.y));
    }
  }
  return far;
}

/**
 * Setae on the final parts: the gene becomes a length (setae length × width × `length`, shortened
 * so every bristle stays in the bounds), then the body keeps `perBody`, cutting the shortest parts'
 * bristles first (ties: the later part first). Edits in place; mirror pairs stay equal.
 */
export function dress(parts: Part[], segments: PlanSegment[]): Part[] {
  const S = X.setae;
  for (const p of parts) {
    if (p.setae === 0) {
      p.setaeLength = 0;
      continue;
    }
    const s = segments[p.segment] as PlanSegment;
    const far = farAlong(s, p, bristleAt(0, p.setae), bristleAt(p.setae - 1, p.setae));
    const length = Math.min(
      p.setaeLength * p.girth * S.length,
      D.caps.bounds - D.boundsSlack - far,
    );
    if (!(length > D.epsilon)) {
      p.setae = 0;
      p.setaeLength = 0;
    } else {
      p.setaeLength = length;
    }
  }
  let excess = parts.reduce((sum, p) => sum + p.setae, 0) - S.perBody / 2;
  if (excess <= 0) return parts;
  const order = parts
    .map((p, i) => ({ p, i }))
    .sort((a, b) => a.p.length - b.p.length || b.i - a.i);
  for (const { p } of order) {
    if (excess <= 0) break;
    const cut = Math.min(p.setae, excess);
    p.setae -= cut;
    excess -= cut;
    if (p.setae === 0) p.setaeLength = 0;
  }
  return parts;
}

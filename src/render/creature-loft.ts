// The body (M6 T10): a smooth loft along the curved spine, as wide as the plan outline, with the
// walls between segments (look pass 3) and a thin shell over a carapace. Parts find the spine share
// they hang from on the loft's rings (`nearestStation`).

import type { BodyPlan, PlanSegment } from '../genome/develop';
import { clamp, lerp } from '../sim/math';
import { RULES } from '../sim/rules';
import type { MeshDetail } from './creature-detail';
import {
  type Mesh,
  MOTION_BELL,
  MOTION_RIGID,
  type Motion,
  NO_WALL,
  PART_BODY,
  PART_MOUTH,
  PART_PLATE,
  PART_SHELL,
} from './mesh-buffer';
import { along, type Line } from './spine';

const { cos, sin, sqrt, hypot, abs, min, max, PI } = Math;
const TAU = 2 * PI;

/** The body is this much thinner than wide, so the creature reads as a flat swimmer from above. */
export const BODY_DEPTH = 0.65;

/** Share of the bend radius a tube may fill: development's (`partCurve`). */
const FOLD = RULES.develop.part.fold;

/** The mouth marks the front of the body this far back (core radii) at least, so a small jaw still reads (M6 T21). */
const MOUTH_MIN_REACH = 0.2;

export const bodyMotion = (plan: BodyPlan, st: Station): Motion => ({
  spineX: st.nx,
  spineY: st.ny,
  rootX: 0,
  rootY: 0,
  motion: plan.form.radial ? MOTION_BELL : MOTION_RIGID,
  offset: 0,
  gain: 0,
  row: 0,
});

// ---------------------------------------------------------------------------------------------
// The spine

/** Ring `k` of `rings`, rear (0) to front: its arc share, denser toward both tips. */
function ringShare(k: number, rings: number): number {
  const u = 1 - k / (rings - 1);
  return 0.5 * u + 0.25 * (1 - cos(PI * u));
}

/** An ellipse's local frame: the point `(x, y)` relative to it, in units of its half-axes. */
function local(s: PlanSegment, x: number, y: number): { u: number; v: number } {
  const [dx, dy] = [x - s.x, y - s.y];
  const [c, n] = [cos(s.angle), sin(s.angle)];
  return { u: (dx * c + dy * n) / s.rx, v: (-dx * n + dy * c) / s.ry };
}

/** How far from `(x, y)`, inside segment `s`, the ray along `(dx, dy)` leaves it; -1 when the point is outside. */
function exit(s: PlanSegment, x: number, y: number, dx: number, dy: number): number {
  const p = local(s, x, y);
  const [c, n] = [cos(s.angle), sin(s.angle)];
  const du = (dx * c + dy * n) / s.rx;
  const dv = (-dx * n + dy * c) / s.ry;
  const C = p.u * p.u + p.v * p.v - 1;
  if (C > 1e-9) return -1;
  const A = du * du + dv * dv;
  const B = 2 * (p.u * du + p.v * dv);
  return (-B + sqrt(max(0, B * B - 4 * A * C))) / (2 * A);
}

export const inside = (s: PlanSegment, x: number, y: number): boolean => {
  const p = local(s, x, y);
  return p.u * p.u + p.v * p.v <= 1 + 1e-9;
};

/** The body's half-widths left and right of `(x, y)` across the normal `(nx, ny)`, and the widest segment there. */
function widthAt(
  segments: readonly PlanSegment[],
  x: number,
  y: number,
  nx: number,
  ny: number,
): { x: number; y: number; left: number; right: number; seg: number } {
  // The centre line can leave a narrow neck of a tight curl: pull the point into the nearest segment.
  if (!segments.some((s) => inside(s, x, y))) {
    let best = segments[0] as PlanSegment;
    let near = Number.POSITIVE_INFINITY;
    for (const s of segments) {
      const p = local(s, x, y);
      const d = hypot(p.u, p.v);
      if (d < near) [near, best] = [d, s];
    }
    let [lo, hi] = [0, 1];
    for (let i = 0; i < 30; i++) {
      const mid = (lo + hi) / 2;
      if (inside(best, x + (best.x - x) * mid, y + (best.y - y) * mid)) hi = mid;
      else lo = mid;
    }
    x += (best.x - x) * hi;
    y += (best.y - y) * hi;
  }
  let left = 0;
  let right = 0;
  let seg = 0;
  let widest = -1;
  segments.forEach((s, i) => {
    const l = exit(s, x, y, nx, ny);
    if (l < 0) return;
    const r = exit(s, x, y, -nx, -ny);
    left = max(left, l);
    right = max(right, r);
    if (l + r > widest) [widest, seg] = [l + r, i];
  });
  return { x, y, left, right, seg };
}

/** The loft rings, whose centres are where parts find the spine share they hang from. */
export type Spine = readonly Station[];

/** The loft ring centred nearest to `(x, y)`: the spine share a part there hangs from. */
export function nearestStation(spine: Spine, x: number, y: number): Station {
  let best = spine[0] as Station;
  let near = Number.POSITIVE_INFINITY;
  for (const st of spine) {
    const d = hypot(st.x - x, st.y - y);
    if (d < near) [near, best] = [d, st];
  }
  return best;
}

/** Where the lines of rings `a` and `b` cross, as a distance along `a`'s normal (left positive), or null. */
function crossing(a: Station, b: Station): number | null {
  const den = a.nx * b.ny - a.ny * b.nx;
  if (abs(den) < 1e-9) return null;
  return ((b.x - a.x) * b.ny - (b.y - a.y) * b.nx) / den;
}

/** One loft ring: its spine share, its distance from the front along the spine, centre, left normal and half-widths. */
export interface Station {
  s: number;
  from: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  left: number;
  right: number;
  seg: number;
  /** Its segment-wall coordinate (`wallsAlong`): a whole number on each wall between two segments. */
  wall: number;
}

/**
 * Where the walls between segments cross the centre line (look pass 3): the arc lengths at which
 * the segment an ellipse's own measure says a point belongs to steps rearward, where neighbours
 * overlap. A radial body's chain lies inside its bell, so it has none, nor has a lone cell.
 */
export function wallsAlong(plan: BodyPlan, line: Line): number[] {
  const segs = plan.segments;
  if (plan.form.radial === 1 || segs.length < 2) return [];
  const out: number[] = [];
  let owner = 0;
  for (let k = 0; k < line.x.length; k++) {
    const [x, y] = [line.x[k] as number, line.y[k] as number];
    let best = owner;
    let near = Number.POSITIVE_INFINITY;
    for (let i = owner; i < segs.length; i++) {
      const p = local(segs[i] as PlanSegment, x, y);
      const r = hypot(p.u, p.v);
      if (r < near) [near, best] = [r, i];
    }
    if (best > owner) {
      // Only a waist where both segments hold the point draws a wall; a gap or a part buried in its
      // neighbour does not. Where the owner skips a buried segment, the two that meet are checked.
      const prev = local(segs[owner] as PlanSegment, x, y);
      if (near <= 1 && hypot(prev.u, prev.v) <= 1) out.push(line.at[k] as number);
      owner = best;
    }
  }
  return out;
}

/** The wall coordinate at arc length `from`: 0.5 at the front tip, n on the nth wall, half a step past the last at the rear. */
function wallAt(walls: readonly number[], length: number, from: number): number {
  if (walls.length === 0) return NO_WALL;
  // The span is the number of walls the station has passed; the last span ends at `length`.
  let i = 0;
  while (i < walls.length && from > (walls[i] as number)) i++;
  const a = i === 0 ? 0 : (walls[i - 1] as number);
  const b = i === walls.length ? length : (walls[i] as number);
  const t = b > a ? clamp((from - a) / (b - a), 0, 1) : 0;
  // Between walls the coordinate runs a whole step; the end spans run half a step.
  const lo = i === 0 ? NO_WALL : i;
  const hi = i === walls.length ? i + NO_WALL : i + 1;
  return lerp(lo, hi, t);
}

/** Each plan's walls: plans are immutable and every rung of the detail ladder asks again. */
const WALLS = new WeakMap<BodyPlan, number[]>();

/**
 * The loft's rings, rear to front: on the centre line, across its normal, as wide as the body
 * outline there. Where the spine bends tighter than the body is wide, neighbouring rings would cross
 * and fold the surface, so each ring stops short of where its neighbours' lines cross it.
 */
export function stations(plan: BodyPlan, line: Line, d: MeshDetail): Station[] {
  const rings = d.bodyRings * plan.segments.length + 1;
  const walls = WALLS.get(plan) ?? wallsAlong(plan, line);
  if (!WALLS.has(plan)) WALLS.set(plan, walls);
  const out: Station[] = [];
  for (let k = 0; k < rings; k++) {
    const s = ringShare(k, rings);
    const c = along(line, s);
    // Left of forward.
    const [nx, ny] = [-c.fy, c.fx];
    const w = widthAt(plan.segments, c.x, c.y, nx, ny);
    out.push({
      s,
      from: s * line.length,
      x: w.x,
      y: w.y,
      nx,
      ny,
      left: w.left,
      right: w.right,
      seg: w.seg,
      wall: wallAt(walls, line.length, s * line.length),
    });
  }
  const limit = out.map((st) => ({ left: st.left, right: st.right }));
  for (let k = 0; k + 1 < rings; k++) {
    const [a, b] = [out[k] as Station, out[k + 1] as Station];
    const t = crossing(a, b);
    const u = crossing(b, a);
    const [la, lb] = [limit[k], limit[k + 1]] as [
      { left: number; right: number },
      { left: number; right: number },
    ];
    if (t !== null) {
      if (t > 0) la.left = min(la.left, FOLD * t);
      else la.right = min(la.right, -FOLD * t);
    }
    if (u !== null) {
      if (u > 0) lb.left = min(lb.left, FOLD * u);
      else lb.right = min(lb.right, -FOLD * u);
    }
  }
  return out.map((st, k) => ({ ...st, ...(limit[k] as { left: number; right: number }) }));
}

export function addBody(m: Mesh, plan: BodyPlan, rings: readonly Station[], d: MeshDetail): void {
  const ring = d.bodyRing;
  const mouthReach = max(plan.mouth.radius * 0.5, MOUTH_MIN_REACH);
  const first = m.count;
  for (const st of rings) {
    m.gait = bodyMotion(plan, st);
    m.wallCoord = st.wall;
    const depth = (BODY_DEPTH * (st.left + st.right)) / 2;
    const plate = plan.plates.find((p) => p.segment === st.seg);
    const mouth = st.from <= mouthReach;
    for (let j = 0; j < ring; j++) {
      const phi = (TAU * j) / ring;
      const fromTop = abs(((phi - PI / 2 + 3 * PI) % TAU) - PI);
      const plated = plate !== undefined && fromTop <= plate.coverage * PI;
      const kind = mouth ? PART_MOUTH : plated ? PART_PLATE : PART_BODY;
      const lift = kind === PART_PLATE && plate ? 1 + plate.thickness : 1;
      const across = cos(phi) * (cos(phi) >= 0 ? st.left : st.right);
      m.vertex(
        st.x + st.nx * across,
        st.y + st.ny * across,
        depth * lift * sin(phi),
        j / ring,
        st.s,
        st.s,
        st.s,
        0,
        kind,
      );
    }
  }
  m.wallCoord = NO_WALL;
  m.stitch(first, rings.length, ring);
}

/** The carapace: a thin glassy shell over the fused segments, on the plan's hull ellipse. */
export function addShell(m: Mesh, plan: BodyPlan, spine: Spine, d: MeshDetail): void {
  const c = plan.carapace;
  if (c.count < 1) return;
  const ring = d.bodyRing;
  const rings = d.bodyRings * c.count + 1;
  const [fx, fy] = [cos(c.angle), sin(c.angle)];
  const first = m.count;
  for (let k = 0; k < rings; k++) {
    const a = -c.rx * cos((PI * k) / (rings - 1));
    const half = c.ry * sqrt(max(0, 1 - (a / c.rx) * (a / c.rx)));
    const [x, y] = [c.x + fx * a, c.y + fy * a];
    const st = nearestStation(spine, x, y);
    const s = st.s;
    m.gait = bodyMotion(plan, st);
    for (let j = 0; j < ring; j++) {
      const phi = (TAU * j) / ring;
      const across = half * cos(phi);
      m.vertex(
        x - fy * across,
        y + fx * across,
        BODY_DEPTH * (1 + c.thickness) * half * sin(phi),
        j / ring,
        k / (rings - 1),
        s,
        s,
        0,
        PART_SHELL,
      );
    }
  }
  m.stitch(first, rings, ring);
}

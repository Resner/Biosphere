// One merged geometry per creature and level of detail (M3 T10, M6 T10, ADR 0025): a smooth loft
// along the curved spine for the body, a thin shell over a carapace, tapered tubes with joint beads,
// bulb tips and chela fingers for the parts, thin ribbons for setae, double-sided sheets for the
// membranes and lens spheres for the eyes. Development caps parts by count only; this builder fits
// each level's vertex budget on its own, by stepping down a ladder of detail (rings, bristles drawn,
// membrane rows), and never drops a part. Positions are in the body frame, x forward, y left, z up,
// in core radii. Plates and the mouth add no vertices: they mark body vertices through `aPart`.

import * as THREE from 'three';
import {
  type Appendage,
  type BodyPlan,
  dirOf,
  type Membrane,
  type PlanSegment,
  rootOf,
} from '../genome/develop';
import { clamp } from '../sim/math';
import { RULES } from '../sim/rules';
import type { PresetName } from './presets';

const { cos, sin, sqrt, atan2, hypot, abs, min, max, PI } = Math;
const TAU = 2 * PI;
const BRANCH = RULES.develop.branchScale;
const BOUNDS = RULES.develop.caps.bounds;

/** A creature's level of detail is a quality preset's: the budgets of ADR 0025. */
export type Lod = PresetName;
export const LOD_BUDGET: Readonly<Record<Lod, number>> = {
  high: 12_000,
  medium: 6_000,
  low: 1_500,
};

/** How finely a body is drawn; every count only ever falls down a ladder. */
export interface MeshDetail {
  /** Body rings per segment along the loft (even, so a ring crosses the middle of a lone cell). */
  bodyRings: number;
  /** Vertices round the body and a carapace. */
  bodyRing: number;
  /** Rings per joint of a part; 0 draws each part as one straight piece. */
  jointRings: number;
  /** Vertices round a part. */
  partRing: number;
  /** Vertices round a bulb's equator; 0 draws a bulb as a widened tip (eyes keep 4). */
  ball: number;
  /** Share of each part's bristles drawn. */
  setae: number;
  /** Vertices per bristle: 5 (bendable) or 3. */
  setaVertices: number;
  /** Rows of a membrane sheet from its root. */
  web: number;
}

const rung = (
  bodyRings: number,
  bodyRing: number,
  jointRings: number,
  partRing: number,
  ball: number,
  setae: number,
  setaVertices: number,
  web: number,
): MeshDetail => ({ bodyRings, bodyRing, jointRings, partRing, ball, setae, setaVertices, web });

/**
 * Each level's ladder, richest first; a body takes the first rung that fits its budget, then the
 * lower levels' rungs. The last low rung fits any plan development can make (24 parts of 4 joints
 * and 2 branches each, every detail on): about 1,200 vertices.
 */
export const LOD_LADDER: Readonly<Record<Lod, readonly MeshDetail[]>> = {
  high: [
    rung(10, 16, 4, 8, 8, 1, 5, 4),
    rung(8, 14, 3, 7, 8, 1, 5, 3),
    rung(8, 12, 3, 6, 6, 1, 3, 2),
    rung(6, 12, 2, 6, 6, 1, 3, 2),
  ],
  medium: [
    rung(6, 12, 3, 6, 6, 1, 3, 2),
    rung(6, 10, 2, 5, 6, 1, 3, 2),
    rung(4, 8, 2, 4, 4, 0.5, 3, 1),
    rung(4, 8, 1, 4, 4, 0.25, 3, 1),
  ],
  low: [
    rung(4, 8, 1, 4, 4, 0.5, 3, 1),
    rung(2, 6, 1, 3, 4, 0.25, 3, 1),
    rung(2, 6, 0, 3, 0, 0, 3, 1),
  ],
};
const FALLBACK: Readonly<Record<Lod, readonly MeshDetail[]>> = {
  high: [...LOD_LADDER.high, ...LOD_LADDER.medium, ...LOD_LADDER.low],
  medium: [...LOD_LADDER.medium, ...LOD_LADDER.low],
  low: LOD_LADDER.low,
};

/** The body is this much thinner than wide, so the creature reads as a flat swimmer from above. */
export const BODY_DEPTH = 0.85;
const TUBE_DEPTH = 0.8;
/** Total turn of a tube with curvature ±1, in radians. */
const CURVE = 1.2;
/** Share of the bend radius a tube may fill. */
const FOLD = 0.8;
/** Where on its parent a branch grows, and how far it fans out (radians): development's, so membranes meet the tubes. */
const BRANCH_AT = RULES.develop.branchAt;
const BRANCH_FAN = RULES.develop.branchFan;
/** The tip cap is this many end radii long for a blunt tip, plus this many more for a sharp one. */
const CAP_BLUNT = 0.3;
const CAP_SHARP = 2.2;
const CAP_SHARE = 0.3;
/** Every inner joint swells by at least this share, so jointed parts read as jointed. */
const JOINT_BEAD = 0.3;
/** A chela's palm swells by up to this share; its movable finger opens this far (radians) and is this long and wide. */
const PALM = 0.8;
const FINGER_OPEN = 0.45;
const FINGER_LENGTH = 0.9;
const FINGER_WIDTH = 0.55;
const FINGER_TAPER = 0.8;
/**
 * A bristle's base half-width, and its angle off its part's chord: near square at the base, swept
 * toward the tip along the part, so the bristles fan apart (on a curved part's inner side too).
 */
const SETA_WIDTH = 0.022;
const SETA_BASE = 1.5;
const SETA_SWEEP = 0.9;
/** An eye is this flat; its stalk this share of its radius wide. */
const EYE_DEPTH = 0.8;
const STALK_WIDTH = 0.3;
/** Samples per span of the spine's Catmull-Rom centre line. */
const SPAN_SAMPLES = 24;

/** What a vertex belongs to, the low four bits of `aPart`; the rest is the appendage number (0 for none). */
export const PART_KINDS = 16;
export const PART_BODY = 0;
export const PART_APPENDAGE = 1;
export const PART_PLATE = 2;
export const PART_MOUTH = 3;
export const PART_SHELL = 4;
export const PART_SETA = 5;
export const PART_MEMBRANE = 6;
export const PART_EYE = 7;
export const PART_STALK = 8;
export const partKind = (aPart: number): number => aPart % PART_KINDS;
export const partId = (aPart: number): number => Math.floor(aPart / PART_KINDS);

/**
 * How a vertex moves (`aMotion.x`, M6 T11; `gait.ts` has the motion): with the body (rigid on a
 * bilateral body, pulsing on a radial bell), or turning about its part's root as a beating part,
 * an antenna, a wing or a bell's tentacle.
 */
export const MOTION_RIGID = 0;
export const MOTION_BEAT = 1;
export const MOTION_ANTENNA = 2;
export const MOTION_WING = 3;
export const MOTION_TENTACLE = 4;
export const MOTION_BELL = 5;
/** The beat phase between the legs of neighbouring segments (radians): a metachronal wave from the rear forward. */
export const METACHRONAL = 0.9;
/** A part turns as if it reached at most this far from its root: longer parts turn less, so none sweeps further. */
export const PART_REACH = 0.7;
/** A part pointing within this angle of forward is an antenna. */
const ANTENNA_CONE = PI / 3;

/** One part's (or the body's) `aFrame` and `aMotion`: the spine normal, the root, the motion class, phase offset, side × gain and rowing share. */
interface Motion {
  spineX: number;
  spineY: number;
  rootX: number;
  rootY: number;
  motion: number;
  offset: number;
  gain: number;
  row: number;
}

const bodyMotion = (plan: BodyPlan, st: Station): Motion => ({
  spineX: st.nx,
  spineY: st.ny,
  rootX: 0,
  rootY: 0,
  motion: plan.form.radial ? MOTION_BELL : MOTION_RIGID,
  offset: 0,
  gain: 0,
  row: 0,
});

const NO_MOTION: Motion = {
  spineX: 0,
  spineY: 1,
  rootX: 0,
  rootY: 0,
  motion: MOTION_RIGID,
  offset: 0,
  gain: 0,
  row: 0,
};

/** Vertex and index buffers, or only a vertex count when `counting`. */
class Mesh {
  readonly position: number[] = [];
  readonly uv: number[] = [];
  readonly spine: number[] = [];
  readonly attach: number[] = [];
  readonly weight: number[] = [];
  readonly part: number[] = [];
  readonly frame: number[] = [];
  readonly motion: number[] = [];
  readonly flutter: number[] = [];
  /** How the next vertices move, and a bristle vertex's distance along its bristle. */
  gait: Motion = NO_MOTION;
  flutterAt = 0;
  /** Triangles of closed surfaces, then those of flat sheets drawn from both sides. */
  readonly index: number[] = [];
  readonly sheets: number[] = [];
  /** Vertices whose normal is set, not computed: [vertex, x, y, z]. */
  readonly fixed: number[] = [];
  count = 0;

  constructor(readonly counting: boolean) {}

  vertex(
    x: number,
    y: number,
    z: number,
    u: number,
    v: number,
    spine: number,
    attach: number,
    weight: number,
    part: number,
  ): number {
    if (!this.counting) {
      this.position.push(x, y, z);
      this.uv.push(u, v);
      this.spine.push(spine);
      this.attach.push(attach);
      this.weight.push(weight);
      this.part.push(part);
      const g = this.gait;
      this.frame.push(g.spineX, g.spineY, g.rootX, g.rootY);
      this.motion.push(g.motion, g.offset, g.gain, g.row);
      this.flutter.push(this.flutterAt);
    }
    return this.count++;
  }

  tri(a: number, b: number, c: number): void {
    if (!this.counting) this.index.push(a, b, c);
  }

  sheet(a: number, b: number, c: number): void {
    if (!this.counting) this.sheets.push(a, b, c);
  }

  normal(v: number, x: number, y: number, z: number): void {
    if (!this.counting) this.fixed.push(v, x, y, z);
  }

  /** Quads between `rings` rings of `ring` vertices from `first`, each ring one step forward. */
  stitch(first: number, rings: number, ring: number): void {
    for (let r = 0; r + 1 < rings; r++) {
      for (let j = 0; j < ring; j++) {
        const a = first + r * ring + j;
        const b = first + r * ring + ((j + 1) % ring);
        this.tri(a, b, a + ring);
        this.tri(b, b + ring, a + ring);
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The spine

/** The body's centre line: a dense polyline from the front tip (s = 0) to the rear tip (s = 1). */
interface Line {
  x: number[];
  y: number[];
  /** Arc length from the front at each point. */
  at: number[];
  length: number;
}

const forwardOf = (s: PlanSegment): { x: number; y: number } => ({
  x: cos(s.angle),
  y: sin(s.angle),
});

/** A centripetal Catmull-Rom curve through the front tip, every segment centre and the rear tip. */
function centreLine(segments: readonly PlanSegment[]): Line {
  const head = segments[0] as PlanSegment;
  const tail = segments[segments.length - 1] as PlanSegment;
  const hf = forwardOf(head);
  const tf = forwardOf(tail);
  const pts = [
    { x: head.x + hf.x * head.rx, y: head.y + hf.y * head.rx },
    ...segments.map((s) => ({ x: s.x, y: s.y })),
    { x: tail.x - tf.x * tail.rx, y: tail.y - tf.y * tail.rx },
  ];
  const n = pts.length;
  const p = (i: number) => {
    if (i < 0) {
      const [a, b] = [pts[0], pts[1]] as [(typeof pts)[0], (typeof pts)[0]];
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    if (i >= n) {
      const [a, b] = [pts[n - 1], pts[n - 2]] as [(typeof pts)[0], (typeof pts)[0]];
      return { x: 2 * a.x - b.x, y: 2 * a.y - b.y };
    }
    return pts[i] as (typeof pts)[0];
  };
  const line: Line = { x: [], y: [], at: [], length: 0 };
  const push = (x: number, y: number) => {
    const k = line.x.length;
    if (k > 0) line.length += hypot(x - (line.x[k - 1] as number), y - (line.y[k - 1] as number));
    line.x.push(x);
    line.y.push(y);
    line.at.push(line.length);
  };
  push(p(0).x, p(0).y);
  for (let i = 0; i + 1 < n; i++) {
    const [p0, p1, p2, p3] = [p(i - 1), p(i), p(i + 1), p(i + 2)];
    const knot = (a: { x: number; y: number }, b: { x: number; y: number }) =>
      max(sqrt(hypot(b.x - a.x, b.y - a.y)), 1e-6);
    const t1 = knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    const lerp = (
      a: { x: number; y: number },
      b: { x: number; y: number },
      ta: number,
      tb: number,
      t: number,
    ) => {
      const w = (t - ta) / (tb - ta);
      return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
    };
    for (let k = 1; k <= SPAN_SAMPLES; k++) {
      const t = t1 + ((t2 - t1) * k) / SPAN_SAMPLES;
      const a1 = lerp(p0, p1, 0, t1, t);
      const a2 = lerp(p1, p2, t1, t2, t);
      const a3 = lerp(p2, p3, t2, t3, t);
      const b1 = lerp(a1, a2, 0, t2, t);
      const b2 = lerp(a2, a3, t1, t3, t);
      const c = lerp(b1, b2, t1, t2, t);
      push(c.x, c.y);
    }
  }
  return line;
}

/** The point at arc share `s` (0 front, 1 rear) and the unit forward direction there. */
function along(line: Line, s: number): { x: number; y: number; fx: number; fy: number } {
  const target = clamp(s, 0, 1) * line.length;
  let lo = 0;
  let hi = line.at.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((line.at[mid] as number) <= target) lo = mid;
    else hi = mid;
  }
  const span = (line.at[hi] as number) - (line.at[lo] as number);
  const w = span > 0 ? (target - (line.at[lo] as number)) / span : 0;
  const [x0, y0] = [line.x[lo] as number, line.y[lo] as number];
  const [x1, y1] = [line.x[hi] as number, line.y[hi] as number];
  const d = hypot(x1 - x0, y1 - y0) || 1;
  // The line runs rearward, so forward is its reverse.
  return { x: x0 + (x1 - x0) * w, y: y0 + (y1 - y0) * w, fx: (x0 - x1) / d, fy: (y0 - y1) / d };
}

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

const inside = (s: PlanSegment, x: number, y: number): boolean => {
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
type Spine = readonly Station[];

/** The loft ring centred nearest to `(x, y)`: the spine share a part there hangs from. */
function nearestStation(spine: Spine, x: number, y: number): Station {
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
interface Station {
  s: number;
  from: number;
  x: number;
  y: number;
  nx: number;
  ny: number;
  left: number;
  right: number;
  seg: number;
}

/**
 * The loft's rings, rear to front: on the centre line, across its normal, as wide as the body
 * outline there. Where the spine bends tighter than the body is wide, neighbouring rings would cross
 * and fold the surface, so each ring stops short of where its neighbours' lines cross it.
 */
function stations(plan: BodyPlan, line: Line, d: MeshDetail): Station[] {
  const rings = d.bodyRings * plan.segments.length + 1;
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

function addBody(m: Mesh, plan: BodyPlan, rings: readonly Station[], d: MeshDetail): void {
  const ring = d.bodyRing;
  const mouthReach = plan.mouth.radius * 0.5;
  const first = m.count;
  for (const st of rings) {
    m.gait = bodyMotion(plan, st);
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
  m.stitch(first, rings.length, ring);
}

/** The carapace: a thin glassy shell over the fused segments, on the plan's hull ellipse. */
function addShell(m: Mesh, plan: BodyPlan, spine: Spine, d: MeshDetail): void {
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

// ---------------------------------------------------------------------------------------------
// Parts

/** A path in the xy plane whose heading turns evenly: start, heading, total turn and length. */
interface Path {
  x0: number;
  y0: number;
  heading: number;
  turn: number;
  len: number;
}

function pathAt(p: Path, t: number): { x: number; y: number; heading: number } {
  const heading = p.heading + p.turn * t;
  if (abs(p.turn) < 1e-6) {
    return { x: p.x0 + p.len * t * cos(p.heading), y: p.y0 + p.len * t * sin(p.heading), heading };
  }
  return {
    x: p.x0 + (p.len * (sin(heading) - sin(p.heading))) / p.turn,
    y: p.y0 - (p.len * (cos(heading) - cos(p.heading))) / p.turn,
    heading,
  };
}

interface Tube {
  path: Path;
  /** The radius at path share `t` of ring `i`. */
  radius: (t: number, i: number) => number;
  /** Length of the tip cap beyond the path's end. */
  cap: number;
  /** The spine share the part hangs from, its own `aPart`, and the weight at its base (null: rigid, 0 throughout). */
  attach: number;
  part: number;
  base: number | null;
}

/** A closed tube: `rings` rings along its path, then the tip vertex. */
function addTube(m: Mesh, tube: Tube, rings: number, ring: number): void {
  const { path } = tube;
  const first = m.count;
  for (let i = 0; i < rings; i++) {
    const t = i / (rings - 1);
    const at = pathAt(path, t);
    // A swelling never pushes a part past the bounds, where the plan keeps it.
    const r = min(tube.radius(t, i), max(tube.radius(t, -1), BOUNDS - hypot(at.x, at.y)));
    const weight = tube.base === null ? 0 : tube.base + (1 - tube.base) * t;
    for (let j = 0; j < ring; j++) {
      const phi = (TAU * j) / ring;
      const across = r * cos(phi);
      m.vertex(
        at.x - across * sin(at.heading),
        at.y + across * cos(at.heading),
        r * TUBE_DEPTH * sin(phi),
        j / ring,
        t,
        tube.attach,
        tube.attach,
        weight,
        tube.part,
      );
    }
  }
  const tip = pathAt(path, 1);
  const tipVertex = m.vertex(
    tip.x + tube.cap * cos(tip.heading),
    tip.y + tube.cap * sin(tip.heading),
    0,
    0.5,
    1,
    tube.attach,
    tube.attach,
    tube.base === null ? 0 : 1,
    tube.part,
  );
  m.stitch(first, rings, ring);
  const last = first + (rings - 1) * ring;
  for (let j = 0; j < ring; j++) m.tri(last + j, last + ((j + 1) % ring), tipVertex);
}

/** A sphere of `lon` vertices round its equator (`lon` ÷ 2 bands), squashed to `depth` in z, along `heading`. */
function addBall(
  m: Mesh,
  x: number,
  y: number,
  radius: number,
  heading: number,
  depth: number,
  lon: number,
  gait: { spine: number; attach: number; weight: number; part: number },
): void {
  const lat = max(2, lon >> 1);
  const [fx, fy] = [cos(heading), sin(heading)];
  const vertex = (a: number, across: number, z: number, u: number, v: number): number =>
    m.vertex(
      x + fx * a - fy * across,
      y + fy * a + fx * across,
      z,
      u,
      v,
      gait.spine,
      gait.attach,
      gait.weight,
      gait.part,
    );
  const rear = vertex(-radius, 0, 0, 0.5, 0);
  const first = m.count;
  for (let i = 1; i < lat; i++) {
    const theta = (PI * i) / lat;
    const a = -radius * cos(theta);
    const half = radius * sin(theta);
    for (let j = 0; j < lon; j++) {
      const phi = (TAU * j) / lon;
      vertex(a, half * cos(phi), half * depth * sin(phi), j / lon, i / lat);
    }
  }
  const front = vertex(radius, 0, 0, 0.5, 1);
  m.stitch(first, lat - 1, lon);
  const last = first + (lat - 2) * lon;
  for (let j = 0; j < lon; j++) {
    const k = (j + 1) % lon;
    m.tri(first + j, rear, first + k);
    m.tri(last + j, last + k, front);
  }
}

/**
 * Where part `a` leaves its segment, the way it grows, the spine share it hangs from, and how it
 * moves: a radial body's parts are tentacles, a webbed part (or one a membrane spans to) a wing, a
 * part pointing forward an antenna, and any other part beats, rowing as far as it stands out to
 * the side and whipping as far as it lies along the spine. Legs of one module beat `METACHRONAL`
 * apart per segment. The gain is the part's beat; `fitReach` lowers it for long parts.
 */
function rootFrame(plan: BodyPlan, spine: Spine, a: Appendage, webbed: boolean) {
  const s = plan.segments[a.segment] as PlanSegment;
  const root = rootOf(s, a.angle, a.side);
  const dir = dirOf(s, a);
  const st = nearestStation(spine, root.x, root.y);
  // The spine's forward at the root is its left normal turned back a right angle.
  const [fx, fy] = [st.ny, -st.nx];
  const rel = atan2(fx * dir.y - fy * dir.x, fx * dir.x + fy * dir.y);
  const motion = plan.form.radial
    ? MOTION_TENTACLE
    : webbed
      ? MOTION_WING
      : abs(rel) < ANTENNA_CONE
        ? MOTION_ANTENNA
        : MOTION_BEAT;
  const offset =
    motion === MOTION_BEAT
      ? TAU * a.phase - METACHRONAL * a.segment
      : motion === MOTION_ANTENNA
        ? TAU * a.phase
        : 0;
  const gait: Motion = {
    spineX: st.nx,
    spineY: st.ny,
    rootX: root.x,
    rootY: root.y,
    motion,
    offset,
    gain: a.side * (0.2 + 0.8 * clamp(a.beat, 0, 1)),
    row: motion === MOTION_BEAT ? abs(sin(rel)) : 0,
  };
  return { root, heading: atan2(dir.y, dir.x), attach: st.s, gait };
}

function addAppendage(
  m: Mesh,
  plan: BodyPlan,
  spine: Spine,
  a: Appendage,
  frame: ReturnType<typeof rootFrame>,
  id: number,
  d: MeshDetail,
): void {
  const { root, heading, attach } = frame;
  m.gait = frame.gait;
  const part = id * PART_KINDS + PART_APPENDAGE;
  const radius = a.width / 2;
  // The tip cap counts toward the part's length, so no part reaches past what development allowed.
  const cap = min(radius * (1 - a.taper) * (CAP_BLUNT + CAP_SHARP * a.tip), CAP_SHARE * a.length);
  const length = a.length - cap;
  // A tube cannot bend tighter than its own radius, or its inside folds over itself; a webbed part
  // straightens toward the rays its membrane spans.
  const fold = (FOLD * length) / radius;
  const bend = clamp(a.curvature * CURVE * (1 - a.webbing), -fold, fold);
  const path: Path = { x0: root.x, y0: root.y, heading, turn: a.side * bend, len: length };
  const rings = d.jointRings > 0 ? a.joints * d.jointRings + 1 : 2;
  const bead = 1 + max(JOINT_BEAD, a.beads);
  const joint = (i: number): boolean =>
    d.jointRings > 0 && i > 0 && i < rings - 1 && i % d.jointRings === 0;
  // A chela: the last joint is the fixed finger, its palm swells, and a movable finger opposes it.
  const palmAt = a.joints > 1 ? (a.joints - 1) / a.joints : 0.5;
  const palm = (t: number): number =>
    a.chela > 0 ? 1 + PALM * a.chela * max(0, 1 - abs(t - palmAt) / 0.3) : 1;
  const flatBulb = a.bulb > 0 && d.ball === 0;
  const profile =
    (r0: number, taper: number, bulb: number) =>
    (t: number, i: number): number => {
      const r = r0 * (1 - taper * t);
      if (i < 0) return r;
      if (flatBulb && i === rings - 1) return max(r, bulb);
      return r * (joint(i) ? bead : 1) * palm(t);
    };
  const main: Tube = {
    path,
    radius: profile(radius, a.taper, a.bulb),
    cap: flatBulb ? 0 : cap,
    attach,
    part,
    base: 0,
  };
  addTube(m, main, rings, d.partRing);
  const gait = { spine: attach, attach, weight: 1, part };
  if (a.bulb > 0 && !flatBulb) {
    const end = pathAt(path, 1);
    addBall(m, end.x, end.y, a.bulb, end.heading, TUBE_DEPTH, d.ball, gait);
  }
  if (a.chela > 0) {
    const from = pathAt(path, palmAt);
    const side = path.turn >= 0 ? 1 : -1;
    const fingerLength = FINGER_LENGTH * (1 - palmAt) * length;
    const fingerRadius = FINGER_WIDTH * radius * (1 - a.taper * palmAt);
    addTube(
      m,
      {
        path: {
          x0: from.x,
          y0: from.y,
          heading: from.heading - side * FINGER_OPEN * a.chela,
          turn: side * 2 * FINGER_OPEN * a.chela,
          len: fingerLength,
        },
        radius: (t) => fingerRadius * (1 - FINGER_TAPER * t),
        cap: min(
          fingerRadius * (1 - FINGER_TAPER) * (CAP_BLUNT + CAP_SHARP),
          CAP_SHARE * fingerLength,
        ),
        attach,
        part,
        base: palmAt,
      },
      max(2, d.jointRings + 1),
      d.partRing,
    );
  }
  const from = pathAt(path, BRANCH_AT);
  for (let b = 0; b < a.branches; b++) {
    const fan = a.side * (b === 0 ? BRANCH_FAN : -BRANCH_FAN);
    const branchPath: Path = {
      x0: from.x,
      y0: from.y,
      heading: from.heading + fan,
      turn: path.turn,
      len: length * BRANCH,
    };
    const branchBulb = a.bulb * BRANCH;
    addTube(
      m,
      {
        path: branchPath,
        radius: profile(radius * (1 - a.taper * BRANCH_AT) * BRANCH, a.taper, branchBulb),
        cap: flatBulb ? 0 : cap * BRANCH,
        attach,
        part,
        base: BRANCH_AT,
      },
      rings,
      d.partRing,
    );
    if (branchBulb > 0 && !flatBulb) {
      const end = pathAt(branchPath, 1);
      addBall(m, end.x, end.y, branchBulb, end.heading, TUBE_DEPTH, d.ball, gait);
    }
  }
  addSetae(m, plan, a, path, length, attach, id, d);
}

/** Which of `count` bristles a share draws: evenly spread, all of them at 1. */
const drawn = (k: number, share: number): boolean =>
  Math.ceil((k + 1) * share) > Math.ceil(k * share);

/** The part's bristles: thin tapered ribbons, alternating sides (away from the body), fanned toward the tip. */
function addSetae(
  m: Mesh,
  plan: BodyPlan,
  a: Appendage,
  path: Path,
  length: number,
  attach: number,
  id: number,
  d: MeshDetail,
): void {
  if (a.setae < 1 || d.setae <= 0) return;
  const part = id * PART_KINDS + PART_SETA;
  const end = pathAt(path, 1);
  const chord = atan2(end.y - path.y0, end.x - path.x0);
  for (let k = 0; k < a.setae; k++) {
    if (!drawn(k, d.setae)) continue;
    const share = (k + 0.5) / a.setae;
    const t = min(1, (share * a.length) / length);
    const at = pathAt(path, t);
    const off = SETA_BASE - SETA_SWEEP * share;
    // Sides alternate, but a bristle that would grow into the body grows from the other side.
    const into = (side: number): boolean => {
      const angle = chord + side * off;
      const [x, y] = [at.x + a.setaeLength * cos(angle), at.y + a.setaeLength * sin(angle)];
      return plan.segments.some((seg) => inside(seg, x, y));
    };
    const side = k % 2 === 0 ? 1 : -1;
    const angle = chord + (into(side) && !into(-side) ? -side : side) * off;
    const [dx, dy] = [cos(angle), sin(angle)];
    const [nx, ny] = [-dy, dx];
    // A bristle stops at the bounds, where development keeps every part.
    const ahead = at.x * dx + at.y * dy;
    const room =
      -ahead + sqrt(max(0, ahead * ahead - (at.x * at.x + at.y * at.y - BOUNDS * BOUNDS)));
    const len = max(0, min(a.setaeLength, room));
    const point = (share: number, half: number, v: number): number => {
      m.flutterAt = len * share;
      const i = m.vertex(
        at.x + dx * len * share + nx * half,
        at.y + dy * len * share + ny * half,
        0,
        0.5 + 0.5 * Math.sign(half),
        v,
        attach,
        attach,
        t,
        part,
      );
      m.normal(i, nx, ny, 0);
      return i;
    };
    const l0 = point(0, SETA_WIDTH, 0);
    const r0 = point(0, -SETA_WIDTH, 0);
    if (d.setaVertices >= 5) {
      const l1 = point(0.5, SETA_WIDTH * 0.5, 0.5);
      const r1 = point(0.5, -SETA_WIDTH * 0.5, 0.5);
      const tip = point(1, 0, 1);
      m.sheet(l0, r0, r1);
      m.sheet(l0, r1, l1);
      m.sheet(l1, r1, tip);
    } else {
      const tip = point(1, 0, 1);
      m.sheet(l0, r0, tip);
    }
  }
  m.flutterAt = 0;
}

/**
 * A membrane: a fan of rows from its first corner (the root of its part) out to its far edge, so
 * `uv` runs 0..1 across the sheet and 0..1 out from the root (veins follow both).
 */
function addMembrane(
  m: Mesh,
  plan: BodyPlan,
  sheet: Membrane,
  frame: ReturnType<typeof rootFrame>,
  d: MeshDetail,
): void {
  const { attach } = frame;
  m.gait = frame.gait;
  const owner = plan.appendages[sheet.part] as Appendage;
  const part = (sheet.part + 1) * PART_KINDS + PART_MEMBRANE;
  const pts = sheet.points;
  const p0 = pts[0] as { x: number; y: number };
  const edges = pts.length - 2;
  const rows = d.web;
  const cols = edges * rows;
  const reach = min(1, owner.webbing);
  const outer = (c: number): { x: number; y: number } => {
    const e = min(edges - 1, Math.floor(c / rows));
    const w = c / rows - e;
    const [a, b] = [pts[e + 1], pts[e + 2]] as [{ x: number; y: number }, { x: number; y: number }];
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w };
  };
  const vertex = (x: number, y: number, u: number, v: number): number => {
    const i = m.vertex(x, y, 0, u, v, attach, attach, v * reach, part);
    m.normal(i, 0, 0, 1);
    return i;
  };
  const root = vertex(p0.x, p0.y, 0, 0);
  const first = m.count;
  for (let r = 1; r <= rows; r++) {
    for (let c = 0; c <= cols; c++) {
      const o = outer(c);
      const f = r / rows;
      vertex(p0.x + (o.x - p0.x) * f, p0.y + (o.y - p0.y) * f, c / cols, f);
    }
  }
  const row = cols + 1;
  for (let c = 0; c < cols; c++) m.sheet(root, first + c, first + c + 1);
  for (let r = 0; r + 1 < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const a = first + r * row + c;
      m.sheet(a, a + row, a + row + 1);
      m.sheet(a, a + row + 1, a + 1);
    }
  }
}

/** Two lens spheres on the head, each on its stalk. */
function addEyes(m: Mesh, plan: BodyPlan, spine: Spine, d: MeshDetail): void {
  const e = plan.eyes;
  if (e.count < 2) return;
  const head = plan.segments[0] as PlanSegment;
  const st = nearestStation(spine, e.x, e.y);
  const attach = st.s;
  m.gait = bodyMotion(plan, st);
  const gait = { spine: attach, attach, weight: 0, part: PART_EYE };
  for (const side of [1, -1] as const) {
    const [x, y] = [e.x, side * e.y];
    const root = rootOf(head, e.angle, side);
    const len = hypot(x - root.x, y - root.y);
    if (e.stalk > 0.02 && len > 1e-6) {
      const r = e.size * STALK_WIDTH;
      addTube(
        m,
        {
          path: { x0: root.x, y0: root.y, heading: atan2(y - root.y, x - root.x), turn: 0, len },
          radius: () => r,
          cap: 0,
          attach,
          part: PART_STALK,
          base: null,
        },
        2,
        min(d.partRing, 6),
      );
    }
    addBall(m, x, y, e.size, 0, EYE_DEPTH, max(4, d.ball), gait);
  }
}

function addCreature(m: Mesh, plan: BodyPlan, d: MeshDetail): void {
  const spine = stations(plan, centreLine(plan.segments), d);
  const webbed = new Set(plan.membranes.flatMap((sheet) => [sheet.part, sheet.to]));
  const frames = plan.appendages.map((a, i) =>
    rootFrame(plan, spine, a, a.webbing > 0 || webbed.has(i)),
  );
  // Draw order (one draw call, no depth test): membranes, parts and bristles, the body, the shell, the eyes.
  for (const sheet of plan.membranes) {
    const frame = frames[sheet.part];
    if (frame) addMembrane(m, plan, sheet, frame, d);
  }
  plan.appendages.forEach((a, i) => {
    addAppendage(m, plan, spine, a, frames[i] as ReturnType<typeof rootFrame>, i + 1, d);
  });
  m.gait = NO_MOTION;
  addBody(m, plan, spine, d);
  addShell(m, plan, spine, d);
  addEyes(m, plan, spine, d);
}

/**
 * Scales each part's gain so it turns as if it reached `PART_REACH` at most: a long part sweeps no
 * further than a short one. Wings share the smallest gain, so a membrane moves with the parts it
 * spans between.
 */
function fitReach(m: Mesh): void {
  const reach = new Map<number, number>();
  const n = m.count;
  for (let i = 0; i < n; i++) {
    const id = partId(m.part[i] as number);
    if (id === 0) continue;
    const dx = (m.position[i * 3] as number) - (m.frame[i * 4 + 2] as number);
    const dy = (m.position[i * 3 + 1] as number) - (m.frame[i * 4 + 3] as number);
    const dz = m.position[i * 3 + 2] as number;
    reach.set(id, max(reach.get(id) ?? 0, sqrt(dx * dx + dy * dy + dz * dz)));
  }
  const scale = (id: number): number => min(1, PART_REACH / max(reach.get(id) ?? 0, 1e-9));
  let wing = Number.POSITIVE_INFINITY;
  for (let i = 0; i < n; i++) {
    if (m.motion[i * 4] !== MOTION_WING) continue;
    wing = min(wing, abs(m.motion[i * 4 + 2] as number) * scale(partId(m.part[i] as number)));
  }
  for (let i = 0; i < n; i++) {
    const id = partId(m.part[i] as number);
    if (id === 0) continue;
    const k = i * 4 + 2;
    const gain = m.motion[k] as number;
    m.motion[k] = m.motion[i * 4] === MOTION_WING ? Math.sign(gain) * wing : gain * scale(id);
  }
}

/** The vertices `plan` takes at one rung of detail. */
export function countVertices(plan: BodyPlan, detail: MeshDetail): number {
  const m = new Mesh(true);
  addCreature(m, plan, detail);
  return m.count;
}

/** The richest detail that keeps `plan` within its level's budget. */
export function meshDetail(plan: BodyPlan, lod: Lod): MeshDetail {
  return fit(plan, lod).detail;
}

const fitted = new WeakMap<BodyPlan, Partial<Record<Lod, Fit>>>();

interface Fit {
  detail: MeshDetail;
  count: number;
}

/** Plans are immutable, so the ladder search runs once per plan and level. */
function fit(plan: BodyPlan, lod: Lod): Fit {
  const byLod = fitted.get(plan) ?? {};
  fitted.set(plan, byLod);
  const found = byLod[lod] ?? search(plan, lod);
  byLod[lod] = found;
  return found;
}

function search(plan: BodyPlan, lod: Lod): Fit {
  const ladder = FALLBACK[lod];
  let count = 0;
  for (const detail of ladder) {
    count = countVertices(plan, detail);
    if (count <= LOD_BUDGET[lod]) return { detail, count };
  }
  return { detail: ladder[ladder.length - 1] as MeshDetail, count };
}

/** The vertices `buildCreatureGeometry(plan, lod)` makes. */
export function estimateVertices(plan: BodyPlan, lod: Lod): number {
  return fit(plan, lod).count;
}

/**
 * One indexed geometry for the whole creature. Attributes: position, normal, uv, aSpine, aAttach,
 * aWeight, aPart, and the motion's aFrame, aMotion and aFlutter (`gait.ts`).
 */
export function buildCreatureGeometry(plan: BodyPlan, lod: Lod): THREE.BufferGeometry {
  const m = new Mesh(false);
  addCreature(m, plan, meshDetail(plan, lod));
  fitReach(m);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(m.position, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(m.uv, 2));
  g.setAttribute('aSpine', new THREE.Float32BufferAttribute(m.spine, 1));
  g.setAttribute('aAttach', new THREE.Float32BufferAttribute(m.attach, 1));
  g.setAttribute('aWeight', new THREE.Float32BufferAttribute(m.weight, 1));
  g.setAttribute('aPart', new THREE.Float32BufferAttribute(m.part, 1));
  g.setAttribute('aFrame', new THREE.Float32BufferAttribute(m.frame, 4));
  g.setAttribute('aMotion', new THREE.Float32BufferAttribute(m.motion, 4));
  g.setAttribute('aFlutter', new THREE.Float32BufferAttribute(m.flutter, 1));
  // Normals from the closed surfaces and one side of each sheet; sheets and bristles keep their own.
  g.setIndex([...m.index, ...m.sheets]);
  g.computeVertexNormals();
  const normal = g.getAttribute('normal') as THREE.BufferAttribute;
  for (let k = 0; k < m.fixed.length; k += 4) {
    normal.setXYZ(
      m.fixed[k] as number,
      m.fixed[k + 1] as number,
      m.fixed[k + 2] as number,
      m.fixed[k + 3] as number,
    );
  }
  // Sheets are seen from either side: each triangle again, wound the other way.
  const back: number[] = [];
  for (let k = 0; k < m.sheets.length; k += 3) {
    back.push(m.sheets[k] as number, m.sheets[k + 2] as number, m.sheets[k + 1] as number);
  }
  g.setIndex([...m.index, ...m.sheets, ...back]);
  g.computeBoundingSphere();
  return g;
}

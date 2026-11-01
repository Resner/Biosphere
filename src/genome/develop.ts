// Development (ADR 0006, ADR 0025, ADR 0028): traits become a bounded, repaired body plan. Total and
// deterministic; the caps live here, never in the renderer. Lengths are in core radii (the core is
// radius 1 at the origin, x forward, y left). Appendages are built for the left side and mirrored,
// so every repair keeps the body bilateral. Development bends, profiles and fuses the segment
// chain, rings a radial body's parts and adds eyes, and dresses parts with fine detail (webbing,
// setae, bulbs, chelae, joint beads: M6 T8). Its proportions (M6 T14b, ADR 0028) give a trunk that
// carries the body, and parts fitted by their drawn reach.

import type { Collider } from '../sim/body';
import { Hasher } from '../sim/hash';
import { atan2, clamp, cos, length as hypot, lerp, PI, pow, sin, TAU } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Traits } from './express';
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
  /** The drawn base width: under karyotype v2 at most `part.root` of its root segment's half-width (M6b T7). */
  width: number;
  /**
   * The base width as the water meets it: its gene's (M6b T7, ADR 0039). A part thinned to fit its
   * segment is drawn edge-on, as a slimmed chain is (ADR 0031), so stats and bristles read this.
   */
  girth: number;
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
  /** Fine detail (M6 T8); each 0 is off. How far along its rays the part's membranes reach, 0-1. */
  webbing: number;
  /** Bristles, 0-24, evenly spaced along the part at (k + 0.5) ÷ count of its length, each `setaeLength` long. */
  setae: number;
  setaeLength: number;
  /** Radius of the bead on the tip. */
  bulb: number;
  /** 0, or how strongly the last joint opposes (0.5-1]: a claw. */
  chela: number;
  /** Joint swelling 0-1: each joint's radius is the part's × (1 + beads). */
  beads: number;
  /**
   * Fine cilia, not a limb (M6c T3, ADR 0041): a part past its region's count or the visible-part
   * budget, and the default ciliary band. Short and thin, it is drawn faint and counts as cilia.
   */
  fringe: boolean;
}

/**
 * A sheet of membrane in core radii: a convex polygon, counter-clockwise, inside the bounds. `part`
 * is the webbed appendage instance; `to` is the instance it spans to (itself for its branches).
 */
export interface Membrane {
  part: number;
  to: number;
  points: Point[];
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
  /**
   * The factor every segment's half-width was narrowed by so that a long chain reads long (look
   * pass 4, ADR 0031), else 1. The body is laterally compressed, not thinned: seen from above it is
   * narrower, but stats model it 1 ÷ `slim` as deep, so its cross-section, mass and drag hold (the
   * colliders and the mesh follow the drawn width).
   */
  slim: number;
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
  membranes: Membrane[];
}

/**
 * One left-side appendage; `develop` builds these and mirrors them at the end. `base` is the length
 * the v1 gene range gives it: a v2 part longer than that keeps what of the rest fits (look pass 4).
 */
type Part = Omit<Appendage, 'side'> & {
  base: number;
  /** Its role by region (M6c T3); none before the regions are read. */
  role: Role | undefined;
  /** The growth directions a leg keeps to while it is fitted (M6c T3): swept back from the side. */
  lo: number;
  hi: number;
  /** A coil's leg: its instance on the inner side of the curve is fringe (ADR 0041). */
  inner: boolean;
};
type Range = readonly [number, number];
export type Point = { x: number; y: number };

const range = (r: readonly number[]): Range => [r[0] as number, r[1] as number];
const STRETCH = range(D.stretch);
const LENGTH = range(D.length);
const WIDTH = range(D.width);
const TAPER = range(D.taper);
const CURVATURE = range(D.curvature);
const PLATE_THICKNESS = range(D.plateThickness);
const EYE_SIZE = range(D.eyes.size);
const EYE_STALK = range(D.eyes.stalk);
const TRUNK_HEAD = range(D.chain.trunk.head);
const X = D.detail;

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

/** Whether segment `s` lies on the axis, unturned: its two sides then mirror each other exactly. */
export const onAxis = (s: PlanSegment): boolean => s.angle === 0 && s.y === 0;

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

/** How the spine bends: everything of `PlanForm` but `slim`, which the chain's layout decides. */
type Bending = Omit<PlanForm, 'slim'>;

/**
 * The spine's tangent heading at `t` (0 the core, 1 the tail): a C (and a coil drawn by `bend`)
 * turns evenly; an S (M6b T6) rises evenly to half its turn at `peak`, then falls back to 0, so it
 * bends two opposite arcs of half the turn each.
 */
function heading(form: Bending, peak: number, t: number): number {
  if (form.mode !== 1) return form.turn * t;
  return (form.turn / 2) * (t <= peak ? t / peak : (1 - t) / (1 - peak));
}

const COIL_TURN = range(D.curve.coilTurn);

/**
 * The spine's turn and mode (M6b T6): a C turns curve × π; an S of `sFrom` segments or more two
 * opposite arcs of `sArc` × curve × π each (at most `sMax` × π), a shorter one of half the curve's
 * turn each; past `coilStart` a chain of `coilFrom` segments or more coils from `coilTurn[0]` × π
 * to `coilTurn[1]` × π, and any other chain (or any, without `coil`) takes the C-curl (ADR 0041).
 */
function formOf(shape: Traits['shape'], count: number, coil = true): Bending {
  const C = D.curve;
  const radial = shape.symmetry >= D.radial.at ? 1 : 0;
  if (count < 2 || !(shape.curve > 0)) return { turn: 0, mode: 0, radial };
  if (shape.curve > C.coilStart) {
    // The coil's gate (ADR 0041): a segment trait of `coilFrom` or more; else the C-curl. The
    // leg gate is `develop`'s, since it reads the parts.
    if (!coil || count < C.coilFrom) return { turn: PI * shape.curve, mode: 0, radial };
    const k = (shape.curve - C.coilStart) / (1 - C.coilStart);
    return { turn: PI * lerp(COIL_TURN[0], COIL_TURN[1], k), mode: 2, radial };
  }
  if (shape.curveMode >= C.sMode) {
    // A short chain has too few links to draw two arcs, so its S stays shallow.
    const arc = count >= C.sFrom ? Math.min(C.sArc * shape.curve, C.sMax) : shape.curve / 2;
    return { turn: 2 * PI * arc, mode: 1, radial };
  }
  return { turn: PI * shape.curve, mode: 0, radial };
}

/** The chain's shape before it is scaled: segment count, each segment's stretch and profile radius. */
function chainProfile(traits: Traits) {
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
  return { n, radius, stretchOf };
}

/**
 * How a v2 chain is drawn (M6b T5, ADR 0037): `plain` (a cell, a two-segment chain, a radial body),
 * `trunk` (one long body, widest at the trunk), `worm` (a trunk chain of `trunk.worm.from`
 * segments or more with no carapace, curled by `trunk.worm.curl` or more but not coiled: even and
 * slimmer) or `coil` (a chain of `chain.slimFrom` or more past `curve.coilStart`: a chambered
 * spiral, M6b T6).
 * The worm's curl is the one `silhouetteOf` reads, so a curled worm is drawn slimmer than its
 * straight twin (amends ADR 0031).
 */
type Build = 'plain' | 'trunk' | 'worm' | 'coil';

/** How many of a chain's front segments the carapace fuses. */
function fusedCount(fusion: number, n: number): number {
  return Math.min(n, Math.round(fusion * n));
}

function buildOf(traits: Traits, form: Bending, n: number): Build {
  const W = D.chain.trunk.worm;
  if (form.radial === 1 || n < D.chain.slimFrom) return 'plain';
  if (form.mode === 2) return 'coil';
  if (fusedCount(traits.shape.fusion, n) >= 2) return 'trunk';
  return n >= W.from && traits.shape.curve >= W.curl ? 'worm' : 'trunk';
}

function buildSegments(
  traits: Traits,
  form: Bending,
  build: Build,
): { segments: PlanSegment[]; slim: number } {
  if (build === 'coil') return { segments: coilOf(traits, form), slim: 1 };
  let chain = chainV2(traits, build);
  if (build !== 'plain') chain = slimTail(chain, traits.shape.fusion);
  // A radial body's chain lies inside its round core, so it neither grows nor slims.
  if (form.turn > 0 && form.radial === 0) return curled(chain, form, build);
  const narrow = slimming(chain, form, build);
  const straight = narrow < 1 ? chain.map((s) => ({ ...s, ry: s.ry * narrow })) : chain;
  return { segments: form.turn > 0 ? bend(straight, form) : straight, slim: narrow };
}

/** How far a chain's segments reach from the core centre (`planBounds`' measure of them). */
function farEdge(segments: readonly PlanSegment[]): number {
  let far = 0;
  for (const s of segments) far = Math.max(far, hypot(s.x, s.y) + Math.max(s.rx, s.ry));
  return far;
}

/**
 * Whether segments `a` and `b`, which are not neighbours, keep `curve.gap` of their summed radii
 * (along the line between their centres) apart (M6b T6).
 */
function apart(a: PlanSegment, b: PlanSegment): boolean {
  const d = hypot(b.x - a.x, b.y - a.y);
  if (!(d > 0)) return false;
  const [dx, dy] = [(b.x - a.x) / d, (b.y - a.y) / d];
  return d >= (1 + D.curve.gap) * (radiusAlong(a, dx, dy) + radiusAlong(b, -dx, -dy));
}

/** Whether every two segments of a chain that are not neighbours keep `apart`. */
function clear(segments: readonly PlanSegment[]): boolean {
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 2; j < segments.length; j++) {
      if (!apart(segments[i] as PlanSegment, segments[j] as PlanSegment)) return false;
    }
  }
  return true;
}

/**
 * The straight chain with every segment behind the head `grow` times as long, and each link longer
 * by as much as its two segments, so neighbours overlap as they did.
 */
function lengthen(chain: readonly PlanSegment[], grow: number): PlanSegment[] {
  const out: PlanSegment[] = [chain[0] as PlanSegment];
  for (let i = 1; i < chain.length; i++) {
    const [a, b] = [chain[i - 1], chain[i]] as [PlanSegment, PlanSegment];
    const front = i > 1 ? grow * a.rx : a.rx;
    const link = ((a.x - b.x) * (front + grow * b.rx)) / (a.rx + b.rx);
    out.push({ ...b, x: (out[i - 1] as PlanSegment).x - link, rx: grow * b.rx });
  }
  return out;
}

/**
 * A curled C or S chain fits the bounds along its curve, not laid straight (M6b T6, ADR 0038): its
 * segments and links grow by the largest factor, up to `curve.longer`, at which the curled pose
 * reaches no farther than the straight chain did. It is slimmed by its length along the curve (ADR
 * 0031), and further, by lateral compression too, if a tight bend would bring two segments that are
 * not neighbours together.
 */
function curled(
  chain: PlanSegment[],
  form: Bending,
  build: Build,
): { segments: PlanSegment[]; slim: number } {
  const C = D.curve;
  // As far as the straight chain reaches, slimmed as it is drawn.
  const straight = slimming(chain, form, build);
  const limit = farEdge(chain.map((s) => ({ ...s, ry: s.ry * straight }))) + D.epsilon;
  const lay = (grow: number, narrow: number): PlanSegment[] => {
    const long = grow === 1 ? chain : lengthen(chain, grow);
    return bend(narrow < 1 ? long.map((s) => ({ ...s, ry: s.ry * narrow })) : long, form);
  };
  const slimOf = (grow: number): number =>
    slimming(grow === 1 ? chain : lengthen(chain, grow), form, build);
  const reaches = (grow: number): boolean => farEdge(lay(grow, slimOf(grow))) <= limit;
  let grow = 1;
  if (reaches(C.longer)) grow = C.longer;
  else if (reaches(1)) {
    let hi = C.longer;
    for (let k = 0; k < C.steps; k++) {
      const mid = (grow + hi) / 2;
      if (reaches(mid)) grow = mid;
      else hi = mid;
    }
  }
  let narrow = slimOf(grow);
  let segments = lay(grow, narrow);
  // Measured along the curve, where a tight bend draws neighbours closer than laid straight.
  const aspect = aspectFor(chain, form, build);
  for (let k = 0; k < 2 * C.steps && aspect > 0; k++) {
    const along = spineLength(segments) / (2 * widestOf(segments));
    if (along >= aspect) break;
    // Narrower than the ratio, since a bend's links shorten as its segments narrow.
    const r = along / aspect;
    narrow *= r * r * (1 - 1e-4);
    segments = lay(grow, narrow);
  }
  if (!clear(segments)) {
    // The largest further narrowing that clears, to 2^−`steps`·2 of it.
    let [lo, hi] = [0, 1];
    for (let k = 0; k < 2 * C.steps; k++) {
      const mid = (lo + hi) / 2;
      if (clear(lay(grow, narrow * mid))) lo = mid;
      else hi = mid;
    }
    // Nothing clears (coincident centres): keep the pose, so `bodyViolations` names it, not a zero width.
    if (lo > 0) {
      narrow *= lo;
      segments = lay(grow, narrow);
    }
  }
  return { segments, slim: narrow };
}

/**
 * A coil (M6b T6, ADR 0038): a chambered spiral of `caps.segments` segments that turns `form.turn`
 * from the head to the tail. Every link turns alike and is `whorl` ^ (its turn ÷ 2π) as long as
 * the one in front, so the chambers lie on a logarithmic spiral and each whorl is `whorl` the size
 * of the one outside it. A chamber is `chamber` of its links long and as wide as the trunk profile
 * lets it, up to the widest that keeps it clear of the whorl inside it; the head is a share of the
 * widest chamber, and its link only as long as keeps the two overlapping. The spiral is then scaled
 * to reach as far as a trunk does.
 */
function coilOf(traits: Traits, form: Bending): PlanSegment[] {
  const C = D.curve;
  const n = D.caps.segments;
  const step = form.turn / (n - 1);
  const q = pow(C.whorl, step / TAU);
  const profile = trunkProfile(traits, n, 'coil');
  let top = 0;
  for (let i = 1; i < n; i++) top = Math.max(top, profile(i));
  const share = headShareOf(traits, 'coil');
  const stretch = chainProfile(traits).stretchOf(0);
  // Chamber i sits between links i and i + 1, of lengths q^(i − 1) and q^i: its size is between.
  const size = (i: number): number => pow(q, i - 0.5);
  const lay = (wide: number): PlanSegment[] => {
    const ry = [0];
    let widest = 0;
    for (let i = 1; i < n; i++) {
      // The shell tapers by its whorls; the trunk profile keeps only half its swing.
      ry.push(wide * size(i) * lerp(1, profile(i) / top, 0.5));
      widest = Math.max(widest, ry[i] as number);
    }
    const head = share * widest;
    const out: PlanSegment[] = [
      { x: 0, y: 0, rx: D.chain.trunk.headLength * stretch * head, ry: head, angle: 0 },
    ];
    for (let i = 1; i < n; i++) {
      const prev = out[i - 1] as PlanSegment;
      const h = (i - 0.5) * step;
      const [dx, dy] = [-cos(h), -sin(h)];
      const seg = { x: 0, y: 0, rx: C.chamber * size(i), ry: ry[i] as number, angle: i * step };
      // A link only reaches as far as keeps its two segments overlapping (the small head's does not).
      const fit = C.overlap * (radiusAlong(prev, dx, dy) + radiusAlong(seg, -dx, -dy));
      const d = Math.min(pow(q, i - 1), fit);
      out.push({ ...seg, x: prev.x + d * dx, y: prev.y + d * dy });
    }
    return out;
  };
  // The widest chambers that keep clear of the whorl inside them, in 1/32 of a link. Too narrow a
  // chamber shortens its links to overlap its neighbours, and the spiral bunches, so search down.
  let unit = lay(1 / 32);
  for (let k = 0; k < 31; k++) {
    const trial = lay(1 - k / 32);
    if (clear(trial)) {
      unit = trial;
      break;
    }
  }
  // As large as reaches as far as a trunk does, but at most `curve.coiled` times as long as the
  // straight trunk the same genes lay out.
  const straight = slimTail(chainV2(traits, 'trunk'), traits.shape.fusion);
  const scale = Math.min(
    D.chain.trunk.reach / farEdge(unit),
    (C.coiled * spineLength(straight)) / spineLength(unit),
  );
  return unit.map((s) => ({
    x: s.x * scale,
    y: s.y * scale,
    rx: s.rx * scale,
    ry: s.ry * scale,
    angle: s.angle,
  }));
}

/** How much of the trunk profile's swing a chain keeps: a worm only `trunk.even` of it. */
const swingOf = (build: Build): number => (build === 'worm' ? D.chain.trunk.even : 1);

/**
 * The trunk profile (M6b T5, ADR 0037): segment `i`'s width share along a chain of `n`, rising
 * behind the head to its peak at `trunk.at`, then narrowing to the tail. Each factor is concave or
 * a triangle, so their product has one peak: behind it every segment is narrower than the one in
 * front. A worm keeps only `trunk.even` of the swing, so it is even.
 */
function trunkProfile(traits: Traits, n: number, build: Build): (i: number) => number {
  const { body, shape } = traits;
  const T = D.chain.trunk;
  const G = D.tagmata;
  const k = swingOf(build);
  return (i) => {
    const t = i / (n - 1);
    const front = 1 - k * T.rise * Math.max(0, 1 - t / T.at);
    const behind = Math.max(0, (t - T.at) / (1 - T.at));
    const rear = 1 - k * (T.drop + body.taper * D.taperDrop) * behind;
    const swell = 1 + k * G.trunk * shape.trunkSwell * peak(t, T.at, G.trunkSpread);
    const tail = clamp((t - (1 - G.tailShare)) / G.tailShare, 0, 1);
    return front * rear * swell * (1 - k * G.tailTaper * shape.tailTaper * tail);
  };
}

/** The head's half-width as a share of the trunk's widest (head scale and symmetry raise it). */
function headShareOf(traits: Traits, build: Build): number {
  const [lo, hi] = TRUNK_HEAD;
  const { shape } = traits;
  return lerp(lerp(hi - swingOf(build) * (hi - lo), hi, shape.headScale), hi, shape.symmetry);
}

/**
 * A fused chain's free tail (M6b T5): behind a carapace of 2 or more segments, the free segments
 * narrow by one factor to at most `trunk.freeTail` of the widest fused one, so the carapace reads as
 * an oval front with a slim tail. The fused count is the carapace's (`buildCarapace`).
 */
function slimTail(chain: PlanSegment[], fusion: number): PlanSegment[] {
  const count = fusedCount(fusion, chain.length);
  if (count < 2 || count >= chain.length) return chain;
  let fused = 0;
  let free = 0;
  for (let i = 0; i < chain.length; i++) {
    const r = (chain[i] as PlanSegment).ry;
    if (i < count) fused = Math.max(fused, r);
    else free = Math.max(free, r);
  }
  if (!(free > 0)) return chain;
  const k = Math.min(1, (D.chain.trunk.freeTail * fused) / free);
  if (k >= 1) return chain;
  return chain.map((s, i) => (i < count ? s : { ...s, ry: s.ry * k }));
}

/** A straight chain's length (the head's front to the tail's end) per width (its widest segment). */
function aspectOf(segments: readonly PlanSegment[]): number {
  const head = segments[0] as PlanSegment;
  const tail = segments[segments.length - 1] as PlanSegment;
  return (head.x + head.rx - (tail.x - tail.rx)) / (2 * widestOf(segments));
}

/**
 * Body proportions v3 (look pass 4, ADR 0031): the factor that narrows a bilateral chain of
 * `chain.slimFrom` segments or more to `chain.aspect` times as long as wide (a worm to
 * `trunk.worm.aspect`, M6b T5), every segment alike, so the head and trunk keep their profile and
 * the chain keeps its length; 1 for any other body. The chain is measured laid straight with the
 * length it has along its curve (M6b T6).
 */
function slimming(straight: PlanSegment[], form: Bending, build: Build): number {
  const aspect = aspectFor(straight, form, build);
  return aspect > 0 ? Math.min(1, aspectOf(straight) / aspect) : 1;
}

/** How many times as long as wide a chain must be: 0 for a body that is never slimmed. */
function aspectFor(chain: readonly PlanSegment[], form: Bending, build: Build): number {
  const C = D.chain;
  if (form.radial === 1 || chain.length < C.slimFrom) return 0;
  return build === 'worm' ? C.trunk.worm.aspect : C.aspect;
}

/** A chain's length along its spine: the head's front, through every link, to the tail's end. */
function spineLength(segments: readonly PlanSegment[]): number {
  let length = (segments[0] as PlanSegment).rx + (segments[segments.length - 1] as PlanSegment).rx;
  for (let i = 1; i < segments.length; i++) {
    const [a, b] = [segments[i - 1], segments[i]] as [PlanSegment, PlanSegment];
    length += hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/** Twice the widest half-width of a chain is its width. */
function widestOf(segments: readonly PlanSegment[]): number {
  let w = 0;
  for (const s of segments) w = Math.max(w, s.ry);
  return w;
}

/**
 * The v2 head in front of a chain: `chain.head` of the v1 head's size without head scale, so the
 * trunk can carry the body, the v1 size at head scale 1, and round and whole as symmetry rises. Its
 * half-length never falls below v1's shortest. A single cell keeps the v1 head.
 */
function headOf(traits: Traits): { rx: number; ry: number } {
  const { shape } = traits;
  const { n, stretchOf } = chainProfile(traits);
  if (n < 2) return { rx: stretchOf(0), ry: 1 };
  const share = lerp(lerp(D.chain.head, 1, shape.headScale), 1, shape.symmetry);
  return { rx: Math.max(STRETCH[0], stretchOf(0) * share), ry: share };
}

/**
 * The v2 chain (ADR 0028): the segments behind the head are `chain.width` core radii wide along the
 * tagma profile, and the chain fits its reach by shortening its segments first, down to
 * `chain.squash` of their width, and only then narrowing; a big head then narrows it by
 * 1 ÷ (1 + `tagmata.head` × head scale). Neighbours sit `segmentSpacing` of their summed
 * half-lengths apart, so they always overlap. A `trunk` or `worm` build (M6b T5) lays the segments
 * out along `trunkProfile` and sizes the head by the trunk.
 */
function chainV2(traits: Traits, build: Build): PlanSegment[] {
  const C = D.chain;
  const trunked = build !== 'plain';
  const profile = chainProfile(traits);
  const { n, stretchOf } = profile;
  const radius = trunked ? trunkProfile(traits, n, build) : profile.radius;
  const width = [0];
  const along = [0];
  // sum[i]: segment i's distance behind the head's end of the chain, in half-lengths at full size.
  const sum = [0];
  let widest = 0;
  const base = trunked ? C.trunk.width : C.width;
  for (let i = 1; i < n; i++) {
    const r = radius(i);
    width.push(base * r);
    widest = Math.max(widest, width[i] as number);
    // A trunk chain's segments narrow faster than they shorten, so its tail stays a tail.
    const long = trunked ? base * Math.sqrt(r) : (width[i] as number);
    along.push(long * stretchOf(i));
    sum.push(
      (sum[i - 1] as number) + (i > 1 ? (along[i - 1] as number) : 0) + (along[i] as number),
    );
  }
  // Head scale narrows the chain behind the head (ADR 0028). On one long body (M6b T5) the head
  // is a share of the trunk's widest segment as drawn, and head scale raises that share.
  const big = 1 / (1 + D.tagmata.head * traits.shape.headScale);
  const share = trunked ? headShareOf(traits, build) * big * widest : 0;
  const { rx: head, ry } = trunked
    ? { rx: C.trunk.headLength * stretchOf(0) * share, ry: share }
    : headOf(traits);
  const out: PlanSegment[] = [{ x: 0, y: 0, rx: head, ry, angle: 0 }];
  if (n < 2) return out;
  // A radial body keeps its chain inside its round core (M6b T7: from symmetry 0.5, so the chain
  // never covers the ring's roots).
  const radial = traits.shape.symmetry >= D.radial.at;
  const reach = radial ? head : trunked ? C.trunk.reach : C.reach;
  const room = reach - D.segmentSpacing * head;
  // Shorten first: the largest squash at which every segment's far edge stays in reach.
  let squash = 1;
  for (let i = 1; i < n; i++) {
    const s = D.segmentSpacing * (sum[i] as number);
    squash = Math.min(squash, (room - (width[i] as number)) / s, room / (s + (along[i] as number)));
  }
  // Then narrow: one scale for the whole chain at the shortest squash.
  let scale = 1;
  if (!(squash >= C.squash)) {
    squash = C.squash;
    for (let i = 1; i < n; i++) {
      const extent =
        D.segmentSpacing * squash * (sum[i] as number) +
        Math.max(squash * (along[i] as number), width[i] as number);
      scale = Math.min(scale, room / extent);
    }
  }
  // A narrowed trunk narrows the head in proportion; its length stays laid out.
  if (trunked) out[0] = { x: 0, y: 0, rx: head, ry: ry * scale, angle: 0 };
  for (let i = 1; i < n; i++) {
    out.push({
      x: -(D.segmentSpacing * (head + squash * scale * (sum[i] as number))),
      y: 0,
      rx: squash * scale * (along[i] as number),
      ry: big * scale * (width[i] as number),
      angle: 0,
    });
  }
  return out;
}

/** Lays the straight chain along the curve: same links, turned by the tangent, neighbours overlapping. */
function bend(straight: PlanSegment[], form: Bending): PlanSegment[] {
  const n = straight.length;
  // An S peaks at the middle segment (the front one of two), so the segments show both arcs whole.
  const peak = Math.round((n - 1) / 2) / (n - 1);
  const out: PlanSegment[] = [straight[0] as PlanSegment];
  for (let i = 1; i < n; i++) {
    const prev = out[i - 1] as PlanSegment;
    const s = straight[i] as PlanSegment;
    const phi = PI + heading(form, peak, (i - 0.5) / (n - 1));
    const dx = cos(phi);
    const dy = sin(phi);
    const seg = { ...s, angle: heading(form, peak, i / (n - 1)) };
    let d = (straight[i - 1] as PlanSegment).x - s.x;
    d = Math.min(d, D.curve.overlap * (radiusAlong(prev, dx, dy) + radiusAlong(seg, -dx, -dy)));
    out.push({ ...seg, x: prev.x + d * dx, y: prev.y + d * dy });
  }
  return out;
}

/**
 * How thick a part may be on each segment (M6b T7, ADR 0039): `part.root` of the segment's drawn
 * half-width, so legs on a slim trunk are thin. The gene's width range scales down to it, as a share.
 */
function widthScales(segments: readonly PlanSegment[]): number[] {
  return segments.map((s) => Math.min(1, (D.part.root * s.ry) / WIDTH[1]));
}

/**
 * A part's drawn width from its gene's at its segment's scale `k`: never thinner than `part.floor`
 * (or its gene) where the segment has room for it, so a thin leg still shows at a small size.
 */
const drawnWidth = (gene: number, k: number): number =>
  Math.max(gene * k, Math.min(gene, D.part.floor, k * WIDTH[1]));

/** Parts root along the front `rooms` segments (a coil's outer whorl, M6b T7; else all of them). */
function buildParts(traits: Traits, scales: readonly number[], rooms: number): Part[] {
  const n = rooms;
  const parts: Part[] = [];
  let malformed = traits.defects.partScale;
  traits.modules.forEach((mod, slot) => {
    if (!mod.present) return;
    const p = mod.params;
    const x = mod.ext;
    const scale = malformed;
    malformed = 1; // only the first present module is the malformed part
    const pairs = 1 + Math.floor((p.pairs * D.caps.pairs) / 256);
    const t0 = unit(p.attachStart);
    const reach = unit(p.attachSpan) * (1 - t0);
    const gene = lerp(WIDTH[0], WIDTH[1], unit(p.thickness)) * scale;
    const tip = unit(p.tipShape);
    const base = baseLength(p.length) * scale;
    for (let k = 0; k < pairs; k++) {
      const t = pairs > 1 ? t0 + (reach * k) / (pairs - 1) : t0;
      const segment = Math.min(n - 1, Math.floor(t * n));
      const width = drawnWidth(gene, scales[segment] as number);
      parts.push({
        module: slot,
        segment,
        angle: D.angleMargin + (PI - 2 * D.angleMargin) * unit(p.angle),
        dir: 0,
        length: partLength(p.length) * scale,
        base,
        width,
        girth: gene,
        taper: lerp(TAPER[0], TAPER[1], unit(p.taper)),
        curvature: lerp(CURVATURE[0], CURVATURE[1], unit(p.curvature)),
        joints: 1 + Math.floor((p.joints * D.caps.joints) / 256),
        branches: Math.floor((p.branching * (D.caps.branches + 1)) / 256),
        tip,
        stiffness: unit(p.stiffness),
        beat: unit(p.beat),
        phase: unit(p.phase),
        webbing: x.webbing,
        setae: x.setaeLength > 0 ? Math.round(x.setaeDensity * X.setae.perPart) : 0,
        // The gene for now: `dress` turns it into a length once the part's reach is known.
        setaeLength: x.setaeLength,
        bulb: x.bulb > X.bulb.min ? x.bulb * gene * X.bulb.scale : 0,
        chela: x.chela > X.chela.min && isWeaponTip(tip) ? x.chela : 0,
        beads: x.beads,
        fringe: false,
        ...LAYOUT,
      });
    }
  });
  return parts;
}

/** A part's base length in core radii: the gene's plain range, which a part always keeps if it fits. */
export function baseLength(byte: number): number {
  return lerp(LENGTH[0], LENGTH[1], unit(byte));
}

/**
 * A part's gene length in core radii: `baseLength`, with a long end that reaches `long.max` at the
 * top of the gene (look pass 4), so antennae and tentacles can sweep round the body. Below
 * `long.knee` both agree.
 */
export function partLength(byte: number): number {
  const u = unit(byte);
  const past = Math.max(0, (u - D.long.knee) / (1 - D.long.knee));
  return baseLength(byte) + (D.long.max - LENGTH[1]) * past * past;
}

/** How much of a weapon a tip is (pointed to hooked tips); stats prices it, chela needs it above 0. */
export const weaponShare = (tip: number): number =>
  peak(tip, RULES.stats.weaponTip, RULES.stats.weaponSpread);

const isWeaponTip = (tip: number): boolean => weaponShare(tip) > 0;

/** Layout state every part starts with, so all parts share one object shape (hot loops stay monomorphic). */
const LAYOUT = { role: undefined, lo: 0, hi: PI, inner: false } as const;
/** No fine detail: a v1 part. */
const PLAIN = { webbing: 0, setae: 0, setaeLength: 0, bulb: 0, chela: 0, beads: 0 } as const;

/**
 * Parts on one segment keep `minAngleGap` apart: later ones are pushed round, and one with no room
 * merges into its neighbour. Edits the parts in place; the stable sort keeps module and pair order
 * among equal angles.
 */
function separate(parts: Part[], count: number, scales: readonly number[]): Part[] {
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
        // The merged part is as broad as both genes, drawn as thin as its segment allows.
        prev.girth = Math.min(WIDTH[1], hypot(prev.girth, p.girth));
        prev.width = drawnWidth(prev.girth, scales[s] as number);
        prev.beat = Math.max(prev.beat, p.beat);
        dropped.add(p);
      }
    }
  }
  return parts.filter((p) => !dropped.has(p));
}

/** What a part's drawn centre line depends on. */
type Curved = Pick<
  Appendage,
  'angle' | 'dir' | 'side' | 'length' | 'width' | 'taper' | 'tip' | 'curvature' | 'webbing'
>;

/**
 * A part's centre line as the mesh draws it: from its root at `heading`, an arc of `len` that turns
 * by `turn` (signed, body frame), then a straight tip cap of `cap` along the end heading; `len` plus
 * `cap` is the part's length. The arc turns with curvature (less with webbing, so a webbed part
 * keeps to the rays its membrane spans) and never tighter than `fold` of its half-width.
 */
export interface PartCurve {
  x0: number;
  y0: number;
  heading: number;
  turn: number;
  len: number;
  cap: number;
}

/** A part's tip cap and how far its arc bends (left side; the right turns the other way). */
function capAndBend(
  a: Omit<Curved, 'side' | 'angle' | 'dir'>,
  webbing = a.webbing,
): { cap: number; bend: number } {
  const P = D.part;
  const radius = a.width / 2;
  const cap = Math.min(
    radius * (1 - a.taper) * (P.capBlunt + P.capSharp * a.tip),
    P.capShare * a.length,
  );
  const fold = (P.fold * (a.length - cap)) / radius;
  return { cap, bend: clamp(a.curvature * P.turn * (1 - webbing), -fold, fold) };
}

export function partCurve(s: PlanSegment, a: Curved): PartCurve {
  const root = rootOf(s, a.angle, a.side);
  const { cap, bend } = capAndBend(a);
  return {
    x0: root.x,
    y0: root.y,
    heading: s.angle + a.side * a.dir,
    turn: a.side * bend,
    len: a.length - cap,
    cap,
  };
}

/** The point at share `t` of a centre line's arc, and its heading there. */
export function curveAt(c: PartCurve, t: number): Point & { heading: number } {
  const heading = c.heading + c.turn * t;
  if (Math.abs(c.turn) < 1e-6) {
    return { x: c.x0 + c.len * t * cos(c.heading), y: c.y0 + c.len * t * sin(c.heading), heading };
  }
  return {
    x: c.x0 + (c.len * (sin(heading) - sin(c.heading))) / c.turn,
    y: c.y0 - (c.len * (cos(heading) - cos(c.heading))) / c.turn,
    heading,
  };
}

/** Scratch for `arcFar`: the arc's end and its heading's cosine and sine there. */
const END = { x: 0, y: 0, c: 0, s: 0 };

/**
 * A part's bend as the reach needs it: the arc's signed turn (body frame), the cosine and sine of
 * that turn and of its share up to the fork, and of the branches' fan, so the probes of `fitPart` turn
 * headings by multiplication instead of trigonometry.
 */
interface Bend {
  turn: number;
  ct: number;
  st: number;
  cb: number;
  sb: number;
  cf: number;
  sf: number;
}

const FAN_COS = cos(D.branchFan);
const FAN_SIN = sin(D.branchFan);

function bendOf(bend: number, side: 1 | -1): Bend {
  if (bend === 0) return { turn: 0, ct: 1, st: 0, cb: 1, sb: 0, cf: FAN_COS, sf: side * FAN_SIN };
  return {
    turn: side * bend,
    ct: cos(bend),
    st: side * sin(bend),
    cb: cos(bend * D.branchAt),
    sb: side * sin(bend * D.branchAt),
    cf: FAN_COS,
    sf: side * FAN_SIN,
  };
}

/** The other side's bend: the same turn the other way. */
const mirrorBend = (k: Bend): Bend => ({
  turn: -k.turn,
  ct: k.ct,
  st: -k.st,
  cb: k.cb,
  sb: -k.sb,
  cf: k.cf,
  sf: -k.sf,
});

/**
 * The farthest an arc from (`x`, `y`) heading (`c0`, `s0`), turning `k.turn` (less than π either
 * way) over `len`, then straight on for `cap`, lies from the core centre. Leaves its end in `END`.
 */
function arcFar(x: number, y: number, c0: number, s0: number, k: Bend, len: number, cap: number) {
  let far = hypot(x, y);
  if (Math.abs(k.turn) < 1e-6) {
    END.x = x + len * c0;
    END.y = y + len * s0;
    END.c = c0;
    END.s = s0;
  } else {
    const c1 = c0 * k.ct - s0 * k.st;
    const s1 = s0 * k.ct + c0 * k.st;
    const rho = len / k.turn;
    END.x = x + rho * (s1 - s0);
    END.y = y - rho * (c1 - c0);
    END.c = c1;
    END.s = s1;
    // The arc's circle: its point farthest from the core counts if the arc sweeps past it, that
    // is if the core-to-centre direction lies between the arc's two ends seen from the centre.
    const cx = x - rho * s0;
    const cy = y + rho * c0;
    const w = k.turn > 0 ? 1 : -1;
    const [ax, ay] = [x - cx, y - cy];
    const [bx, by] = [END.x - cx, END.y - cy];
    if (w * (ax * cy - ay * cx) >= 0 && w * (cx * by - cy * bx) >= 0) {
      far = Math.max(far, hypot(cx, cy) + Math.abs(rho));
    }
  }
  return Math.max(far, hypot(END.x, END.y), hypot(END.x + cap * END.c, END.y + cap * END.s));
}

type Reachable = Omit<Curved, 'side'> & Pick<Appendage, 'branches' | 'bulb'>;

/**
 * How far a part on `side` reaches from the core centre, as drawn: its centre line, its branches
 * (leaving the arc at `branchAt`, fanned `branchFan` either way, `branchScale` as long) and its bulb
 * tips. The width of the tubes is not counted, as in v1.
 */
export function partReach(s: PlanSegment, a: Reachable, side: 1 | -1): number {
  const { cap, bend } = capAndBend(a);
  const heading = s.angle + side * a.dir;
  const root = rootOf(s, a.angle, side);
  return reachFrom(root, cos(heading), sin(heading), bendOf(bend, side), cap, a, false);
}

/**
 * `partReach` from a known root, heading (`c0`, `s0`), bend and cap; with `rays`, also the part's
 * straight rays at full length, where the membranes of a webbed body run. It may stop early once
 * past `limit`: a caller that only asks whether the part fits needs no more.
 */
function reachFrom(
  root: Point,
  c0: number,
  s0: number,
  k: Bend,
  cap: number,
  a: Reachable,
  rays: boolean,
  limit = Number.POSITIVE_INFINITY,
): number {
  const len = a.length - cap;
  let far = arcFar(root.x, root.y, c0, s0, k, len, cap);
  far = Math.max(far, hypot(END.x, END.y) + a.bulb);
  if (far > limit) return far;
  if (a.branches > 0) {
    // The fork, on the arc at `branchAt`, and its heading there.
    const ch = c0 * k.cb - s0 * k.sb;
    const sh = s0 * k.cb + c0 * k.sb;
    const straight = Math.abs(k.turn) < 1e-6;
    const rho = len / k.turn;
    const fx = straight ? root.x + len * D.branchAt * c0 : root.x + rho * (sh - s0);
    const fy = straight ? root.y + len * D.branchAt * s0 : root.y - rho * (ch - c0);
    for (let b = 0; b < a.branches; b++) {
      const sf = b === 0 ? k.sf : -k.sf;
      const cb = ch * k.cf - sh * sf;
      const sb = sh * k.cf + ch * sf;
      far = Math.max(far, arcFar(fx, fy, cb, sb, k, len * D.branchScale, cap * D.branchScale));
      far = Math.max(far, hypot(END.x, END.y) + a.bulb * D.branchScale);
    }
  }
  if (rays) {
    // Membranes span straight rays (`buildMembranes`), which a curled part does not follow, and a
    // neighbour's sheet may run the whole length of this part's ray.
    const L = a.length;
    far = Math.max(far, hypot(root.x + L * c0, root.y + L * s0));
    const fx = root.x + D.branchAt * L * c0;
    const fy = root.y + D.branchAt * L * s0;
    for (let b = 0; b < a.branches; b++) {
      const sf = b === 0 ? k.sf : -k.sf;
      const cb = c0 * k.cf - s0 * sf;
      const sb = s0 * k.cf + c0 * sf;
      far = Math.max(far, hypot(fx + D.branchScale * L * cb, fy + D.branchScale * L * sb));
    }
  }
  return far;
}

/**
 * An upper bound on `reachFrom` with the rays for every bend up to `bend` (any webbing), without
 * arcs: the straight rays' hull, plus how far a centre line that turns that much can drift off it
 * (its heading drifts linearly along the tube and stays put through the cap).
 */
function roughReach(
  root: Point,
  c0: number,
  s0: number,
  bend: number,
  side: 1 | -1,
  a: Reachable,
): number {
  const L = a.length;
  const turn = Math.abs(bend);
  const tube = (length: number): number => (turn * length * (1 + D.part.capShare)) / 2;
  let far =
    Math.max(hypot(root.x, root.y), hypot(root.x + L * c0, root.y + L * s0)) + tube(L) + a.bulb;
  if (a.branches > 0) {
    const fl = D.branchAt * L;
    const bl = D.branchScale * L;
    const fx = root.x + fl * c0;
    const fy = root.y + fl * s0;
    // The fork drifts with the tube; the branch leaves it turned by that much and bends itself.
    const drift = (turn * D.branchAt * fl) / 2 + turn * D.branchAt * bl + tube(bl);
    const hull0 = Math.max(hypot(root.x, root.y), hypot(fx, fy));
    for (let b = 0; b < a.branches; b++) {
      const sf = side * (b === 0 ? FAN_SIN : -FAN_SIN);
      const vx = c0 * FAN_COS - s0 * sf;
      const vy = s0 * FAN_COS + c0 * sf;
      const hull = Math.max(
        hull0,
        hypot(root.x + bl * vx, root.y + bl * vy),
        hypot(fx + bl * vx, fy + bl * vy),
      );
      far = Math.max(far, hull + drift + D.branchScale * a.bulb);
    }
  }
  return far;
}

/** An ellipse of the drawn body, ready for inside tests: its centre, axis and inverse half-axes. */
interface Ellipse {
  x: number;
  y: number;
  c: number;
  s: number;
  irx: number;
  iry: number;
  /** Its longer half-axis and that squared: no point farther from its centre is inside. */
  r: number;
  r2: number;
}

/**
 * The drawn body outline (M6b T7): every segment's ellipse, as the mesh lofts the body. A carapace
 * is a thin glass shell over its segments, and parts leave the body from under it.
 */
type Outline = Ellipse[];

function outlineOf(segments: readonly PlanSegment[]): Outline {
  return segments.map((e) => {
    const r = Math.max(e.rx, e.ry);
    return {
      x: e.x,
      y: e.y,
      c: cos(e.angle),
      s: sin(e.angle),
      irx: 1 / e.rx,
      iry: 1 / e.ry,
      r,
      r2: r * r,
    };
  });
}

/** Whether (`x`, `y`) lies inside the ellipse `e`. */
function within(e: Ellipse, x: number, y: number): boolean {
  const dx = x - e.x;
  const dy = y - e.y;
  if (dx * dx + dy * dy >= e.r2) return false;
  const u = (dx * e.c + dy * e.s) * e.irx;
  const v = (dy * e.c - dx * e.s) * e.iry;
  return u * u + v * v < 1;
}

function inside(body: Outline, x: number, y: number): boolean {
  for (const e of body) if (within(e, x, y)) return true;
  return false;
}

/** The ellipses a part can reach from one root, by index: `n` of them in `idx`. */
interface Near {
  idx: Int32Array;
  n: number;
}

/** Only the ellipses within `length` of `root` can hold a point of a part that long. */
function nearTo(body: Outline, root: Point, length: number): Near {
  const near = { idx: new Int32Array(body.length), n: 0 };
  for (let j = 0; j < body.length; j++) {
    const e = body[j] as Ellipse;
    const reach = length + e.r;
    const dx = root.x - e.x;
    const dy = root.y - e.y;
    if (dx * dx + dy * dy < reach * reach) near.idx[near.n++] = j;
  }
  return near;
}

/**
 * The share of a part's centre line (`partCurve` without webbing: its arc, then its tip cap;
 * branches excluded) that lies inside the body, at `keep.samples` even points along its length, on
 * the worse of its two sides.
 */
function buried(
  p: Part,
  s: PlanSegment,
  l: Point,
  r: Point,
  body: Outline,
  nears: readonly [Near, Near],
  limit = 1,
): number {
  const K = D.keep.samples;
  // At its bend without webbing, as the bounds fit it: webbing is detail and never moves a part.
  const { cap, bend } = capAndBend(p, 0);
  const len = p.length - cap;
  const step = p.length / K;
  const straight = Math.abs(bend) < 1e-6;
  // The arc's heading turns by `bend` over `len`, so `dt` per step; the samples sit half a step in.
  const half = len > 0 ? (bend * step) / len / 2 : 0;
  const [ct, st] = straight ? [1, 0] : [cos(bend), sin(bend)];
  const [ch, sh] = straight ? [1, 0] : [cos(half), sin(half)];
  const [cd, sd] = [ch * ch - sh * sh, 2 * ch * sh];
  const most = Math.floor(limit * K);
  let worst = 0;
  const sides = onAxis(s) ? 1 : 2;
  for (let i = 0; i < sides; i++) {
    const side = i === 0 ? 1 : -1;
    const root = i === 0 ? l : r;
    const near = nears[i] as Near;
    const h0 = s.angle + side * p.dir;
    const c0 = cos(h0);
    const s0 = sin(h0);
    // The right side turns the other way: every turn's sine flips.
    const [ce, se] = [c0 * ct - s0 * side * st, s0 * ct + c0 * side * st];
    const rho = straight ? 0 : len / (side * bend);
    let hc = c0 * ch - s0 * side * sh;
    let hs = s0 * ch + c0 * side * sh;
    const sdd = side * sd;
    const ex = straight ? root.x + len * c0 : root.x + rho * (se - s0);
    const ey = straight ? root.y + len * s0 : root.y - rho * (ce - c0);
    let count = 0;
    for (let k = 0; k < K && count <= most; k++) {
      const along = (k + 0.5) * step;
      let x: number;
      let y: number;
      if (along <= len) {
        if (straight) {
          x = root.x + along * c0;
          y = root.y + along * s0;
        } else {
          x = root.x + rho * (hs - s0);
          y = root.y - rho * (hc - c0);
        }
        const nc = hc * cd - hs * sdd;
        hs = hs * cd + hc * sdd;
        hc = nc;
      } else {
        // Past the arc, the tip cap runs straight on along the end heading.
        x = ex + (along - len) * ce;
        y = ey + (along - len) * se;
      }
      for (let j = 0; j < near.n; j++) {
        if (within(body[near.idx[j] as number] as Ellipse, x, y)) {
          count++;
          break;
        }
      }
    }
    worst = Math.max(worst, count / K);
    if (worst > limit) break;
  }
  return worst;
}

/**
 * Whether the body covers the root at `angle` of segment `s` on either side (one on the axis): a
 * point `keep.clear` outside it lies inside the outline.
 */
function covered(s: PlanSegment, angle: number, body: Outline): boolean {
  const ca = cos(angle);
  const sa = sin(angle);
  // The outward normal there, in the segment's frame, scaled to `keep.clear`.
  const nx = s.ry * ca;
  const ny = s.rx * sa;
  const k = D.keep.clear / Math.max(hypot(nx, ny), D.epsilon);
  const u = s.rx * ca + k * nx;
  const v = s.ry * sa + k * ny;
  for (let side = 1; side >= -1; side -= 2) {
    const at = placeOn(s, u, side * v);
    if (inside(body, at.x, at.y)) return true;
    if (onAxis(s)) break;
  }
  return false;
}

/**
 * Moves a v2 part's root out from under the body (M6b T7): a root that a neighbour covers slides
 * round its segment, `keep.slide` at a time, to the nearest attach angle where the body shows on
 * both sides and no other part of the segment sits. A segment the body covers whole keeps its parts
 * where they are. Edits in place.
 */
function uncover(p: Part, parts: readonly Part[], segments: PlanSegment[], body: Outline): void {
  const s = segments[p.segment] as PlanSegment;
  if (!covered(s, p.angle, body)) return;
  const step = D.keep.slide;
  // Never onto another part of the segment, which `separate` would then merge it into.
  const taken = (angle: number): boolean =>
    parts.some(
      (q) => q !== p && q.segment === p.segment && Math.abs(q.angle - angle) < D.minAngleGap,
    );
  for (let k = 1; k * step < PI; k++) {
    for (let way = -1; way <= 1; way += 2) {
      const angle = p.angle + way * k * step;
      if (angle < D.angleMargin || angle > maxAngle) continue;
      if (!covered(s, angle, body) && !taken(angle)) {
        p.angle = angle;
        return;
      }
    }
  }
}

/**
 * Keeps a v2 part off the body (M6b T7): a part with more than `keep.share` of its centre line
 * inside the drawn outline turns, `keep.step` at a time either way (the side away from the body
 * first, never ahead of `from`, never past the tail, and a tail part growing rearward no further
 * forward than sideways, and a leg within its sweep, M6c T3), up to `keep.turns` steps: the least
 * turn that clears it whole wins, then
 * the least that clears it shortened to fit the bounds. If none clears, it takes the whole turn
 * that buries least. Edits in place.
 */
function keepOff(p: Part, segments: PlanSegment[], body: Outline, from: number): void {
  const K = D.keep;
  const s = segments[p.segment] as PlanSegment;
  const l = rootOf(s, p.angle, 1);
  const r = onAxis(s) ? { x: l.x, y: -l.y } : rootOf(s, p.angle, -1);
  // The ellipses within the unshortened part's reach: every trial is no longer than that.
  const nears = [nearTo(body, l, p.length), nearTo(body, r, p.length)] as const;
  let best = buried(p, s, l, r, body, nears);
  if (best <= K.share) return;
  const [dir0, length0] = [p.dir, p.length];
  let [bestDir, bestLength] = [dir0, length0];
  const tail = p.segment === segments.length - 1 ? Math.min(dir0, PI / 2) : 0;
  const lo = Math.max(from, tail, p.lo);
  const hi = p.hi;
  // The side away from the body first: toward the root's outward normal.
  const normal = atan2(s.rx * sin(p.angle), s.ry * cos(p.angle));
  const first = normal >= dir0 ? 1 : -1;
  const fits = boundsCheck(p, s, l, r);
  const free = D.caps.bounds - D.boundsSlack - Math.max(hypot(l.x, l.y), hypot(r.x, r.y));
  const cut = Math.min(length0, (free - p.bulb) / branchFactor(p.branches));
  // A turn that clears the body only shortened is kept in reserve: a whole one may follow.
  let short: [number, number] | undefined;
  for (let j = 1; j <= K.turns; j++) {
    for (let w = 0; w < 2; w++) {
      const dir = dir0 + (w === 0 ? first : -first) * j * K.step;
      if (dir < lo || dir > hi) continue;
      p.dir = dir;
      p.length = length0;
      // Whole, a turn that buries no less than the best so far is no better; the bounds come after.
      const share = buried(p, s, l, r, body, nears, best);
      if (share >= best) continue;
      if (fits()) {
        if (share <= K.share) return;
        [best, bestDir, bestLength] = [share, dir, length0];
      } else if (!short && share <= K.share) {
        // The longest length that fits whole at this turn, to 2^−`keep.steps`; the v1 cut always does.
        let [lo2, hi2] = [cut, length0];
        for (let k = 0; k < K.steps; k++) {
          p.length = (lo2 + hi2) / 2;
          if (fits()) lo2 = p.length;
          else hi2 = p.length;
        }
        p.length = lo2;
        if (buried(p, s, l, r, body, nears, K.share) <= K.share) short = [dir, lo2];
      }
    }
  }
  [p.dir, p.length] = short ?? [bestDir, bestLength];
}

/**
 * Sets the growth direction (bent `sweep` of the way toward the tail, but never ahead of `from`)
 * and fits the part inside the bounds. A part keeps its gene length if it can: it sweeps toward the
 * core, along the body, as little as it must and at most `fit.max` (a rear-segment part growing
 * rearward turns no further forward than sideways), and a part that still leaves the bounds is cut
 * so that root plus reach stays inside. It then keeps off the body (`keepOff`, M6b T7).
 * Edits in place.
 */
function fitPart(p: Part, segments: PlanSegment[], sweep: number, body: Outline, from = 0): void {
  fitBounds(p, segments, sweep, from);
  keepOff(p, segments, body, from);
}

function fitBounds(p: Part, segments: PlanSegment[], sweep: number, from: number) {
  const wish = p.length;
  if (!(wish > p.base)) {
    fitAt(p, segments, sweep, from);
    return;
  }
  if (fitLength(p, segments, sweep, from, wish)) return;
  // A long part (look pass 4) keeps as much of its reach past its base length as fits whole,
  // to 2^−`long.steps` of it; if not even that length fits, it is cut as any part is.
  let [lo, hi] = [p.base, wish];
  if (!fitLength(p, segments, sweep, from, lo)) return;
  let kept = true;
  for (let k = 0; k < D.long.steps; k++) {
    const mid = (lo + hi) / 2;
    kept = fitLength(p, segments, sweep, from, mid);
    if (kept) lo = mid;
    else hi = mid;
  }
  if (!kept) fitLength(p, segments, sweep, from, lo);
}

/** `fitPart` at one length: whether the part keeps it whole. */
function fitLength(
  p: Part,
  segments: PlanSegment[],
  sweep: number,
  from: number,
  length: number,
): boolean {
  p.length = length;
  fitAt(p, segments, sweep, from);
  return p.length === length;
}

/**
 * Whether part `p` (at its current direction and length) fits the bounds whole on both sides, from
 * its roots `l` and `r` on segment `s`.
 */
function boundsCheck(p: Part, s: PlanSegment, l: Point, r: Point): () => boolean {
  const mirrored = onAxis(s);
  const room = D.caps.bounds - D.boundsSlack;
  // Webbing straightens the drawn part toward its membrane's rays, so the fit holds the part, at
  // its full bend, half of it and straight, with the rays any sheet may span: webbing is detail
  // and never changes how a part fits. Between those bends the drawn reach stays within the
  // bounds slack. The cap and bend follow the part's length.
  let length = Number.NaN;
  let cap = 0;
  let bend = 0;
  // The exact bends take trigonometry, so they are made only when the rough bound is not enough.
  let exact: [Bend[], Bend[]] | undefined;
  const bends = (): [Bend[], Bend[]] => {
    if (!exact) {
      const left = (bend === 0 ? [0] : [bend, bend / 2, 0]).map((b) => bendOf(b, 1));
      exact = [left, mirrored ? left : left.map(mirrorBend)];
    }
    return exact;
  };
  const side = (root: Point, heading: number, sign: 1 | -1): boolean => {
    const c = cos(heading);
    const n = sin(heading);
    if (roughReach(root, c, n, bend, sign, p) <= room) return true;
    const k = bends()[sign === 1 ? 0 : 1];
    for (let i = 0; i < k.length; i++) {
      if (reachFrom(root, c, n, k[i] as Bend, cap, p, i === 0, room) > room) return false;
    }
    return true;
  };
  return (): boolean => {
    if (p.length !== length) {
      length = p.length;
      ({ cap, bend } = capAndBend(p, 0));
      exact = undefined;
    }
    return side(l, s.angle + p.dir, 1) && (mirrored || side(r, s.angle - p.dir, -1));
  };
}

function fitAt(p: Part, segments: PlanSegment[], sweep: number, from: number): void {
  // On a turned segment the two sides' roots lie at different distances; the farther one counts.
  const s = segments[p.segment] as PlanSegment;
  const mirrored = onAxis(s);
  const l = rootOf(s, p.angle, 1);
  const r = mirrored ? { x: l.x, y: -l.y } : rootOf(s, p.angle, -1);
  const free = D.caps.bounds - D.boundsSlack - Math.max(hypot(l.x, l.y), hypot(r.x, r.y));
  // A bulb takes at most its share of the free reach, and the part shortens to make room for it.
  p.bulb = Math.min(p.bulb, X.bulb.room * Math.max(0, free));
  // A leg keeps to its sweep (M6c T3): every turn below stays inside `lo`-`hi`.
  const lo = p.lo;
  const hi = p.hi;
  const dir = clamp(Math.max(from, p.angle + sweep * (PI - p.angle)), lo, hi);
  p.dir = dir;
  const cut = Math.min(p.length, (free - p.bulb) / branchFactor(p.branches));
  if (cut >= p.length) {
    p.length = cut;
    return;
  }
  const fits = boundsCheck(p, s, l, r);
  if (fits()) return;
  // Sweep along the body toward the core, at most `fit.max`, and never so that a part on the
  // rear segment growing rearward grows forward: a tail stays a tail. If even the farthest sweep
  // leaves the bounds the part is cut; otherwise the least sweep that fits, found by halving.
  const inward = atan2(-l.y, -l.x) - s.angle;
  const toward = inward - TAU * Math.round((inward - dir) / TAU);
  const tail = p.segment === segments.length - 1 ? Math.min(dir, PI / 2) : 0;
  const floor = Math.max(from, dir - D.fit.max, tail, lo);
  const most = clamp(toward, floor, Math.min(hi, dir + D.fit.max));
  p.dir = most;
  if (most !== dir && fits()) {
    let [a, b] = [0, 1];
    for (let k = 0; k < D.fit.sweeps; k++) {
      const t = (a + b) / 2;
      p.dir = dir + t * (most - dir);
      if (fits()) b = t;
      else a = t;
    }
    p.dir = dir + b * (most - dir);
    return;
  }
  // Nothing fits whole: cut it at its own direction.
  p.dir = dir;
  p.length = cut;
}

function shape(parts: Part[], segments: PlanSegment[], sweep: number, body: Outline): Part[] {
  for (const p of parts) fitPart(p, segments, sweep, body);
  return parts;
}

/** The even angle of ring slot `k` of `pairs` on the left side: the instances share the circle. */
export const ringAngle = (k: number, pairs: number): number => (PI * (2 * k + 1)) / (2 * pairs);

/**
 * A radial body: the parts, in order, ring the core at even angles, and each grows no further
 * forward than the one before it, so a fitted part never crosses its neighbour. Copies them.
 */
function ring(parts: Part[], segments: PlanSegment[], sweep: number, body: Outline): Part[] {
  const ringed = parts.map((p, k) => ({ ...p, segment: 0, angle: ringAngle(k, parts.length) }));
  let from = 0;
  for (const p of ringed) {
    fitPart(p, segments, sweep, body, from);
    from = p.dir;
  }
  return ringed;
}

type Piece = Pick<Appendage, 'length' | 'girth' | 'beat' | 'branches'>;

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
const fits = (parts: Part[]): boolean => parts.length * 2 <= D.caps.appendages;

/** How thick the default ciliary band is drawn on a segment: at most `part.root` of its half-width (M6b T7). */
const room = (segments: readonly PlanSegment[], seg: number): number =>
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
function mirror(parts: Part[], segments: readonly PlanSegment[]): Appendage[] {
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
function bilateralParts(
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
function radialParts(all: Part[], segments: PlanSegment[], sweep: number, body: Outline): Part[] {
  const parts = ring(radialRing(all, [], segments), segments, sweep, body);
  if (2 * motileArea(parts) >= D.minThrustArea) return parts;
  const band = Array.from({ length: D.band.pairs }, (_, j) => bandPart(0, 0, j, room(segments, 0)));
  return ring(radialRing(all, band, segments), segments, sweep, body);
}

/** Where bristle `k` of `count` sits along a part, as a share of its length. */
const bristleAt = (k: number, count: number): number => (k + 0.5) / count;

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
function dress(parts: Part[], segments: PlanSegment[]): Part[] {
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

/** The signed area of a polygon: positive when it runs counter-clockwise. */
export function polygonArea(points: readonly Point[]): number {
  let twice = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i] as Point;
    const b = points[(i + 1) % points.length] as Point;
    twice += a.x * b.y - b.x * a.y;
  }
  return twice / 2;
}

/** The turn at `b` on the way from `a` to `c`: positive to the left. */
const turnAt = (a: Point, b: Point, c: Point): number =>
  (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);

/** Where segments `ab` and `cd` cross, strictly inside both, or null. */
function crossing(a: Point, b: Point, c: Point, d: Point): Point | null {
  const den = (b.x - a.x) * (d.y - c.y) - (b.y - a.y) * (d.x - c.x);
  if (den === 0) return null;
  const t = ((c.x - a.x) * (d.y - c.y) - (c.y - a.y) * (d.x - c.x)) / den;
  const u = ((c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x)) / den;
  if (!(t > 0 && t < 1 && u > 0 && u < 1)) return null;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/** A sheet as convex, counter-clockwise pieces of real area: whole, or split at a crossing or a reflex corner. */
function pieces(q: Point[]): Point[][] {
  let out: Point[][] = [q];
  if (q.length === 4) {
    const [a, b, c, d] = q as [Point, Point, Point, Point];
    const x = crossing(a, b, c, d);
    const y = x ? null : crossing(b, c, d, a);
    if (x)
      out = [
        [a, x, d],
        [x, b, c],
      ];
    else if (y)
      out = [
        [a, b, y],
        [y, c, d],
      ];
    else {
      const sign = polygonArea(q) >= 0 ? 1 : -1;
      const k = [0, 1, 2, 3].findIndex(
        (i) => sign * turnAt(q[i] as Point, q[(i + 1) % 4] as Point, q[(i + 2) % 4] as Point) < 0,
      );
      if (k >= 0) {
        const r = (k + 1) % 4;
        const at = (i: number): Point => q[(r + i) % 4] as Point;
        out = [
          [at(0), at(1), at(2)],
          [at(0), at(2), at(3)],
        ];
      }
    }
  }
  const kept: Point[][] = [];
  for (const p of out) {
    const area = polygonArea(p);
    // A reversed piece's area is summed again in its own order, as the check reads it.
    const ccw = area < 0 ? [...p].reverse() : p;
    if ((area < 0 ? polygonArea(ccw) : area) >= X.minArea) kept.push(ccw);
  }
  return kept;
}

/**
 * The membranes of webbed parts, side by side: each spans `webbing` of the way along its own rays
 * to its branches, and to the next part rearward on its side when their roots lie within `webSpan`.
 * The rearmost left part spans to its own mirror instead: a tail fan.
 */
function buildMembranes(segments: PlanSegment[], appendages: Appendage[]): Membrane[] {
  if (!appendages.some((a) => a.webbing > 0)) return [];
  const out: Membrane[] = [];
  const at = (p: Point, d: Point, t: number): Point => ({ x: p.x + t * d.x, y: p.y + t * d.y });
  type Ray = { a: Appendage; s: PlanSegment; root: Point; dir: Point };
  const rays: (Ray | undefined)[] = [];
  const ray = (i: number): Ray => {
    const known = rays[i];
    if (known) return known;
    const a = appendages[i] as Appendage;
    const s = segments[a.segment] as PlanSegment;
    // Pairs are left then right: on the axis the right instance mirrors the left exactly.
    const twin = i % 2 === 1 && onAxis(s) ? ray(i - 1) : undefined;
    const made = twin
      ? {
          a,
          s,
          root: { x: twin.root.x, y: -twin.root.y },
          dir: { x: twin.dir.x, y: -twin.dir.y },
        }
      : { a, s, root: rootOf(s, a.angle, a.side), dir: dirOf(s, a) };
    rays[i] = made;
    return made;
  };
  const add = (part: number, to: number, points: Point[]): void => {
    for (const p of pieces(points)) out.push({ part, to, points: p });
  };
  for (const side of [1, -1] as const) {
    const order = appendages
      .map((a, i) => ({ a, i }))
      .filter(({ a }) => a.side === side)
      .sort((p, q) => p.a.segment - q.a.segment || p.a.angle - q.a.angle)
      .map(({ i }) => i);
    order.forEach((i, j) => {
      const { a, s, root, dir } = ray(i);
      const w = a.webbing;
      if (!(w > 0)) return;
      const reach = w * a.length;
      if (a.branches > 0) {
        const fork = at(root, dir, D.branchAt * a.length);
        const tip = at(fork, dir, (1 - D.branchAt) * reach);
        for (let b = 0; b < a.branches; b++) {
          const fan = b === 0 ? D.branchFan : -D.branchFan;
          const branch = dirOf(s, { dir: a.dir + fan, side });
          add(i, i, [fork, tip, at(fork, branch, D.branchScale * reach)]);
        }
      }
      const next = order[j + 1] ?? (side === 1 ? i + 1 : undefined);
      if (next === undefined) return;
      const q = ray(next);
      if (hypot(q.root.x - root.x, q.root.y - root.y) > X.webSpan) return;
      add(i, next, [root, at(root, dir, reach), at(q.root, q.dir, w * q.a.length), q.root]);
    });
  }
  return out;
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

/** A turn by `angle` with its cosine and sine taken once: `turnTo`'s arithmetic, for many points. */
function turner(angle: number): (dx: number, dy: number) => Point {
  if (angle === 0) return (dx, dy) => ({ x: dx, y: dy });
  const c = cos(angle);
  const n = sin(angle);
  return (dx, dy) => ({ x: dx * c - dy * n, y: dx * n + dy * c });
}

/** The outline points of segment `s` in body coordinates. */
const outline = (s: PlanSegment): Point[] => {
  const turn = turner(s.angle);
  return HULL_SAMPLES.map((p) => {
    const d = turn(s.rx * p.x, s.ry * p.y);
    return { x: s.x + d.x, y: s.y + d.y };
  });
};

const NO_CARAPACE: Carapace = { count: 0, x: 0, y: 0, rx: 0, ry: 0, angle: 0, thickness: 0 };

/** One ellipse over the front `count` segments: along the axis from the rearmost fused centre to the core. */
function buildCarapace(segments: PlanSegment[], fusion: number, plating: number): Carapace {
  const count = fusedCount(fusion, segments.length);
  if (count < 1) return { ...NO_CARAPACE };
  const last = segments[count - 1] as PlanSegment;
  const angle = count > 1 && (last.y !== 0 || last.angle !== 0) ? atan2(-last.y, -last.x) : 0;
  const axis: PlanSegment = { x: 0, y: 0, rx: 1, ry: 1, angle };
  // The points in the hull's frame: u along its axis, v across.
  const pts = segments.slice(0, count).flatMap(outline);
  const back = turner(-angle);
  const local = pts.map((p) => back(p.x, p.y));
  let [u0, u1, v0, v1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const p of local) {
    u0 = Math.min(u0, p.x);
    u1 = Math.max(u1, p.x);
    v0 = Math.min(v0, p.y);
    v1 = Math.max(v1, p.y);
  }
  const cu = (u1 + u0) / 2;
  const cv = (v1 + v0) / 2;
  let rx = (u1 - u0) / 2;
  let ry = (v1 - v0) / 2;
  // Grow the box's ellipse until it holds every outline point, then keep it inside the bounds.
  let grow = 1;
  for (const p of local) grow = Math.max(grow, hypot((p.x - cu) / rx, (p.y - cv) / ry));
  rx *= grow;
  ry *= grow;
  // The shell overhangs its segments (M6c T3), so the legs on it root under it.
  let widest = 0;
  for (let i = 0; i < count; i++) widest = Math.max(widest, (segments[i] as PlanSegment).ry);
  rx += D.fusion.overhang * widest;
  ry += D.fusion.overhang * widest;
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
  const gene = lerp(EYE_SIZE[0], EYE_SIZE[1], (shape.eyeSize - E.min) / (1 - E.min));
  const root = rootOf(head, E.angle);
  const room = D.caps.bounds - D.boundsSlack - hypot(root.x, root.y) - 2 * gene;
  const stalk = clamp(lerp(EYE_STALK[0], EYE_STALK[1], shape.eyeStalk), 0, Math.max(0, room));
  const out = turnTo(head, cos(E.angle), sin(E.angle));
  // A short stalk sinks the eye into the head (look pass 5): `set` of its diameter inside at no stalk.
  const sink = E.set * (1 - stalk / EYE_STALK[1]);
  // The pair never overlaps (ADR 0037): an eye's centre, `root.y + (stalk + size·(1 − 2·sink))·out.y`
  // from the midline, stays at least its radius out, so a small trunk head carries smaller eyes.
  // Only the smallest eye, at the gene range's floor, may still touch its twin.
  const lean = (1 - 2 * sink) * out.y;
  const fits = lean < 1 ? (root.y + stalk * out.y) / (1 - lean) : gene;
  const size = clamp(fits, EYE_SIZE[0], gene);
  const from = stalk + size * (1 - 2 * sink);
  return {
    count: 2,
    size,
    stalk,
    angle: E.angle,
    x: root.x + from * out.x,
    y: root.y + from * out.y,
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
      const r = colliderRadius(a.width * D.colliderWidth);
      const along = a.length * D.colliderAlong;
      // On the drawn centre line, pulled in if a part swept to the bounds would push it past them.
      const c = partCurve(s, a);
      const at = curveAt(c, Math.min(1, along / Math.max(c.len, D.epsilon)));
      const far = hypot(at.x, at.y);
      const room = RULES.body.maxReach - D.epsilon - r;
      const pull = far > room ? room / far : 1;
      out.push({ x: at.x * pull, y: at.y * pull, r });
    }
  }
  return out;
}

/** The chain and its parts for one form, before they are dressed and mirrored. */
function grow(traits: Traits, form: Bending, n: number) {
  const shape = traits.shape;
  const build = buildOf(traits, form, n);
  const { segments, slim } = buildSegments(traits, form, build);
  const scales = widthScales(segments);
  // A coil's parts root on its outer whorl, so they grow clear of the whorls inside it (M6b T7).
  const rooms = build === 'coil' ? Math.min(segments.length, D.curve.outer) : segments.length;
  const built = buildParts(traits, scales, rooms);
  // Parts keep off the drawn body (M6b T7).
  const body = outlineOf(segments);
  const R = D.radial;
  const parts = form.radial
    ? radialParts(built, segments, shape.drape * R.drapeSweep * R.ringDrape, body)
    : bilateralParts(
        built,
        segments,
        lerp(D.sweep, R.drapeSweep, shape.drape),
        body,
        scales,
        build === 'coil',
      );
  return { build, segments, slim, parts };
}

export function develop(traits: Traits): BodyPlan {
  const shape = traits.shape;
  const n = clamp(Math.floor(traits.body.segments), 1, D.caps.segments);
  let form = formOf(shape, n);
  let grown = grow(traits, form, n);
  const legs = (): number =>
    grown.parts.reduce((count, p) => count + (p.role === 'leg' ? 1 : 0), 0);
  // The coil's leg gate (ADR 0041): a coil with more leg pairs than `coilLegs` takes the C-curl.
  if (form.mode === 2 && legs() > D.curve.coilLegs) {
    form = formOf(shape, n, false);
    grown = grow(traits, form, n);
  }
  const { segments, slim, parts } = grown;
  // A coil lays its chain out as more chambers than its segment genes give (M6b T6).
  const count = segments.length;
  const plating = traits.skin.plating;
  const carapace = buildCarapace(segments, shape.fusion, plating);
  const appendages = mirror(dress(parts, segments), segments);
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
    form: { turn: form.turn, mode: form.mode, radial: form.radial, slim },
    carapace,
    eyes: buildEyes(shape, segments[0] as PlanSegment),
    membranes: buildMembranes(segments, appendages),
  };
}

/** The furthest any part of the plan can reach from the core centre. */
export function planBounds(plan: BodyPlan): number {
  let bound = farEdge(plan.segments);
  for (const a of plan.appendages) {
    const s = plan.segments[a.segment];
    if (s === undefined) return Number.POSITIVE_INFINITY;
    // Root plus length bounds the drawn part from above; the exact reach only matters past it.
    const root = rootOf(s, a.angle, a.side);
    if (hypot(root.x, root.y) + a.length * branchFactor(a.branches) + a.bulb > bound) {
      bound = Math.max(bound, partReach(s, a, a.side));
    }
    if (a.setae > 0) {
      const dir = dirOf(s, a);
      for (const t of [bristleAt(0, a.setae), bristleAt(a.setae - 1, a.setae)]) {
        const p = { x: root.x + t * a.length * dir.x, y: root.y + t * a.length * dir.y };
        bound = Math.max(bound, hypot(p.x, p.y) + a.setaeLength);
      }
    }
  }
  for (const m of plan.membranes) {
    for (const p of m.points) bound = Math.max(bound, hypot(p.x, p.y));
  }
  const c = plan.carapace;
  if (c.count > 0) bound = Math.max(bound, hypot(c.x, c.y) + Math.max(c.rx, c.ry));
  const e = plan.eyes;
  if (e.count > 0) bound = Math.max(bound, hypot(e.x, e.y) + e.size);
  return bound;
}

/** The v2 checks: curved neighbours overlap and the rest keep apart, the carapace, the eyes and a radial ring. */
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
  // No self-overlap (M6b T6): a curled chain keeps clear of itself. A radial body's chain lies
  // folded inside its round core, and a straight one never folds (the v1 layout nests its
  // segments behind the big head), so curled bilateral chains are checked.
  if (plan.form.radial === 0 && plan.form.turn !== 0) {
    for (let i = 0; i < n; i++) {
      for (let j = i + 2; j < n; j++) {
        if (!apart(plan.segments[i] as PlanSegment, plan.segments[j] as PlanSegment)) {
          bad.push(`segments ${i} and ${j} overlap`);
        }
      }
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
  if (!(plan.form.slim > 0 && plan.form.slim <= 1)) bad.push('form: slim is outside (0, 1]');
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
  bad.push(...detailViolations(plan));
  return bad.length < 2 ? bad : [...new Set(bad)];
}

const inUnit = (v: number): boolean => v >= 0 && v <= 1;

/** The fine-part checks (M6 T8): detail ranges, setae counts, chelae on weapon tips, sound membranes. */
function detailViolations(plan: BodyPlan): string[] {
  const bad: string[] = [];
  const S = X.setae;
  let setae = 0;
  for (const a of plan.appendages) {
    setae += a.setae;
    if (!inUnit(a.webbing) || !inUnit(a.beads) || !(a.bulb >= 0) || !(a.setaeLength >= 0)) {
      bad.push('appendage detail out of range');
    }
    if (a.setae < 0 || a.setae > S.perPart || a.setae !== Math.floor(a.setae)) {
      bad.push(`setae: ${a.setae} on a part is outside 0-${S.perPart}`);
    }
    if (a.setae > 0 && !(a.setaeLength > 0)) bad.push('setae with no length');
    if (a.chela !== 0 && !(a.chela > X.chela.min && a.chela <= 1 && isWeaponTip(a.tip))) {
      bad.push('chela on a tip that is not pointed or hooked');
    }
  }
  if (setae > S.perBody) bad.push(`setae: ${setae} on the body is more than ${S.perBody}`);
  const n = plan.appendages.length;
  const owns = (k: number): boolean => k >= 0 && k < n && k === Math.floor(k);
  plan.membranes.forEach((m, i) => {
    if (!owns(m.part) || !owns(m.to) || !((plan.appendages[m.part] as Appendage).webbing > 0)) {
      bad.push(`membrane ${i}: no webbed part ${m.part} or ${m.to}`);
    }
    const ps = m.points;
    if (ps.length < 3 || !(polygonArea(ps) >= X.minArea)) bad.push(`membrane ${i} is degenerate`);
    else if (
      ps.some(
        (p, k) =>
          turnAt(p, ps[(k + 1) % ps.length] as Point, ps[(k + 2) % ps.length] as Point) < -1e-12,
      )
    ) {
      bad.push(`membrane ${i} is not convex`);
    }
  });
  return bad;
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
    if (!(a.girth >= a.width)) bad.push('appendage drawn broader than its girth');
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
    f(a.module, a.side, a.segment, a.angle, a.dir, a.length, a.width, a.girth, a.taper);
    f(a.curvature);
    f(a.joints, a.branches, a.tip, a.stiffness, a.beat, a.phase);
    f(a.webbing, a.setae, a.setaeLength, a.bulb, a.chela, a.beads, a.fringe ? 1 : 0);
  }
  f(plan.plates.length);
  for (const p of plan.plates) f(p.segment, p.coverage, p.thickness);
  const m = plan.mouth;
  f(m.offset, m.radius, m.arc, m.type, m.digestion);
  f(plan.colliders.length);
  for (const c of plan.colliders) f(c.x, c.y, c.r);
  const { form: o, carapace: c, eyes: e } = plan;
  f(o.turn, o.mode, o.radial, o.slim);
  f(c.count, c.x, c.y, c.rx, c.ry, c.angle, c.thickness);
  f(e.count, e.size, e.stalk, e.angle, e.x, e.y);
  f(plan.membranes.length);
  for (const m of plan.membranes) {
    f(m.part, m.to, m.points.length);
    for (const p of m.points) f(p.x, p.y);
  }
  return h.digest();
}

// Development, plan stage: moved verbatim out of develop.ts (ADR 0045).

import type { Collider } from '../sim/body';
import { clamp, cos, PI, sin } from '../sim/math';
import { RULES } from '../sim/rules';
import type { Role } from './organism';

export const D = RULES.develop;

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
export type Part = Omit<Appendage, 'side'> & {
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

export const range = (r: readonly number[]): Range => [r[0] as number, r[1] as number];

export const STRETCH = range(D.stretch);

export const LENGTH = range(D.length);

export const WIDTH = range(D.width);

export const TAPER = range(D.taper);

export const CURVATURE = range(D.curvature);

export const PLATE_THICKNESS = range(D.plateThickness);

export const EYE_SIZE = range(D.eyes.size);

export const EYE_STALK = range(D.eyes.stalk);

export const TRUNK_HEAD = range(D.chain.trunk.head);

export const X = D.detail;

export const unit = (byte: number): number => byte / 255;

/** Area weight of a part counting its branches. */
export const branchWeight = (a: Pick<Appendage, 'branches'>): number =>
  1 + a.branches * D.branchScale * D.branchScale;

export const branchFactor = (branches: number): number => (branches > 0 ? 1 + D.branchScale : 1);

/**
 * How far branch `b` of `branches` fans from its parent (M6c T4): backward, toward the tail, by
 * (b + 1) ÷ branches of `branchFan` (a positive turn on the left side, mirrored on the right).
 */
export const branchFanOf = (b: number, branches: number): number =>
  (D.branchFan * (b + 1)) / Math.max(1, branches);

export const maxAngle = PI - D.angleMargin;

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
export function radiusAlong(s: PlanSegment, dx: number, dy: number): number {
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

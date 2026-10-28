// Inner anatomy (M6 T12, references 02 and 03): the organs that show through a creature's clear
// shell. A gut line runs along the curved spine and swells into a stomach; fluid chambers and oil
// droplets sit at hash-seeded places without overlapping; a heart or ganglion spot and eye pigment
// complete it. Everything lies inside the hull (the union of the plan's segment ellipses). This is
// render data only: nothing in the sim or the stats reads it, and it is fixed per genome, because
// the mesh is cached per genome hash and level of detail.

import type { BodyPlan, PlanSegment } from '../genome/develop';
import { rootOf } from '../genome/develop';
import type { Traits } from '../genome/express';
import { clamp } from '../sim/math';
import { createRng, type Rng, seedFromString } from '../sim/prng';
import { RULES } from '../sim/rules';
import { along, centreLine, type Line } from './spine';

const { cos, sin, sqrt, hypot, exp, max, min, PI, log2 } = Math;
const TAU = 2 * PI;

export type OrganKind = 'chamber' | 'droplet' | 'heart' | 'ganglion' | 'pigment';

/** A round organ: its kind, centre and radius in the body frame (core radii). */
export interface Organ {
  kind: OrganKind;
  x: number;
  y: number;
  r: number;
}

/** A point of the gut line: its spine share (0 front, 1 rear), centre and radius. */
export interface GutPoint {
  s: number;
  x: number;
  y: number;
  r: number;
}

export interface Anatomy {
  /** Front to rear along the spine. */
  gut: GutPoint[];
  /** The heart or ganglion first, then the eye pigment, then the chambers and droplets. */
  organs: Organ[];
}

export const NO_ANATOMY: Anatomy = { gut: [], organs: [] };

/** Fluid chambers and oil droplets together: from the smallest, slowest body to the largest, fastest. */
export const CHAMBERS = { min: 3, max: 14 } as const;
/** How much the count follows the genetic maximum size; the metabolism takes the rest. */
const SIZE_SHARE = 0.65;
/** Points along the gut line, and the share of the spine it spans. */
export const GUT_POINTS = 24;
const GUT_FROM = 0.1;
const GUT_TO = 0.9;
/** The gut's radius and the stomach's swelling (× the gut), centred somewhere in this span of the gut, this wide. */
const GUT_WIDTH = 0.055;
const STOMACH = 2.4;
const STOMACH_AT = [0.25, 0.45] as const;
const STOMACH_SPREAD = 0.12;
/** The gut thins toward its ends to this share of its width. */
const GUT_END = 0.45;
/** Organ radii, in units of the body's scale (√ of its hull area ÷ π). */
const CHAMBER = 0.23;
const DROPLET = 0.7;
const HEART = 0.1;
const PIGMENT = 0.075;
/** Each chamber is ±this share of its size; this share of them are oil droplets, at most. */
const CHAMBER_SPREAD = 0.25;
const DROPLET_SHARE = [0.25, 0.55] as const;
/** Where the heart (behind the head) or the ganglion (in the head) sits on the spine. */
const HEART_AT = [0.3, 0.45] as const;
const GANGLION_AT = [0.1, 0.2] as const;
/** A median eye spot sits this far back along the spine; paired pigment this far in from the eyes. */
const EYE_SPOT_AT = 0.08;
const PIGMENT_IN = 0.4;
/** Organs keep within the hull shrunk to this share, and this far apart (share of their radii). */
const INNER = 0.85;
const GAP = 1.2;
/** Placement tries per organ before every chamber shrinks by `SHRINK` and placement starts over. */
const TRIES = 60;
const SHRINK = 0.85;
const ROUNDS = 16;
/** Spine shares a spot may move by to find room, in order. */
const NUDGES = [0, 0.04, -0.04, 0.08, -0.08, 0.12, -0.12, 0.18, -0.18];
/** Boundary points checked round a disc. */
const EDGE = 16;

/** Fluid chambers and oil droplets: grows with the genetic maximum size and the metabolism, 3–14. */
export function chamberCount(t: Pick<Traits, 'body' | 'physiology'>): number {
  const { base, octaves } = RULES.genes.size;
  const size = clamp(log2(max(t.body.maxBiomass, base) / base) / octaves, 0, 1);
  const [slow, fast] = RULES.genes.range.physiology.metabolism as [number, number];
  const rate = clamp((t.physiology.metabolism - slow) / (fast - slow), 0, 1);
  const drive = SIZE_SHARE * size + (1 - SIZE_SHARE) * rate;
  return CHAMBERS.min + Math.round((CHAMBERS.max - CHAMBERS.min) * drive);
}

const insideOne = (s: PlanSegment, x: number, y: number, scale: number): boolean => {
  const [dx, dy] = [x - s.x, y - s.y];
  const [c, n] = [cos(s.angle), sin(s.angle)];
  const u = (dx * c + dy * n) / (s.rx * scale);
  const v = (-dx * n + dy * c) / (s.ry * scale);
  return u * u + v * v <= 1;
};

const insideHull = (plan: BodyPlan, x: number, y: number, scale = INNER): boolean =>
  plan.segments.some((s) => insideOne(s, x, y, scale));

/** The disc's centre and `EDGE` points just beyond its edge lie in the shrunk hull. */
function discFits(plan: BodyPlan, x: number, y: number, r: number): boolean {
  if (!insideHull(plan, x, y)) return false;
  const reach = r * 1.05;
  for (let k = 0; k < EDGE; k++) {
    const a = (TAU * k) / EDGE;
    if (!insideHull(plan, x + reach * cos(a), y + reach * sin(a))) return false;
  }
  return true;
}

/** The largest radius up to `r` that fits at `(x, y)` (0 when the centre is outside). */
function fitRadius(plan: BodyPlan, x: number, y: number, r: number): number {
  if (!insideHull(plan, x, y)) return 0;
  if (discFits(plan, x, y, r)) return r;
  let [lo, hi] = [0, r];
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2;
    if (discFits(plan, x, y, mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** `(x, y)`, pulled toward the nearest segment's centre until it lies in the shrunk hull. */
function intoHull(plan: BodyPlan, x: number, y: number): { x: number; y: number } {
  if (insideHull(plan, x, y)) return { x, y };
  let best = plan.segments[0] as PlanSegment;
  let near = Number.POSITIVE_INFINITY;
  for (const s of plan.segments) {
    const d = hypot(x - s.x, y - s.y) / min(s.rx, s.ry);
    if (d < near) [near, best] = [d, s];
  }
  let [lo, hi] = [0, 1];
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (insideHull(plan, x + (best.x - x) * mid, y + (best.y - y) * mid)) hi = mid;
    else lo = mid;
  }
  // A step further in, so the point is strictly inside.
  const t = min(1, hi + 0.02);
  return { x: x + (best.x - x) * t, y: y + (best.y - y) * t };
}

/** The body's scale: the radius of a disc as large as its segments together. */
const scaleOf = (plan: BodyPlan): number =>
  sqrt(plan.segments.reduce((a, s) => a + s.rx * s.ry, 0));

function gutOf(plan: BodyPlan, rng: Rng, scale: number): GutPoint[] {
  const line = centreLine(plan.segments);
  const stomach = rng.range(STOMACH_AT[0], STOMACH_AT[1]);
  const out: GutPoint[] = [];
  for (let i = 0; i < GUT_POINTS; i++) {
    const t = i / (GUT_POINTS - 1);
    const s = GUT_FROM + (GUT_TO - GUT_FROM) * t;
    const c = along(line, s);
    const p = intoHull(plan, c.x, c.y);
    const ends = GUT_END + (1 - GUT_END) * sin(PI * t);
    const swell = 1 + (STOMACH - 1) * exp(-(((t - stomach) / STOMACH_SPREAD) ** 2));
    out.push({ s, x: p.x, y: p.y, r: fitRadius(plan, p.x, p.y, GUT_WIDTH * scale * ends * swell) });
  }
  return out;
}

const apart = (organs: readonly Organ[], x: number, y: number, r: number): boolean =>
  organs.every((o) => hypot(o.x - x, o.y - y) >= (o.r + r) * GAP);

/** A spot near share `s` of the spine, where it fits largest (nudged along the spine), apart from `placed`. */
function spineSpot(
  plan: BodyPlan,
  line: Line,
  s: number,
  r: number,
  kind: OrganKind,
  placed: readonly Organ[],
): Organ {
  let best: Organ | null = null;
  for (const nudge of NUDGES) {
    const c = along(line, clamp(s + nudge, 0.02, 0.98));
    const o = spot(plan, c.x, c.y, r, kind, placed);
    if (!best || o.r > best.r * 1.001) best = o;
    if (o.r >= r * 0.999) break;
  }
  return best as Organ;
}

function spot(
  plan: BodyPlan,
  x: number,
  y: number,
  r: number,
  kind: OrganKind,
  placed: readonly Organ[],
): Organ {
  const p = intoHull(plan, x, y);
  let radius = fitRadius(plan, p.x, p.y, r);
  // Shrink away from the organs already placed.
  for (const o of placed) {
    const room = hypot(o.x - p.x, o.y - p.y) / GAP - o.r;
    radius = min(radius, room);
  }
  return { kind, x: p.x, y: p.y, r: max(radius, 0) };
}

/** A point drawn evenly inside the shrunk hull: a segment by area, then a point in its ellipse. */
function samplePoint(plan: BodyPlan, rng: Rng, total: number): { x: number; y: number } {
  let pick = rng.next() * total;
  let seg = plan.segments[plan.segments.length - 1] as PlanSegment;
  for (const s of plan.segments) {
    pick -= s.rx * s.ry;
    if (pick <= 0) {
      seg = s;
      break;
    }
  }
  const a = rng.next() * TAU;
  const rho = sqrt(rng.next()) * INNER;
  const [u, v] = [seg.rx * rho * cos(a), seg.ry * rho * sin(a)];
  const [c, n] = [cos(seg.angle), sin(seg.angle)];
  return { x: seg.x + u * c - v * n, y: seg.y + u * n + v * c };
}

/**
 * The organs of a body: deterministic per (plan, traits, genome hash). The hash seeds every
 * position, so two genomes with one plan still differ inside.
 */
export function anatomyOf(plan: BodyPlan, traits: Traits, genomeHash: string): Anatomy {
  if (plan.segments.length === 0) return NO_ANATOMY;
  const rng = createRng(seedFromString(genomeHash), 'anatomy');
  const scale = scaleOf(plan);
  const gut = gutOf(plan, rng, scale);
  const line = centreLine(plan.segments);

  const fixed: Organ[] = [];
  const heart = rng.next() < 0.5;
  const [lo, hi] = heart ? HEART_AT : GANGLION_AT;
  fixed.push(
    spineSpot(plan, line, rng.range(lo, hi), HEART * scale, heart ? 'heart' : 'ganglion', fixed),
  );
  const e = plan.eyes;
  const head = plan.segments[0] as PlanSegment;
  if (e.count >= 2) {
    for (const side of [1, -1] as const) {
      const root = rootOf(head, e.angle, side);
      const [x, y] = [
        root.x + (head.x - root.x) * PIGMENT_IN,
        root.y + (head.y - root.y) * PIGMENT_IN,
      ];
      fixed.push(spot(plan, x, y, min(PIGMENT * scale, e.size * 0.8), 'pigment', fixed));
    }
  } else {
    fixed.push(spineSpot(plan, line, EYE_SPOT_AT, PIGMENT * scale, 'pigment', fixed));
  }

  // The chambers: their count and kinds, then places, shrinking all of them until every one fits.
  const n = chamberCount(traits);
  const dropletShare = rng.range(DROPLET_SHARE[0], DROPLET_SHARE[1]);
  const size = (CHAMBER * scale) / sqrt(n / CHAMBERS.min);
  const plans = Array.from({ length: n }, (_, i) => {
    const droplet = i < Math.round(n * dropletShare);
    const spread = 1 + CHAMBER_SPREAD * (2 * rng.next() - 1);
    return {
      kind: (droplet ? 'droplet' : 'chamber') as OrganKind,
      r: size * spread * (droplet ? DROPLET : 1),
    };
  });
  const total = plan.segments.reduce((a, s) => a + s.rx * s.ry, 0);
  let shrink = 1;
  for (let round = 0; ; round++) {
    const placed: Organ[] = [...fixed];
    const missed: typeof plans = [];
    for (const c of plans) {
      const r = c.r * shrink;
      let fits = false;
      for (let k = 0; k < TRIES && !fits; k++) {
        const p = samplePoint(plan, rng, total);
        fits = discFits(plan, p.x, p.y, r) && apart(placed, p.x, p.y, r);
        if (fits) placed.push({ kind: c.kind, x: p.x, y: p.y, r });
      }
      if (!fits) missed.push(c);
    }
    if (missed.length === 0 || round === ROUNDS - 1) {
      // The last round puts what is left on the spine, as large as fits there.
      missed.forEach((c, k) => {
        const s = (k + 0.5) / missed.length;
        placed.push(spineSpot(plan, line, s, c.r * shrink, c.kind, placed));
      });
      return { gut, organs: placed };
    }
    shrink *= SHRINK;
  }
}

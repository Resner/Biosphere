// Outline measures of a body plan (M6b T5, ADR 0037): where a chain is widest, how its width runs
// to the tail, and the class rules of copepods, shrimps and worms; and how a curled chain turns
// (M6b T6). Lengths run along the spine, through every link.

import { readdirSync, readFileSync } from 'node:fs';
import type { Genome } from '../src/genome/codec';
import {
  type Appendage,
  type BodyPlan,
  curveAt,
  develop,
  type PlanSegment,
  partCurve,
} from '../src/genome/develop';
import type { Traits } from '../src/genome/express';
import type { Silhouette } from '../src/genome/silhouette';
import { type GallerySpecimen, parseSpecimen, shownGenome } from '../src/lab/gallery';
import { RULES } from '../src/sim/rules';

const GALLERY = new URL('./fixtures/gallery/', import.meta.url);

/** A gallery specimen as the sheet draws it: a karyotype v1 file as its v2 upgrade (ADR 0032). */
export function galleryGenome(prefix: string): Genome {
  const file = readdirSync(GALLERY).find((f) => f.startsWith(`${prefix}-`)) as string;
  const specimen = parseSpecimen(file, readFileSync(new URL(file, GALLERY), 'utf8'));
  return shownGenome(specimen as GallerySpecimen);
}

/** The plan of `traits` laid straight (no curl): its straight twin. */
export const straightPlan = (traits: Traits): BodyPlan =>
  develop({ ...traits, shape: { ...traits.shape, curve: 0 } });

/** A bilateral chain of three or more segments: the bodies that must read as one long body. */
export const isChain = (plan: BodyPlan): boolean =>
  plan.form.radial === 0 && plan.segments.length >= 3;

/**
 * A chain's length along its spine, from the head's front through every link to the tail's end,
 * each segment centre's share of it from the front, and the carapace centre's share (0 without).
 */
export function spine(plan: BodyPlan): { at: number[]; length: number; shell: number } {
  const s = plan.segments;
  const head = s[0] as PlanSegment;
  const along = [head.rx];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = [s[i - 1], s[i]] as [PlanSegment, PlanSegment];
    along.push((along[i - 1] as number) + Math.hypot(b.x - a.x, b.y - a.y));
  }
  const length = (along[s.length - 1] as number) + (s[s.length - 1] as PlanSegment).rx;
  const c = plan.carapace;
  const shell = c.count > 0 ? (head.rx + Math.hypot(c.x - head.x, c.y - head.y)) / length : 0;
  return { at: along.map((x) => x / length), length, shell };
}

export interface TrunkCheck {
  /** The drawn head is at most 0.9 of the trunk's widest half-width. */
  head: boolean;
  /** An unfused chain is widest 25-55% of its length from the front. */
  widest: boolean;
  /** Behind the widest point no segment is more than 1.05 times as wide as the one in front. */
  narrows: boolean;
  /** At least `chain.aspect` times as long as wide (ADR 0031). */
  aspect: boolean;
}

/**
 * The outline rules of a bilateral chain (the widest-point rule binds unfused ones only). The
 * aspect is ADR 0031's, measured along the chain's own curve (M6b T6: a curled chain fits the
 * bounds along its curve, not laid straight).
 */
export function trunkCheck(plan: BodyPlan): TrunkCheck {
  const ry = plan.segments.map((x) => x.ry);
  let w = 0;
  for (let i = 1; i < ry.length; i++) if ((ry[i] as number) > (ry[w] as number)) w = i;
  const { at, length } = spine(plan);
  let narrows = true;
  for (let i = w + 1; i < ry.length; i++) {
    if ((ry[i] as number) > 1.05 * (ry[i - 1] as number) + 1e-12) narrows = false;
  }
  const where = at[w] as number;
  return {
    head: (ry[0] as number) <= 0.9 * Math.max(...ry.slice(1)) + 1e-12,
    widest: plan.carapace.count >= 2 || (where >= 0.25 && where <= 0.55),
    narrows,
    aspect: length / (2 * Math.max(...ry)) >= RULES.develop.chain.aspect - 1e-9,
  };
}

export const passes = (c: TrunkCheck): boolean => c.head && c.widest && c.narrows && c.aspect;

/** The look rules of a copepod, a shrimp or a worm (any other class passes). */
export function classCheck(plan: BodyPlan, cls: Silhouette): boolean {
  const s = plan.segments;
  const ry = s.map((x) => x.ry);
  const { at, length, shell } = spine(plan);
  if (cls === 'copepod') {
    // The fused carapace is the widest part, centred in the front 45%, with a free tail at most
    // half as wide.
    const c = plan.carapace;
    const free = Math.max(...ry.slice(c.count));
    return c.ry >= Math.max(...ry) && shell <= 0.45 && free <= 0.5 * c.ry;
  }
  if (cls === 'shrimp') {
    const legs = plan.appendages.filter((a) => a.side === 1 && a.segment >= 1).length;
    return (ry[0] as number) < Math.max(...ry.slice(1)) && legs >= 3;
  }
  if (cls === 'worm') {
    // Five or more segments, four times as long as wide, even over its middle 80%.
    const middle = ry.filter((_, i) => (at[i] as number) >= 0.1 && (at[i] as number) <= 0.9);
    const even = middle.length === 0 || Math.min(...middle) >= 0.7 * Math.max(...middle);
    return s.length >= 5 && length / (2 * Math.max(...ry)) >= 4 && even;
  }
  return true;
}

/** How far a chain's spine turns from the head to the tail: the tail segment's heading less the head's. */
export const spineTurn = (plan: BodyPlan): number =>
  (plan.segments[plan.segments.length - 1] as PlanSegment).angle -
  (plan.segments[0] as PlanSegment).angle;

/**
 * The two arcs of an S (M6b T6): how far the segments' heading rises from the head to its peak, and
 * how far it falls from there to the tail. A C or a coil has no second arc.
 */
export function sArcs(plan: BodyPlan): [number, number] {
  const angles = plan.segments.map((s) => s.angle);
  const peak = Math.max(...angles);
  return [peak - (angles[0] as number), peak - (angles[angles.length - 1] as number)];
}

/** Each link's length, from the head's to the tail's. */
export const links = (plan: BodyPlan): number[] =>
  plan.segments
    .slice(1)
    .map((s, i) =>
      Math.hypot(
        s.x - (plan.segments[i] as PlanSegment).x,
        s.y - (plan.segments[i] as PlanSegment).y,
      ),
    );

/**
 * Whether body point `p` lies inside the body outline: the union of the segment ellipses, which the
 * loft fills (the gallery hook's `outline`, parts excluded). A carapace is a clear shell over it, not
 * the outline: the legs of its fused segments show through it.
 */
export function insideBody(plan: BodyPlan, p: { x: number; y: number }): boolean {
  return plan.segments.some((s) => {
    const [dx, dy] = [p.x - s.x, p.y - s.y];
    const [c, n] = [Math.cos(s.angle), Math.sin(s.angle)];
    const u = (dx * c + dy * n) / s.rx;
    const v = (dy * c - dx * n) / s.ry;
    return u * u + v * v < 1 - 1e-9;
  });
}

/**
 * The share of a part's drawn centre line (its arc, then the tip cap: `partCurve`) that lies inside
 * the body outline, sampled evenly by length (M6b T7).
 */
export function insideShare(plan: BodyPlan, a: Appendage, samples = 24): number {
  const c = partCurve(plan.segments[a.segment] as PlanSegment, a);
  const total = c.len + c.cap;
  if (!(total > 0)) return 0;
  const end = curveAt(c, 1);
  let inside = 0;
  for (let k = 0; k < samples; k++) {
    const d = ((k + 0.5) / samples) * total;
    const p =
      d <= c.len
        ? curveAt(c, d / c.len)
        : {
            x: end.x + (d - c.len) * Math.cos(end.heading),
            y: end.y + (d - c.len) * Math.sin(end.heading),
          };
    if (insideBody(plan, p)) inside++;
  }
  return inside / samples;
}

/** A body's trunk legs: the left-side gene parts behind the head of a bilateral body of 3+ segments (M6b T7). */
export const trunkLegs = (plan: BodyPlan): Appendage[] =>
  isChain(plan)
    ? plan.appendages.filter((a) => a.side === 1 && a.module >= 0 && a.segment >= 1)
    : [];

/** The median of some numbers (the upper one of an even count). */
export function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] as number;
}

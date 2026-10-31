// Silhouettes (M6 T8, ADR 0025): a name for the shape a body plan draws from above, read from its
// geometry alone: segment count, curve, symmetry, fusion, the tail and webbing shares, and how far
// its parts reach. Tests, the Lab, the gallery and the reports use it; stats and the sim never do.
// Total: every plan gets a class, and `other` is allowed.

import { cos, PI } from '../sim/math';
import { type BodyPlan, dirOf, type PlanSegment, polygonArea, rootOf } from './develop';

export const SILHOUETTES = [
  'cell',
  'ciliate',
  'spiny-larva',
  'bell',
  'tadpole',
  'copepod',
  'shrimp',
  'worm',
  'coil',
  'crab',
  'winged',
  'fan-tail',
  'other',
] as const;

export type Silhouette = (typeof SILHOUETTES)[number];

/** The classifier's thresholds: shape reading, not rules, so they live here. */
const T = {
  /** A ring whose parts point this far rearward on average (dir.x) trails like a bell's tentacles. */
  drape: -0.3,
  /** Membranes over this share of the body's area make a winged body... */
  web: 0.3,
  /** ...and a fan tail when most of the sheet (`tailWeb`) lies behind the rear segment (from half-way to its front on a chain of 3+) and it covers `tailArea` of the body. */
  tailWeb: 0.5,
  tailArea: 0.1,
  /** A shell over this share of the segments is a crab's; a shorter one with a free tail a copepod's. */
  crab: 0.75,
  /**
   * Chains of at least this many segments are long bodies; a worm has at least `worm`, as
   * `RULES.develop.chain.trunk.worm` lays one out (M6b T5).
   */
  long: 4,
  worm: 5,
  /** A worm-long body bent by this much (radians) is a worm. */
  curl: 0.35 * PI,
  /** Long bodies with this many pairs are shrimp. */
  legs: 3,
  /** The front, to the widest segment, holds this share of the body's area in a tadpole. */
  head: 0.65,
  /** A single cell with this many pairs, or this many bristles, is ciliated. */
  cilia: 3,
  bristles: 24,
  /** A thick (half-width at least `tailWidth`), long (at least `tailLength`) rearward part is a tadpole's tail. */
  tailWidth: 0.12,
  tailLength: 1,
};

const area = (s: PlanSegment): number => PI * s.rx * s.ry;

/** The silhouette class of a plan, by geometry only. */
export function silhouetteOf(plan: BodyPlan): Silhouette {
  const segments = plan.segments;
  const n = segments.length;
  if (n === 0) return 'other';
  const left = plan.appendages.filter((a) => a.side === 1);
  const dirs = left.map((a) => {
    const s = segments[a.segment];
    return s ? dirOf(s, a) : { x: 0, y: 0 };
  });

  if (plan.form.radial === 1) {
    const back = dirs.length > 0 ? dirs.reduce((sum, d) => sum + d.x, 0) / dirs.length : 0;
    return back <= T.drape ? 'bell' : 'spiny-larva';
  }
  if (plan.form.mode === 2) return 'coil';

  // The body's size is its girth: slimming a long chain to read long compresses it sideways and
  // keeps its bulk (ADR 0031), so the webs and the head are weighed against that.
  let drawn = 0;
  for (const s of segments) drawn += area(s);
  const body = drawn / plan.form.slim;
  // The tail starts at the rear segment's centre, or half-way to its front on a chain of 3+, whose
  // long tail segment (M6b T5) carries its fan along it.
  const rear = segments[n - 1] as PlanSegment;
  const rearX = n >= 3 ? rear.x + 0.5 * rear.rx * cos(rear.angle) : rear.x;
  let web = 0;
  let tail = 0;
  for (const m of plan.membranes) {
    const a = polygonArea(m.points);
    web += a;
    const cx = m.points.reduce((sum, p) => sum + p.x, 0) / Math.max(1, m.points.length);
    if (cx < rearX) tail += a;
  }
  if (tail >= T.tailArea * body && tail >= T.tailWeb * web) return 'fan-tail';
  if (web >= T.web * body) return 'winged';

  const fused = plan.carapace.count;
  if (n >= 2 && fused >= T.crab * n) return 'crab';
  if (fused >= 2 && n - fused >= 2) return 'copepod';

  // A big front with a thin tail: a two-segment chain's head, or a longer body up to its widest
  // segment, since its head is narrower than its trunk (M6b T5).
  let widest = 0;
  for (let i = 1; i < n && n >= 3; i++) {
    if ((segments[i] as PlanSegment).ry > (segments[widest] as PlanSegment).ry) widest = i;
  }
  let front = 0;
  for (let i = 0; i <= widest; i++) front += area(segments[i] as PlanSegment);
  const frontShare = front / drawn;
  if (n >= T.long) {
    // A curled chain is a worm from `worm` segments; a shorter one reads as a short body.
    const curled = Math.abs(plan.form.turn) >= T.curl;
    if (curled && n >= T.worm) return 'worm';
    if (!curled && left.length >= T.legs) return 'shrimp';
    if (n >= T.worm) return frontShare >= T.head ? 'tadpole' : 'worm';
  }
  if (n >= 2) return frontShare >= T.head ? 'tadpole' : 'other';

  // One cell: a fringe of cilia or bristles, a thick tail, or a plain cell.
  const bristles = plan.appendages.reduce((sum, a) => sum + a.setae, 0);
  if (left.length >= T.cilia || bristles >= T.bristles) return 'ciliate';
  const tailed = left.some((a, i) => {
    const s = segments[a.segment] as PlanSegment;
    const reach = rootOf(s, a.angle, a.side);
    return (
      a.width / 2 >= T.tailWidth &&
      a.length >= T.tailLength &&
      (dirs[i] as { x: number }).x < -0.5 &&
      reach.x < 0
    );
  });
  return tailed ? 'tadpole' : 'cell';
}

// A body plan reads as an organism (M6c T3, ADR 0041): parts are read by the region they attach
// to, and development shapes them by it. A head carries one long and one short antenna pair, the
// trunk up to six short legs swept back, the rear one tail structure, and a radial body five to
// nine spokes. At most 14 instances show; the rest become a fringe of fine cilia that still counts
// for the stats. Shared and deterministic: development and the tests read the same rules.

import { cos, length as hypot, PI } from '../sim/math';
import { hashU32 } from '../sim/prng';
import { RULES } from '../sim/rules';
import type { Appendage, BodyPlan, PlanSegment } from './develop';

const O = RULES.develop.organism;
const deg = (d: number): number => (d * PI) / 180;

export type Region = 'head' | 'trunk' | 'rear';

/** What a part does in its body: a role decides its region's limits, `fringe` that it is cilia. */
export type Role = 'antenna' | 'feeler' | 'leg' | 'tail' | 'spoke' | 'fringe';

/** The head's cone: an attach angle at most this far from the heading (radians). */
export const HEAD_CONE = deg(O.head.cone);

/** A leg's growth direction from its segment's heading: swept back 25-70° from the side. */
export const LEG_DIR: readonly [number, number] = [
  PI / 2 + deg(O.trunk.sweep[0] as number),
  PI / 2 + deg(O.trunk.sweep[1] as number),
];

/** A body's length along its spine: the head's front, through every link, to the tail's end. */
export function bodyLength(segments: readonly PlanSegment[]): number {
  const head = segments[0] as PlanSegment;
  let length = head.rx + (segments[segments.length - 1] as PlanSegment).rx;
  for (let i = 1; i < segments.length; i++) {
    const [a, b] = [segments[i - 1], segments[i]] as [PlanSegment, PlanSegment];
    length += hypot(b.x - a.x, b.y - a.y);
  }
  return length;
}

/** A body's width: twice its widest segment's drawn half-width. */
export function bodyWidth(segments: readonly PlanSegment[]): number {
  let w = 0;
  for (const s of segments) w = Math.max(w, s.ry);
  return 2 * w;
}

/** Where a root at `angle` on segment `segment` lies along the body: 0 the head's front, 1 the tail's end. */
export function spineShare(segments: readonly PlanSegment[], segment: number, angle: number): number {
  let at = (segments[0] as PlanSegment).rx;
  for (let i = 1; i <= segment; i++) {
    const [a, b] = [segments[i - 1], segments[i]] as [PlanSegment, PlanSegment];
    at += hypot(b.x - a.x, b.y - a.y);
  }
  const s = segments[segment] as PlanSegment;
  return (at - s.rx * cos(angle)) / bodyLength(segments);
}

/** The region of a bilateral part from where it attaches: its root's share along the spine, and its angle. */
export function regionOf(
  part: Pick<Appendage, 'segment' | 'angle'>,
  plan: Pick<BodyPlan, 'segments'>,
): Region {
  const t = spineShare(plan.segments, part.segment, part.angle);
  if (t <= O.head.share && part.angle <= HEAD_CONE) return 'head';
  if (t >= 1 - O.rear.share) return 'rear';
  return 'trunk';
}

/** The longest a part of `role` may be on this body (Infinity: no region limit). */
export function longest(role: Role, segments: readonly PlanSegment[]): number {
  switch (role) {
    case 'antenna':
      return O.head.long * bodyLength(segments);
    case 'feeler':
      return O.head.short * bodyLength(segments);
    case 'leg':
      return O.trunk.length * bodyWidth(segments);
    case 'tail':
      return O.rear.tail * bodyLength(segments);
    case 'fringe':
      return O.fringe.length * bodyWidth(segments);
    default:
      return Number.POSITIVE_INFINITY;
  }
}

/** Instances a body shows: every part but its fringe (a branch belongs to its part). */
export const visibleCount = (plan: Pick<BodyPlan, 'appendages'>): number =>
  plan.appendages.reduce((n, a) => n + (a.fringe ? 0 : 1), 0);

/** The visible pairs a bilateral body keeps: `budget` ÷ 2. */
export const VISIBLE_PAIRS = Math.floor(O.budget / 2);

/** Radial spokes: at least 3 pairs and at most 4 (5-9 instances, mirrored in pairs). */
export const SPOKE_PAIRS: readonly [number, number] = [
  Math.ceil((O.radial.spokes[0] as number) / 2),
  Math.floor((O.radial.spokes[1] as number) / 2),
];

/** A spoke's length factor, 1 ± `radial.vary`, from a hash of its ring slot and its part's genes. */
export function spokeVary(
  slot: number,
  part: Pick<Appendage, 'module' | 'phase' | 'length'>,
): number {
  const bits = (v: number): number => Math.floor(v * 65536);
  const h = (hashU32(slot, part.module + 1, bits(part.phase), bits(part.length)) >>> 0) / 4294967296;
  return 1 + O.radial.vary * (2 * h - 1);
}

/**
 * The roles of a bilateral body's pairs, by region (ADR 0041): on the head the longest pair is the
 * long antennae and the next the short; on the trunk the front `trunk.pairs` are legs; on the rear
 * the longest is the tail structure. Then the budget: the body keeps the tail, the long antennae,
 * the short antennae and legs from the front, `VISIBLE_PAIRS` in all; the rest is fringe.
 * `regions` and `lengths` are per pair, in the pairs' order; ties keep that order.
 */
export function rolesOf(
  regions: readonly Region[],
  lengths: readonly number[],
  along: readonly number[],
): Role[] {
  const roles: Role[] = regions.map(() => 'fringe');
  const by = (region: Region): number[] =>
    regions.map((r, i) => (r === region ? i : -1)).filter((i) => i >= 0);
  const longFirst = (ids: number[]): number[] =>
    [...ids].sort((a, b) => (lengths[b] as number) - (lengths[a] as number) || a - b);
  const head = longFirst(by('head'));
  const rear = longFirst(by('rear'));
  const legs = by('trunk')
    .sort((a, b) => (along[a] as number) - (along[b] as number) || a - b)
    .slice(0, O.trunk.pairs);
  const keep: [number, Role][] = [];
  if (rear[0] !== undefined) keep.push([rear[0], 'tail']);
  if (head[0] !== undefined) keep.push([head[0], 'antenna']);
  if (head[1] !== undefined) keep.push([head[1], 'feeler']);
  for (const i of legs) keep.push([i, 'leg']);
  for (const [i, role] of keep.slice(0, VISIBLE_PAIRS)) roles[i] = role;
  return roles;
}

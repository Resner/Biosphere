// Outline measures of a body plan (M6b T5, ADR 0037): where a chain is widest, how its width runs
// to the tail, and the class rules of copepods, shrimps and worms. Lengths run along the spine,
// through every link.

import { type BodyPlan, develop, type PlanSegment } from '../src/genome/develop';
import type { Traits } from '../src/genome/express';
import type { Silhouette } from '../src/genome/silhouette';
import { RULES } from '../src/sim/rules';

/** The plan of `traits` laid straight (no curl), as ADR 0031 measures a chain's aspect. */
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
 * aspect is ADR 0031's, laid straight: `straight` is the same genome developed with no curl, which
 * a curled worm is slimmer than.
 */
export function trunkCheck(plan: BodyPlan, straight: BodyPlan = plan): TrunkCheck {
  const ry = plan.segments.map((x) => x.ry);
  let w = 0;
  for (let i = 1; i < ry.length; i++) if ((ry[i] as number) > (ry[w] as number)) w = i;
  const { at } = spine(plan);
  const length = spine(straight).length;
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

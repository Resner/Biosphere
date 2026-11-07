// Size tiers (ADR 0013, DESIGN §4): a creature's radius is the square root of its biomass, and a
// tier is a ×4 step in radius from 32 (T0 below 32, T1 below 128, T2 below 512, T3 below 2,048).

import { pow } from './math';
import { RULES } from './rules';

const TIER_BASE_RADIUS = 32;
const TIER_STEP = 4;
const MAX_TIER = 4;

/** The tier 0-4 of a creature with this biomass (compared as radius², so no root is taken). */
export function sizeTier(biomass: number): number {
  let tier = 0;
  for (let edge = TIER_BASE_RADIUS; tier < MAX_TIER && biomass >= edge * edge; edge *= TIER_STEP) {
    tier++;
  }
  return tier;
}

/** How another creature compares with one's own by size tier: the edge indicators and outlines (M6 T19, T21). */
export type SizeClass = 'smaller' | 'comparable' | 'bigger';

/** The size class of a creature of `otherRadius` seen by one of `ownRadius` (radius² is biomass). */
export function sizeClass(ownRadius: number, otherRadius: number): SizeClass {
  const own = sizeTier(ownRadius * ownRadius);
  const other = sizeTier(otherRadius * otherRadius);
  if (other > own) return 'bigger';
  if (other < own) return 'smaller';
  return 'comparable';
}

/** Radii are read this much closer together than they are before two creatures' tiers are compared. */
export const TIER_LINK_MARGIN = 1.1;

/**
 * Whether two creatures of these radii may share a link (M11, ADR 0062): their tiers differ by at
 * most one once each radius is moved `TIER_LINK_MARGIN` towards the other. A superset of "tiers
 * within ±1", so a creature growing across an edge never drops a link it needs, and symmetric.
 */
export function linkTiers(ra: number, rb: number): boolean {
  const larger = Math.max(ra, rb) / TIER_LINK_MARGIN;
  const smaller = Math.min(ra, rb) * TIER_LINK_MARGIN;
  return sizeTier(larger * larger) - sizeTier(smaller * smaller) <= 1;
}

/** The radius of the largest creature `linkTiers` lets a creature of radius `r` link with. */
export const maxLinkRadius = (r: number): number =>
  TIER_STEP * TIER_STEP * TIER_LINK_MARGIN * TIER_LINK_MARGIN * r;

/**
 * Visible half-height in world units for a creature of radius `r` whose genetic maximum radius is
 * `adult`: `heightCoeff · adult^heightExp · (r / adult)^growExp` (DESIGN §3, ADR 0029); a creature
 * past its maximum counts as an adult.
 */
export function viewHalfHeight(r: number, adult: number): number {
  const { heightCoeff, heightExp, growExp } = RULES.camera;
  const top = Math.max(r, adult);
  if (!(r > 0)) return 0;
  return heightCoeff * pow(top, heightExp) * pow(r / top, growExp);
}

// Size tiers (ADR 0013, DESIGN §4): a creature's radius is the square root of its biomass, and a
// tier is a ×4 step in radius from 32 (T0 below 32, T1 below 128, T2 below 512, T3 below 2,048).

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

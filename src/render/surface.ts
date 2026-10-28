// Materials v2 (M6 T13): the pure numbers behind the creature shader's surface. Rare glints are
// jewel-like star points on joints and organs, as many and as bright as the rarity tier allows
// (#90: "sparkles must feel exceptionally rare"). The procedural surface detail (pores, a cell
// texture, the vein network of membranes) fades out with its size on screen, so it never aliases
// into noise on a small body.

import type { Traits } from '../genome/express';
import { type RarityTier, rarityOfTraits } from '../genome/rarity';
import { clamp } from '../sim/math';
import type { CreatureSource } from './creature-cache';
import type { GlintPlan } from './creature-mesh';
import { materialParams } from './material-params';

export interface Glints {
  /** Star points on the body, 0..`MAX_GLINTS`. */
  count: number;
  /** Half the width of a star, rays included, in core radii. */
  size: number;
  /** The star's peak above white; above 1 it blooms. */
  brightness: number;
}

/** The most glints any body carries (an exotic, fully iridescent one). */
export const MAX_GLINTS = 16;

/**
 * Per tier: the count at no iridescence and the extra a full thin film adds, the brightness and
 * the size likewise. Each tier starts at or above where the one below ends, so a rarer body never
 * glints less, whatever its iridescence.
 */
export const GLINT_TIERS: Readonly<
  Record<
    RarityTier,
    { count: [number, number]; brightness: [number, number]; size: [number, number] }
  >
> = {
  common: { count: [0, 1], brightness: [0.3, 0.1], size: [0.16, 0.02] },
  uncommon: { count: [1, 2], brightness: [0.55, 0.1], size: [0.18, 0.02] },
  rare: { count: [4, 4], brightness: [0.85, 0.15], size: [0.2, 0.02] },
  exotic: { count: [12, 4], brightness: [1.1, 0.25], size: [0.22, 0.03] },
};

/** How many glints a body of `tier` and `iridescence` (0..1, `materialParams`) carries, how large and bright. */
export function glintsFor(tier: RarityTier, iridescence: number): Glints {
  const t = GLINT_TIERS[tier];
  const i = clamp(iridescence, 0, 1);
  return {
    count: t.count[0] + Math.round(t.count[1] * i),
    size: t.size[0] + t.size[1] * i,
    brightness: t.brightness[0] + t.brightness[1] * i,
  };
}

/** A creature's rare glints: by its rarity tier and its iridescence. */
export const glintsOf = (traits: Traits): Glints =>
  glintsFor(rarityOfTraits(traits).tier, materialParams(traits).iridescence);

/** Where and how large a creature's glints are drawn: `glintsOf`, placed by its genome hash. */
export function glintPlanOf(creature: CreatureSource): GlintPlan {
  const { count, size } = glintsOf(creature.traits);
  return { count, size, seed: creature.hash };
}

/** Surface detail fades in between these sizes on screen (pixels per feature). */
export const DETAIL_FADE = { from: 2, to: 5 } as const;

/** The size of each kind of surface detail, in core radii. */
export const DETAIL_SIZE = {
  /** Pores: small dark pits in the shell. */
  pore: 0.07,
  /** The cell texture: faint walls between the shell's cells. */
  cell: 0.2,
  /** The fine vein network across a membrane. */
  vein: 0.14,
  /** Small imperfections: an uneven thickness of the glass. */
  flaw: 0.35,
} as const;

/** How much of a detail `px` pixels across is drawn: the shader's `detailFade`, a smoothstep over `DETAIL_FADE`. */
export function detailFade(px: number): number {
  const t = clamp((px - DETAIL_FADE.from) / (DETAIL_FADE.to - DETAIL_FADE.from), 0, 1);
  return t * t * (3 - 2 * t);
}

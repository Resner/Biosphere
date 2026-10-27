// Depth of field (M6 T3, ADR 0027). The game is a top-down plane: everything that plays (creatures,
// food, plumes) lies on it and stays sharp, and only the drifting particle layers lie above or below
// it, at depths they know. Those layers are point sprites, so each speck draws its own circle of
// confusion (a scatter): its disc grows by the CoC of its depth and spreads its light over the larger
// disc. That is exact for points and costs no pass, no target and no depth buffer, where gathering a
// blurred image (even at half resolution) costs a full-screen pass per layer. Medium blurs up to
// 6 px and high up to 12 px, with a chromatic fringe on bright discs.

import type { PresetName } from '../presets';

/** Tuned by eye against `docs/art/reference-01.jpg`. */
export const DOF_LOOK = {
  /** CoC radius in pixels (at a pixel ratio of 1) per camera height off the focus plane. */
  slope: 24,
  /** The largest CoC radius in pixels (at a pixel ratio of 1): half strength on medium. */
  maxPx: { medium: 6, high: 12 },
  /** On high, a disc's red edge reaches this share of its CoC further out and its blue edge as far in. */
  fringe: 0.2,
} as const;

/**
 * The radius of the blur disc of something at depth `z` when the focus plane is at `focusZ`, in
 * pixels at a pixel ratio of 1: 0 at the focus plane, then linear in the distance up to 6 px on
 * medium and 12 px on high. Depths are in camera heights, 0 at the gameplay plane and positive
 * towards the camera. Low has no depth of field.
 */
export function circleOfConfusion(z: number, focusZ: number, preset: PresetName): number {
  if (preset === 'low') return 0;
  return Math.min(DOF_LOOK.maxPx[preset], DOF_LOOK.slope * Math.abs(z - focusZ));
}

/**
 * A layer that follows the camera at `parallax` (1 for the plane) lies this deep, in camera heights:
 * seen from a camera one height above the plane, a thing at depth z moves 1 / (1 - z) as fast.
 */
export const depthOfParallax = (parallax: number): number => 1 - 1 / parallax;
export const parallaxOfDepth = (z: number): number => 1 / (1 - z);

export interface BokehShape {
  /** The profile is `peak` inside `inner` and falls to 0 at `outer` (pixels from the centre). */
  inner: number;
  outer: number;
  peak: number;
}

/** A smoothstep profile from `a` out to `a + w`, integrated over the disc, divided by pi. */
const profileEnergy = (a: number, w: number): number => a * a + a * w + 0.3 * w * w;

/**
 * A sprite of diameter `size` (pixels), a soft dot (`hardness` 0) or a hard-edged disc (1), seen
 * through a blur disc of radius `coc`: the edge widens by the CoC on both sides and the peak falls so
 * that the sprite carries the same light. Mirrors `particles.vert.glsl`.
 */
export function bokehShape(size: number, hardness: number, coc: number): BokehShape {
  const radius = size * (0.25 + 0.21 * hardness);
  const edge = size * (0.25 - 0.21 * hardness);
  const inner = Math.max(Math.abs(radius - coc) - edge, 0);
  const outer = radius + coc + edge;
  const peak =
    coc > 0
      ? Math.min(1, profileEnergy(radius - edge, 2 * edge) / profileEnergy(inner, outer - inner))
      : 1;
  return { inner, outer, peak };
}

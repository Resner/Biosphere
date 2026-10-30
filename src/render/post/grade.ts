// The grade's highlight shoulder (M6 T2; M6b T4, ADR 0034), as plain numbers the composite shader
// (`post.frag.glsl`) takes as uniforms and the tests check. Tones above the knee roll off toward a
// cool near-white whose red stays below 245, so stacked bright strokes and their bloom never burn
// to solid white. A glint's hot point still reaches white: it stands far above the scene a few
// pixels round it, as no stroke, cloud of setae or bloom does, and there the ceiling rises to 1.

type Rgb = readonly [number, number, number];

export const GRADE = {
  /** Tones above this roll off instead of clipping. */
  knee: 0.78,
  /**
   * The ceiling each channel rolls off toward: a pale, cool white (237, 249, 255). Red stays below
   * 245 even with the film grain's half amplitude on top, so no pixel reads as solid white.
   */
  white: [0.93, 0.975, 1] as Rgb,
  /**
   * How far the scene's luminance (before bloom) stands above its mean at `around` pixels
   * diagonally round it, over which the ceiling rises to white: a rare or exotic glint's hot point
   * stands 1.4 to 3 above, a stroke inside a cloud of them under 0.5.
   */
  hot: [0.8, 1.4] as const,
  /** The diagonal distance of the four taps round a pixel, in scene pixels (each axis). */
  around: 2,
} as const;

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * The shoulder as the composite draws it: `colour` is the scene with its rays and bloom added;
 * `sceneLuma` the scene's own luminance at the pixel and `aroundLuma` its mean at the four
 * diagonal taps (together they tell a glint's hot point apart).
 */
export function gradeHighlights(
  colour: Rgb,
  sceneLuma: number,
  aroundLuma: number,
): [number, number, number] {
  const hot = smoothstep(GRADE.hot[0], GRADE.hot[1], sceneLuma - aroundLuma);
  const k = GRADE.knee;
  return colour.map((c, i) => {
    const white = (GRADE.white[i] as number) + (1 - (GRADE.white[i] as number)) * hot;
    const over = Math.max(c - k, 0);
    return Math.min(c, k) + (white - k) * (1 - Math.exp(-over / (white - k)));
  }) as [number, number, number];
}

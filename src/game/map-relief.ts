// The pond map's relief (owner, Playtest v0.7.2): the picture is the depth map softened and lit like
// a chart. The sim's depth field is flat inside the spawn disc (held within a cap of the middle
// depth) and bends where the cap opens, which a straight colouring turns into a hard circle. The map
// is a picture, not the rules, so it smooths the depth first, then lights it from the north-west and
// draws faint isobaths at the zone edges. Pure functions on depth bytes; no DOM.

/** The blur's radius in texels (three box passes make it near-Gaussian): about 190 wu on a 256 map. */
export const MAP_SMOOTH_RADIUS = 6;
/** How strongly a slope lights or shades the colour (a slope of one byte per texel shifts it by this). */
export const RELIEF_STRENGTH = 0.045;
/** The most a texel is lightened or darkened by relief, as a share of its colour. */
export const RELIEF_LIMIT = 0.22;
/** An isobath's strength where it crosses an edge: the share of the way to white. */
export const ISOBATH_STRENGTH = 0.12;
/** An isobath is never thinner than this gradient floor allows (bytes per texel), so flats stay thin. */
const ISOBATH_FLOOR = 0.5;

/** Light comes from the north-west (up-left on the picture). */
const LIGHT_X = -0.7071;
const LIGHT_Y = -0.7071;

/** One horizontal or vertical box blur pass with edge clamping, `src` into `dst` (a stride per axis). */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  n: number,
  radius: number,
  step: number,
  across: number,
): void {
  const width = 2 * radius + 1;
  for (let line = 0; line < n; line++) {
    const base = line * across;
    let sum = 0;
    for (let k = -radius; k <= radius; k++) {
      sum += src[base + Math.min(n - 1, Math.max(0, k)) * step] as number;
    }
    for (let i = 0; i < n; i++) {
      dst[base + i * step] = sum / width;
      const out = Math.max(0, i - radius);
      const into = Math.min(n - 1, i + radius + 1);
      sum += (src[base + into * step] as number) - (src[base + out * step] as number);
    }
  }
}

/**
 * A depth grid of `n` × `n` bytes smoothed by a near-Gaussian blur of `radius` texels (three box
 * passes per axis, edges clamped), as floats on the same 0–255 scale. A constant grid stays
 * constant and the mean depth is kept.
 */
export function smoothDepth(grid: Uint8Array, n: number, radius = MAP_SMOOTH_RADIUS): Float32Array {
  let a = Float32Array.from(grid);
  let b = new Float32Array(n * n);
  if (radius < 1) return a;
  for (let pass = 0; pass < 3; pass++) {
    boxPass(a, b, n, radius, 1, n);
    [a, b] = [b, a];
    boxPass(a, b, n, radius, n, 1);
    [a, b] = [b, a];
  }
  return a;
}

/**
 * Relief for a smoothed depth grid, both per texel: `shade` (about 1; above 1 on slopes facing the
 * light, below on those facing away, within ±`RELIEF_LIMIT`) and `line` (0–1, an isobath where the
 * depth crosses one of `edges`, given on the 0–255 scale). Row 0 is the grid's first row, so the
 * caller passes the grid already in picture order (north first) for the light to come from the top.
 */
export function relief(
  depth: Float32Array,
  n: number,
  edges: readonly number[],
): { shade: Float32Array; line: Float32Array } {
  const shade = new Float32Array(n * n);
  const line = new Float32Array(n * n);
  const at = (i: number, j: number) =>
    depth[Math.min(n - 1, Math.max(0, j)) * n + Math.min(n - 1, Math.max(0, i))] as number;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const gx = (at(i + 1, j) - at(i - 1, j)) / 2;
      const gy = (at(i, j + 1) - at(i, j - 1)) / 2;
      // Deeper is darker: a slope that rises toward the light (shallower there) is lit.
      const lit = -(gx * LIGHT_X + gy * LIGHT_Y);
      const o = j * n + i;
      shade[o] = 1 + Math.max(-RELIEF_LIMIT, Math.min(RELIEF_LIMIT, lit * RELIEF_STRENGTH));
      const grad = Math.max(ISOBATH_FLOOR, Math.hypot(gx, gy));
      let best = 0;
      for (const edge of edges) {
        // Distance to the edge in texels: 1 on the line's centre, fading to 0 a texel away.
        const d = Math.abs((depth[o] as number) - edge) / grad;
        best = Math.max(best, Math.max(0, 1 - d));
      }
      line[o] = best;
    }
  }
  return { shade, line };
}

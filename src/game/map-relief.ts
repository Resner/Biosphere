// The map's chart (owner, Playtest v0.7.2): the picture is the depth map softened and lit like a
// chart. The sim's depth field is flat inside the spawn disc (held within a cap of the middle depth)
// and bends where the cap opens, which a straight colouring turns into a hard circle. The chart is a
// picture, not the rules, so it smooths the depth first, then lights it from the north-west and
// draws faint isobaths at the zone edges. `ChartJob` does it in steps, so the map can spread a
// picture over several frames (M11 T18). Pure functions on depth bytes; no DOM.

import { ZONES, zoneWeights } from '../render/zones';
import type { Zone } from '../sim/bathymetry';
import { clamp } from '../sim/math';
import { RULES } from '../sim/rules';

/** The blur's radius in texels (three box passes make it near-Gaussian): about 190 wu on a 256 map. */
export const MAP_SMOOTH_RADIUS = 6;
/** How strongly a slope lights or shades the colour (a slope of one byte per texel shifts it by this). */
export const RELIEF_STRENGTH = 0.045;
/** The most a texel is lightened or darkened by relief, as a share of its colour. */
export const RELIEF_LIMIT = 0.22;
/** Canvas colours the map and the minimap share: beyond the world, its edge, label ink and halo. */
export const BEYOND = '#020608';
export const EDGE = 'rgb(227 244 240 / 0.6)';
export const INK = '#e3f4f0';
export const SHADOW = 'rgb(0 0 0 / 0.75)';
/** An isobath's strength where it crosses an edge: the share of the way to white. */
export const ISOBATH_STRENGTH = 0.12;
/** An isobath is never thinner than this gradient floor allows (bytes per texel), so flats stay thin. */
const ISOBATH_FLOOR = 0.5;
/** How far an edge texel is lightened, so zones are told apart by a line as well as a colour. */
export const EDGE_LIGHTEN = 0.45;

/** Light comes from the north-west (up-left on the picture). */
const LIGHT_X = -0.7071;
const LIGHT_Y = -0.7071;

/**
 * Each zone's colour on the map: its water brightened to read on a small picture, getting darker
 * with depth so brightness alone separates them (the legend names them too).
 */
export const MAP_COLOURS: Readonly<Record<Zone, readonly [number, number, number]>> = {
  shallows: [0.3, 0.66, 0.54],
  twilight: [0.1, 0.3, 0.36],
  deep: [0.04, 0.1, 0.22],
  abyss: [0.02, 0.025, 0.06],
};

/** Each depth byte's colour (0–255 per channel, three to a depth), mixing the zones as the water does. */
function depthColours(): Float32Array {
  if (colourLut) return colourLut;
  const lut = new Float32Array(256 * 3);
  for (let d = 0; d < 256; d++) {
    const w = zoneWeights(d / 255);
    for (let k = 0; k < 3; k++) {
      let c = 0;
      for (let z = 0; z < 4; z++)
        c += (w[z] as number) * (MAP_COLOURS[ZONES[z] as Zone][k] as number);
      lut[d * 3 + k] = Math.round(c * 255);
    }
  }
  colourLut = lut;
  return lut;
}

let colourLut: Float32Array | null = null;

/**
 * RGBA pixels for a depth grid of `n` × `n` bytes (row = y, south first, as `depthGrid` gives):
 * row 0 of the picture is the north edge. Each texel mixes the zones' colours by the same weights
 * the viewport's water uses (`zoneWeights`), so the map grades from one zone into the next as a
 * gradient and not in hard-edged steps (the owner's Playtest v0.7.2).
 */
export function zonePixels(grid: Uint8Array, n: number): Uint8ClampedArray<ArrayBuffer> {
  const lut = depthColours();
  const out = new Uint8ClampedArray(new ArrayBuffer(n * n * 4));
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const d = (grid[j * n + i] as number) * 3;
      const o = ((n - 1 - j) * n + i) * 4;
      out[o] = lut[d] as number;
      out[o + 1] = lut[d + 1] as number;
      out[o + 2] = lut[d + 2] as number;
      out[o + 3] = 255;
    }
  }
  return out;
}

/** One horizontal or vertical box blur pass with edge clamping over lines `from` to `to`, `src` into `dst`. */
function boxPass(
  src: Float32Array,
  dst: Float32Array,
  n: number,
  radius: number,
  step: number,
  across: number,
  from = 0,
  to = n,
): void {
  const width = 2 * radius + 1;
  for (let line = from; line < to; line++) {
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

/** One row `j` of `relief`, written from `at` in `shade` and `line`. */
function reliefRow(
  depth: Float32Array,
  n: number,
  edges: readonly number[],
  j: number,
  shade: Float32Array,
  line: Float32Array,
  at: number,
): void {
  const up = Math.max(0, j - 1) * n;
  const down = Math.min(n - 1, j + 1) * n;
  const here = j * n;
  for (let i = 0; i < n; i++) {
    const gx =
      ((depth[here + Math.min(n - 1, i + 1)] as number) -
        (depth[here + Math.max(0, i - 1)] as number)) /
      2;
    const gy = ((depth[down + i] as number) - (depth[up + i] as number)) / 2;
    // Deeper is darker: a slope that rises toward the light (shallower there) is lit.
    const lit = -(gx * LIGHT_X + gy * LIGHT_Y);
    shade[at + i] = 1 + clamp(lit * RELIEF_STRENGTH, -RELIEF_LIMIT, RELIEF_LIMIT);
    const grad = Math.max(ISOBATH_FLOOR, Math.sqrt(gx * gx + gy * gy));
    const depthHere = depth[here + i] as number;
    let best = 0;
    for (const edge of edges) {
      // Distance to the edge in texels: 1 on the line's centre, fading to 0 a texel away.
      const d = Math.abs(depthHere - edge) / grad;
      best = Math.max(best, Math.max(0, 1 - d));
    }
    line[at + i] = best;
  }
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
  for (let j = 0; j < n; j++) reliefRow(depth, n, edges, j, shade, line, j * n);
  return { shade, line };
}

/** The zone edges on the 0–255 depth scale, where the isobaths run. */
const ISOBATHS: readonly number[] = (() => {
  const z = RULES.bathymetry.zones;
  return [z.shallows * 255, z.twilight * 255, z.deep * 255];
})();
/** A row of relief and colour costs about this many blur rows (in Node, some 100 ns a texel against 5). */
const COLOUR_WEIGHT = 16;
/** The six blur passes, then one pass of relief and colour. */
const BLUR_PASSES = 6;

/**
 * The chart of one `n` × `n` depth grid, built in steps: `start` takes the grid, and each `step`
 * does up to a budget of work (a blur row is `n` units, a row of relief and colour
 * `COLOUR_WEIGHT` times that) until `pixels` holds the picture, north first. It reuses its buffers across pictures.
 */
export class ChartJob {
  readonly pixels: Uint8ClampedArray<ArrayBuffer>;
  private a: Float32Array;
  private b: Float32Array;
  private readonly shade: Float32Array;
  private readonly line: Float32Array;
  private radius = MAP_SMOOTH_RADIUS;
  /** The pass under way (0–5 the blur's, 6 relief and colour, 7 done) and its next line. */
  private pass = BLUR_PASSES + 1;
  private next = 0;

  constructor(readonly n: number) {
    this.pixels = new Uint8ClampedArray(new ArrayBuffer(n * n * 4));
    this.a = new Float32Array(n * n);
    this.b = new Float32Array(n * n);
    this.shade = new Float32Array(n);
    this.line = new Float32Array(n);
  }

  get done(): boolean {
    return this.pass > BLUR_PASSES;
  }

  /** Starts a picture of `grid` (row = y, south first), blurred over `radius` texels. */
  start(grid: Uint8Array, radius = MAP_SMOOTH_RADIUS): void {
    const { n, a } = this;
    // Picture order first (north at row 0), so the light comes from the top.
    for (let j = 0; j < n; j++) {
      const from = j * n;
      const to = (n - 1 - j) * n;
      for (let i = 0; i < n; i++) a[to + i] = grid[from + i] as number;
    }
    this.radius = radius;
    this.pass = radius < 1 ? BLUR_PASSES : 0;
    this.next = 0;
  }

  /** Does up to `budget` units of work; returns the units done (0 once the picture is done). */
  step(budget: number): number {
    const { n } = this;
    let used = 0;
    while (!this.done && used < budget) {
      const weight = this.pass === BLUR_PASSES ? COLOUR_WEIGHT * n : n;
      const fit = Math.floor((budget - used) / weight);
      // A step does at least one line, and never starts one its budget cannot cover.
      if (fit < 1 && used > 0) break;
      const lines = Math.min(n - this.next, Math.max(1, fit));
      const to = this.next + lines;
      if (this.pass < BLUR_PASSES) {
        // Even passes run along rows, odd ones down columns.
        const rows = this.pass % 2 === 0;
        boxPass(this.a, this.b, n, this.radius, rows ? 1 : n, rows ? n : 1, this.next, to);
      } else {
        for (let j = this.next; j < to; j++) this.colourRow(j);
      }
      used += lines * weight;
      this.next = to;
      if (this.next >= n) {
        if (this.pass < BLUR_PASSES) [this.a, this.b] = [this.b, this.a];
        this.pass++;
        this.next = 0;
      }
    }
    return used;
  }

  /** Relief and colour for picture row `j`, from the smoothed depth in `a`. */
  private colourRow(j: number): void {
    const { n, a: depth, shade, line, pixels } = this;
    reliefRow(depth, n, ISOBATHS, j, shade, line, 0);
    const lut = depthColours();
    for (let i = 0; i < n; i++) {
      const o = j * n + i;
      const d = clamp(depth[o] as number, 0, 255);
      const lo = Math.floor(d);
      const hi = Math.min(255, lo + 1);
      const f = d - lo;
      const s = shade[i] as number;
      const l = (line[i] as number) * ISOBATH_STRENGTH;
      for (let k = 0; k < 3; k++) {
        const c = (lut[lo * 3 + k] as number) * (1 - f) + (lut[hi * 3 + k] as number) * f;
        pixels[o * 4 + k] = Math.round(c * s + (255 - c * s) * l);
      }
      pixels[o * 4 + 3] = 255;
    }
  }
}

/**
 * The map's picture (owner, Playtest v0.7.2): the depth softened, coloured like `zonePixels`, lit
 * from the north-west and crossed by faint isobaths at the zone edges, so the flat spawn disc and
 * the zones read as one chart without a hard circle. Same layout as `zonePixels` (north first).
 */
export function mapPixels(
  grid: Uint8Array,
  n: number,
  radius = MAP_SMOOTH_RADIUS,
): Uint8ClampedArray<ArrayBuffer> {
  const job = new ChartJob(n);
  job.start(grid, radius);
  job.step(Number.POSITIVE_INFINITY);
  return job.pixels;
}

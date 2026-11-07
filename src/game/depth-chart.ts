// Charts of depth windows (M11 T11, T18): the relief chart (`map-relief.ts`) of a depth window
// around the player rather than of the whole world, which at 262,144 wu would put the minimap's
// disc inside one texel. The minimap's small chart is built at once whenever its window has
// re-centred and its new cells are in. The map's larger one is spread over frames: the window
// samples at its budget, then `ChartJob` builds the picture a slice a frame, and until it is done
// the last picture stays drawn where it belongs. `DepthChart` is pure; `ChartCanvas` draws it.

import { DepthWindow } from '../render/depth-window';
import { wrapTo } from '../render/origin';
import { clamp } from '../sim/math';
import type { Seed } from '../sim/prng';
import { ChartJob, MAP_SMOOTH_RADIUS } from './map-relief';

/**
 * The minimap's window in view half-heights: twice the minimap's 12 across, since the window
 * re-centres only once the player is a quarter of its side from its centre and the disc must
 * stay inside it.
 */
export const CHART_VIEWS = 24;
/**
 * The minimap's texels per side: the disc shows half of them across, at least one to every two
 * CSS pixels, and charting 128 × 128 (smoothing, relief and colour) takes a few milliseconds.
 */
export const CHART_TEXELS = 128;
/**
 * The map's texels per side. Its window is twice the map's square across (the square stays inside
 * it until it re-centres), so the square shows 128 texels: 64 wu each on a starter's 8,192 wu.
 */
export const MAP_TEXELS = 256;
/** The map's build work a frame (`ChartJob` units): three blur passes, or 48 rows of relief and colour. */
export const MAP_BUILD_BUDGET = 3 * MAP_TEXELS * MAP_TEXELS;
/** The map's blur in wu, about the whole-world map's (its radius in texels follows the texel). */
export const MAP_SMOOTH_WU = 190;

/** A chart's picture and the square of world it covers: south-west corner, side and texel in wu. */
export interface ChartPicture {
  /** RGBA, north row first; texels beyond the world are clear. */
  pixels: Uint8ClampedArray<ArrayBuffer>;
  n: number;
  x: number;
  y: number;
  side: number;
  cell: number;
}

export interface ChartOptions {
  /** Build work a frame; unbounded (the default) builds at once and settles a jump at once. */
  budget?: number;
  /** The blur in wu, rounded to whole texels; by default `MAP_SMOOTH_RADIUS` texels. */
  smoothWu?: number;
}

/** Where the picture under construction lies. */
interface Pending {
  size: number;
  x: number;
  y: number;
  cell: number;
}

export class DepthChart {
  private readonly window: DepthWindow;
  private readonly grid: Uint8Array;
  private readonly job: ChartJob;
  private readonly budget: number;
  private readonly smoothWu: number | null;
  /** The window version the last picture (or the one being built) was taken from. */
  private version = -1;
  private building: Pending | null = null;
  picture: ChartPicture | null = null;
  /** The most build work one update has done (tests). */
  worst = 0;

  constructor(views: number, texels: number, options: ChartOptions = {}) {
    this.window = new DepthWindow(views, texels);
    this.grid = new Uint8Array(texels * texels);
    this.job = new ChartJob(texels);
    this.budget = options.budget ?? Number.POSITIVE_INFINITY;
    this.smoothWu = options.smoothWu ?? null;
  }

  /** Whether the picture is up to date: nothing left to sample or build. */
  get idle(): boolean {
    const w = this.window;
    return this.building === null && w.ready && w.pending() === 0 && w.version === this.version;
  }

  /**
   * Follows the player in a world, wanting a window of at least `views` × `halfHeight` wu, and does
   * a frame's work. Returns whether a new picture is up.
   */
  update(seed: Seed, size: number, x: number, y: number, halfHeight: number): boolean {
    const w = this.window;
    const atOnce = this.budget === Number.POSITIVE_INFINITY;
    if (!this.building) {
      const s = this.picture;
      const off = !s || x < s.x || y < s.y || x > s.x + s.side || y > s.y + s.side;
      // At once, a new world or a jump off the picture is charted on the first draw.
      if (atOnce && (w.seed !== seed || w.size !== size || off))
        w.settle(seed, size, x, y, halfHeight);
      else w.update(seed, size, x, y, halfHeight);
      if (w.version === this.version || w.pending() > 0) return false;
      this.begin(size);
      // A budgeted chart starts building on the next frame, so no frame both samples and builds.
      if (!atOnce) return false;
    }
    const used = this.job.step(this.budget);
    this.worst = Math.max(this.worst, used);
    if (!this.job.done) return false;
    this.finish();
    return true;
  }

  /** Unrolls the window (south first, as `ChartJob` takes it) and starts its picture. */
  private begin(size: number): void {
    const w = this.window;
    const n = w.texels;
    const { data, i0, j0, cell } = w;
    // Each torus row in two runs: from the window's first column to the row's end, then the rest.
    const cut = n - wrapTo(i0, n);
    for (let j = 0; j < n; j++) {
      const row = wrapTo(j0 + j, n) * n;
      const first = row + n - cut;
      this.grid.set(data.subarray(first, row + n), j * n);
      this.grid.set(data.subarray(row, first), j * n + cut);
    }
    const radius =
      this.smoothWu === null
        ? MAP_SMOOTH_RADIUS
        : clamp(Math.round(this.smoothWu / cell), 1, MAP_SMOOTH_RADIUS);
    this.job.start(this.grid, radius);
    this.version = w.version;
    this.building = { size, x: i0 * cell, y: j0 * cell, cell };
  }

  /** Clears the cells beyond the world and shows the picture. */
  private finish(): void {
    const b = this.building as Pending;
    this.building = null;
    const n = this.job.n;
    const pixels = this.picture?.pixels ?? new Uint8ClampedArray(new ArrayBuffer(n * n * 4));
    pixels.set(this.job.pixels);
    for (let j = 0; j < n; j++) {
      const cy = b.y + (j + 0.5) * b.cell;
      for (let i = 0; i < n; i++) {
        const cx = b.x + (i + 0.5) * b.cell;
        // Picture rows run north first.
        if (cx < 0 || cy < 0 || cx > b.size || cy > b.size)
          pixels[((n - 1 - j) * n + i) * 4 + 3] = 0;
      }
    }
    this.picture = { pixels, n, x: b.x, y: b.y, side: n * b.cell, cell: b.cell };
  }
}

/** The minimap's chart: a small window, charted at once. */
export function minimapChart(): DepthChart {
  return new DepthChart(CHART_VIEWS, CHART_TEXELS);
}

/** The map's chart: a window twice its square across (its `halfHeight` is the square's side), built over frames. */
export function mapChart(): DepthChart {
  return new DepthChart(2, MAP_TEXELS, { budget: MAP_BUILD_BUDGET, smoothWu: MAP_SMOOTH_WU });
}

/** A chart's picture on a canvas, and the square of world it covers. */
export interface ChartImage {
  image: HTMLCanvasElement;
  x: number;
  y: number;
  side: number;
  /** wu per texel. */
  cell: number;
}

/** Draws a chart's pictures onto a canvas of its own as they come up. */
export class ChartCanvas {
  private canvas: HTMLCanvasElement | null = null;
  private shown: ChartImage | null = null;

  constructor(private readonly chart: DepthChart) {}

  /** As `DepthChart.update`; returns the picture to draw, if any. */
  update(seed: Seed, size: number, x: number, y: number, halfHeight: number): ChartImage | null {
    if (!this.chart.update(seed, size, x, y, halfHeight)) return this.shown;
    const pic = this.chart.picture as ChartPicture;
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = pic.n;
      this.canvas.height = pic.n;
    }
    this.canvas.getContext('2d')?.putImageData(new ImageData(pic.pixels, pic.n, pic.n), 0, 0);
    this.shown = { image: this.canvas, x: pic.x, y: pic.y, side: pic.side, cell: pic.cell };
    return this.shown;
  }
}

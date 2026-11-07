// The minimap's chart (M11 T11): the relief chart of the pond map (`mapPixels`), drawn from a depth
// window around the player instead of the whole world, which at 262,144 wu would put the minimap's
// whole disc inside one texel. The picture is rebuilt each time the window has re-centred and its
// new cells are in; until then the last picture stays drawn where it belongs.

import { DepthWindow } from '../render/depth-window';
import type { Seed } from '../sim/prng';
import { mapPixels } from './pond-map';

/**
 * The chart's window in view half-heights: twice the minimap's 12 across, since the window
 * re-centres only once the player is a quarter of its side from its centre and the disc must
 * stay inside it.
 */
export const CHART_VIEWS = 24;
/**
 * Texels per side: the disc shows half of them across, at least one to every two CSS pixels, and
 * charting 128 × 128 (smoothing, relief and colour) takes a few milliseconds where 256 × 256 takes
 * about 15.
 */
export const CHART_TEXELS = 128;

/** The chart's picture and the square of world it covers, south-west corner and side in wu. */
export interface ChartImage {
  image: HTMLCanvasElement;
  x: number;
  y: number;
  side: number;
  /** wu per texel. */
  cell: number;
}

export class MinimapChart {
  private readonly window = new DepthWindow(CHART_VIEWS, CHART_TEXELS);
  private readonly grid: Uint8Array;
  private canvas: HTMLCanvasElement | null = null;
  private version = -1;
  private shown: ChartImage | null = null;

  constructor() {
    this.grid = new Uint8Array(this.window.texels * this.window.texels);
  }

  /** Follows the player in a world, seen at `halfHeight` wu; returns the picture to draw, if any. */
  update(seed: Seed, size: number, x: number, y: number, halfHeight: number): ChartImage | null {
    const w = this.window;
    // A new world or a jump off the picture: the chart is there on the first draw rather than 16
    // draws later.
    const s = this.shown;
    const off = !s || x < s.x || y < s.y || x > s.x + s.side || y > s.y + s.side;
    if (w.seed !== seed || w.size !== size || off) w.settle(seed, size, x, y, halfHeight);
    else w.update(seed, size, x, y, halfHeight);
    if (w.version !== this.version && w.pending() === 0) {
      this.version = w.version;
      this.shown = this.build(size);
    }
    return this.shown;
  }

  /** The window unrolled (south first, as `mapPixels` takes it) and charted; cells beyond the world are left clear. */
  private build(size: number): ChartImage {
    const w = this.window;
    const n = w.texels;
    const { data, i0, j0, cell } = w;
    for (let j = 0; j < n; j++) {
      const row = (((j0 + j) % n) + n) % n;
      for (let i = 0; i < n; i++) {
        this.grid[j * n + i] = data[row * n + ((((i0 + i) % n) + n) % n)] as number;
      }
    }
    const pixels = mapPixels(this.grid, n);
    for (let j = 0; j < n; j++) {
      const cy = (j0 + j + 0.5) * cell;
      for (let i = 0; i < n; i++) {
        const cx = (i0 + i + 0.5) * cell;
        // Picture rows run north first.
        if (cx < 0 || cy < 0 || cx > size || cy > size) pixels[((n - 1 - j) * n + i) * 4 + 3] = 0;
      }
    }
    if (!this.canvas) {
      this.canvas = document.createElement('canvas');
      this.canvas.width = n;
      this.canvas.height = n;
    }
    this.canvas.getContext('2d')?.putImageData(new ImageData(pixels, n, n), 0, 0);
    return { image: this.canvas, x: i0 * cell, y: j0 * cell, side: n * cell, cell };
  }
}

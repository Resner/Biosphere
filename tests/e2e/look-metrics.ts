import type { Page } from '@playwright/test';
import type { Disc } from '../../src/lab/gallery-page';
import type { Rect } from '../../src/lab/grid';

// Screenshot measures of the look (M6b, ADR 0034), shared by the look specs and the look pass. All
// are pure over decoded RGBA (0-255) and CSS-pixel geometry from `window.__gallery`.

export interface Image {
  width: number;
  height: number;
  rgba: Uint8Array | Uint8ClampedArray;
}

type Point = { x: number; y: number };

/** A PNG decoded by the browser into RGBA. */
export async function decodePng(page: Page, png: Buffer): Promise<Image> {
  const { width, height, base64 } = await page.evaluate(async (data) => {
    const image = new window.Image();
    image.src = `data:image/png;base64,${data}`;
    await image.decode();
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    const g = c.getContext('2d');
    if (!g) throw new Error('2D canvas unavailable');
    g.drawImage(image, 0, 0);
    const rgba = g.getImageData(0, 0, image.width, image.height).data;
    let text = '';
    for (let i = 0; i < rgba.length; i += 0x8000) {
      text += String.fromCharCode(...rgba.subarray(i, i + 0x8000));
    }
    return { width: image.width, height: image.height, base64: btoa(text) };
  }, png.toString('base64'));
  return { width, height, rgba: new Uint8Array(Buffer.from(base64, 'base64')) };
}

/** Pixels with min(R, G, B) ≥ 245 whose eight neighbours are too (ADR 0034). */
export function solidWhite(
  rgba: Uint8ClampedArray | Uint8Array,
  width: number,
  rect: Rect,
): number {
  const height = Math.floor(rgba.length / 4 / width);
  const white = (x: number, y: number): boolean => {
    if (x < 0 || y < 0 || x >= width || y >= height) return false;
    const i = (y * width + x) * 4;
    return Math.min(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number) >= 245;
  };
  let n = 0;
  for (let y = Math.ceil(rect.y); y < Math.floor(rect.y + rect.h); y++) {
    for (let x = Math.ceil(rect.x); x < Math.floor(rect.x + rect.w); x++) {
      let all = true;
      for (let dy = -1; dy <= 1 && all; dy++) {
        for (let dx = -1; dx <= 1 && all; dx++) all = white(x + dx, y + dy);
      }
      if (all) n++;
    }
  }
  return n;
}

/**
 * Inside a polygon by the nonzero winding rule: a curled outline whose loft overlaps itself still
 * counts the overlap as inside.
 */
export function insidePolygon(points: readonly Point[], x: number, y: number): boolean {
  let winding = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = [points[j] as Point, points[i] as Point];
    const side = (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y);
    if (a.y <= y && b.y > y && side > 0) winding++;
    else if (a.y > y && b.y <= y && side < 0) winding--;
  }
  return winding !== 0;
}

/** The distance from `(x, y)` to the polygon's nearest edge. */
export function edgeDistance(points: readonly Point[], x: number, y: number): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [a, b] = [points[j] as Point, points[i] as Point];
    const [dx, dy] = [b.x - a.x, b.y - a.y];
    const t = Math.max(
      0,
      Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / (dx * dx + dy * dy || 1)),
    );
    best = Math.min(best, Math.hypot(x - a.x - t * dx, y - a.y - t * dy));
  }
  return best;
}

const luminance = (rgba: Image['rgba'], i: number): number =>
  0.2126 * (rgba[i] as number) +
  0.7152 * (rgba[i + 1] as number) +
  0.0722 * (rgba[i + 2] as number);

const median = (values: number[]): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
};

/** Pixel chroma (max − min over 255) at or above which a pixel counts as coloured. */
export const CHROMA = 0.15;
/** Coloured pixels belong to an organ within this many of its radii from its centre. */
export const ORGAN_REACH = 1.3;
/** Shell pixels lie more than this many pixels inside the outline. */
export const SHELL_INSET = 3;

export interface BodyLook {
  /** Coloured pixels inside the outline, and the share of them near an organ (1 when there are none). */
  coloured: number;
  inOrgans: number;
  /** Shell-only pixels, their median luminance (0-255) and the water's around the body. */
  shell: number;
  shellLuma: number;
  water: number;
  /** `shellLuma − water`: how far the shell stands above the water. */
  excess: number;
}

/**
 * The two look measures of one body (M6b T3): how much of the colour inside the outline stays near
 * an organ, and how bright the shell between the organs stands above the water. `centre` and
 * `radius` place the body (its core, CSS pixels); the water is the cell's median beyond 2.6 radii.
 */
export function bodyLook(
  image: Image,
  cell: Rect,
  centre: Point,
  radius: number,
  body: { organs: readonly Disc[]; outline: readonly Point[] },
): BodyLook {
  const { width, rgba } = image;
  const water: number[] = [];
  const shell: number[] = [];
  let coloured = 0;
  let near = 0;
  const nearOrgan = (x: number, y: number): boolean =>
    body.organs.some((o) => Math.hypot(x - o.x, y - o.y) <= o.r * ORGAN_REACH);
  for (let y = Math.ceil(cell.y); y < Math.floor(cell.y + cell.h); y++) {
    for (let x = Math.ceil(cell.x); x < Math.floor(cell.x + cell.w); x++) {
      const i = (y * width + x) * 4;
      const [px, py] = [x + 0.5, y + 0.5];
      if (Math.hypot(px - centre.x, py - centre.y) > 2.6 * radius) {
        water.push(luminance(rgba, i));
        continue;
      }
      if (!insidePolygon(body.outline, px, py)) continue;
      const [r, g, b] = [rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number];
      const organ = nearOrgan(px, py);
      if ((Math.max(r, g, b) - Math.min(r, g, b)) / 255 >= CHROMA) {
        coloured++;
        if (organ) near++;
      }
      if (!organ && edgeDistance(body.outline, px, py) > SHELL_INSET)
        shell.push(luminance(rgba, i));
    }
  }
  const [shellLuma, waterLuma] = [median(shell), median(water)];
  return {
    coloured,
    inOrgans: coloured === 0 ? 1 : near / coloured,
    shell: shell.length,
    shellLuma,
    water: waterLuma,
    excess: shellLuma - waterLuma,
  };
}

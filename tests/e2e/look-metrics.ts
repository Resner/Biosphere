import type { Page } from '@playwright/test';
import type { CellMasks } from '../../src/lab/gallery-masks';
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

export const median = (values: number[]): number => {
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

/** A `CellMasks` bitset (`src/lab/gallery-masks.ts`) as one byte (0 or 1) per pixel of its room. */
export function maskBits(mask: string, length: number): Uint8Array {
  const bytes = Buffer.from(mask, 'base64');
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) out[i] = ((bytes[i >> 3] as number) >> (i & 7)) & 1;
  return out;
}

const mean = (values: number[]): number =>
  values.length === 0 ? Number.NaN : values.reduce((a, b) => a + b, 0) / values.length;

const percentile = (values: number[], p: number): number => {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] as number;
};

/** A pixel is grey enough to be glass rather than an organ's colour (chroma under `CHROMA`). */
const grey = (rgba: Image['rgba'], i: number): boolean =>
  Math.max(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number) -
    Math.min(rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number) <
  CHROMA * 255;

/** The body's rim is read at this percentile of its band: the bright line, not the pixels inside it. */
export const RIM_PEAK = 0.9;
/** A dark patch is read at this percentile: the darkest tenth of a region. */
export const DARK = 0.1;

export interface GlassLook {
  /** Pixels in each region. */
  counts: { face: number; rim: number; limbs: number; mouth: number };
  /** The face's mean luminance (0-255) over its grey pixels, and its darkest tenth (`DARK`). */
  face: number;
  faceDark: number;
  /** The mean over the face's grey pixels clear of organ light (the `clear` mask, M6c T7). */
  clear: number;
  /** The rim band's peak (`RIM_PEAK`). */
  rim: number;
  /** The limbs' median. */
  limbs: number;
  /** The mouth's mean and its darkest tenth. */
  mouth: number;
  mouthDark: number;
}

/**
 * The glass measures of one cell (M6c T6, ADR 0043), read by region from the gallery hook's masks:
 * the face (its grey pixels, so an organ's colour spilling into it does not count), the rim's peak,
 * the limbs' median and the mouth. `map` places a mask pixel `(x, y)` (sheet pixels) on `image`, for
 * reading the same regions on another sheet (pass 1's layout); by default the same pixel.
 */
export function glassLook(
  image: Image,
  masks: CellMasks,
  map: (x: number, y: number) => Point = (x, y) => ({ x, y }),
): GlassLook {
  const n = masks.w * masks.h;
  const read = (mask: string, keep: (i: number) => boolean = () => true): number[] => {
    const bits = maskBits(mask, n);
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      if (!bits[k]) continue;
      const p = map(masks.x + (k % masks.w), masks.y + Math.floor(k / masks.w));
      const [x, y] = [Math.round(p.x), Math.round(p.y)];
      if (x < 0 || y < 0 || x >= image.width || y >= image.height) continue;
      const i = (y * image.width + x) * 4;
      if (keep(i)) out.push(luminance(image.rgba, i));
    }
    return out;
  };
  const face = read(masks.face, (i) => grey(image.rgba, i));
  const clear = read(masks.clear, (i) => grey(image.rgba, i));
  const rim = read(masks.rim);
  const limbs = read(masks.limbs);
  const mouth = read(masks.mouth);
  return {
    counts: { face: face.length, rim: rim.length, limbs: limbs.length, mouth: mouth.length },
    face: mean(face),
    faceDark: percentile(face, DARK),
    clear: mean(clear),
    rim: percentile(rim, RIM_PEAK),
    limbs: median(limbs),
    mouth: mean(mouth),
    mouthDark: percentile(mouth, DARK),
  };
}

/** The HSV hue (turns) and chroma (0-1) of the pixel at byte `i`. */
export function hueAt(rgba: Image['rgba'], i: number): { hue: number; chroma: number } {
  const [r, g, b] = [rgba[i] as number, rgba[i + 1] as number, rgba[i + 2] as number];
  const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
  const d = max - min;
  if (d === 0) return { hue: 0, chroma: 0 };
  const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
  return { hue: (((h / 6) % 1) + 1) % 1, chroma: d / 255 };
}

/** The short way round the wheel between two hues (turns, 0–0.5). */
export const hueArc = (a: number, b: number): number => {
  const d = Math.abs(a - b) % 1;
  return Math.min(d, 1 - d);
};

/** The circular mean of hues (turns). */
export function meanHue(hues: readonly number[]): number {
  let [x, y] = [0, 0];
  for (const h of hues) [x, y] = [x + Math.cos(2 * Math.PI * h), y + Math.sin(2 * Math.PI * h)];
  return (((Math.atan2(y, x) / (2 * Math.PI)) % 1) + 1) % 1;
}

export interface HueClusters {
  /** The two cluster centres (turns), and the arc between them. */
  centres: [number, number];
  spread: number;
  /** The share of the hues more than `HUE_FIT` from both centres: a third colour. */
  outside: number;
}

/** A hue belongs to a cluster within this arc of its centre. */
export const HUE_FIT = 0.05;

/**
 * Two-means on the hue circle (M6c T7): the centres start at the mean hue and the hue farthest from
 * it, and settle in a few rounds. One hue alone gives two equal centres.
 */
export function hueClusters(hues: readonly number[]): HueClusters {
  if (hues.length === 0) return { centres: [0, 0], spread: 0, outside: 0 };
  const first = meanHue(hues);
  // The second seed: the hue farthest from the mean.
  let far = first;
  for (const h of hues) if (hueArc(h, first) > hueArc(far, first)) far = h;
  let centres: [number, number] = [first, far];
  for (let round = 0; round < 12; round++) {
    const groups: [number[], number[]] = [[], []];
    for (const h of hues) groups[hueArc(h, centres[0]) <= hueArc(h, centres[1]) ? 0 : 1].push(h);
    centres = [
      groups[0].length ? meanHue(groups[0]) : centres[0],
      groups[1].length ? meanHue(groups[1]) : centres[1],
    ];
  }
  const outside =
    hues.filter((h) => Math.min(hueArc(h, centres[0]), hueArc(h, centres[1])) > HUE_FIT).length /
    hues.length;
  return { centres, spread: hueArc(centres[0], centres[1]), outside };
}

export interface OrganLook {
  /** The hues of the coloured (`CHROMA`) organ pixels, and those of the main tone and the irises. */
  organs: number[];
  main: number[];
  iris: number[];
}

/** The organ and iris hues of one cell (M6c T7), read by region from the gallery hook's masks. */
export function organLook(image: Image, masks: CellMasks): OrganLook {
  const n = masks.w * masks.h;
  const read = (mask: string): number[] => {
    const bits = maskBits(mask, n);
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      if (!bits[k]) continue;
      const [x, y] = [masks.x + (k % masks.w), masks.y + Math.floor(k / masks.w)];
      const { hue, chroma } = hueAt(image.rgba, (y * image.width + x) * 4);
      if (chroma >= CHROMA) out.push(hue);
    }
    return out;
  };
  return { organs: read(masks.organs), main: read(masks.main), iris: read(masks.iris) };
}

/**
 * The pixels of a cell's room that `lit` shows brighter than `unlit` by at least `rise` luminance
 * levels (0-255), and how many of them lie farther than `reach` pixels from `region`'s mask.
 */
export function brighterOutside(
  lit: Image,
  unlit: Image,
  masks: CellMasks,
  region: string,
  rise: number,
  reach: number,
): { brighter: number; outside: number } {
  const n = masks.w * masks.h;
  const bits = maskBits(region, n);
  const near = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    if (!bits[k]) continue;
    const [x, y] = [k % masks.w, Math.floor(k / masks.w)];
    for (let dy = -reach; dy <= reach; dy++) {
      for (let dx = -reach; dx <= reach; dx++) {
        const [u, v] = [x + dx, y + dy];
        if (u >= 0 && v >= 0 && u < masks.w && v < masks.h && dx * dx + dy * dy <= reach * reach)
          near[v * masks.w + u] = 1;
      }
    }
  }
  let [brighter, outside] = [0, 0];
  for (let k = 0; k < n; k++) {
    const [x, y] = [masks.x + (k % masks.w), masks.y + Math.floor(k / masks.w)];
    const i = (y * lit.width + x) * 4;
    if (luminance(lit.rgba, i) - luminance(unlit.rgba, i) < rise) continue;
    brighter++;
    if (!near[k]) outside++;
  }
  return { brighter, outside };
}

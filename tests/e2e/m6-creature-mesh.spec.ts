import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import type { BodyPlan, Point } from '../../src/genome/develop';
import { buildCreature } from '../../src/genome/stats';
import { galleryCell, galleryGrid, LABEL_HEIGHT, parseSpecimen } from '../../src/lab/gallery';
import { anatomyOf } from '../../src/render/anatomy';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import { hatch, openGame } from './helpers';

// Creature mesh v2 (M6 T10), judged on decoded screenshots of the gallery sheet (1600×1000, high
// preset): long parts reach past the body, setae read as separate hair-thin strokes, membranes are
// drawn over their whole sheet, and the player's body at default zoom keeps the medium budget and
// a rim well above the water.

test.use({ storageState: { cookies: [], origins: [] } });

const DIR = new URL('../fixtures/gallery/', import.meta.url);
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.hex'))
  .sort();
const specimen = (prefix: string) => {
  const index = FILES.findIndex((f) => f.startsWith(prefix));
  const file = FILES[index] as string;
  const parsed = parseSpecimen(file, readFileSync(new URL(file, DIR), 'utf8'));
  if (!parsed) throw new Error(`no specimen ${prefix}`);
  return { index, genome: parsed.genome, plan: buildCreature(parsed.genome).plan };
};

interface Luma {
  width: number;
  height: number;
  at(x: number, y: number): number;
  /** The pixel's colour, 0-255 per channel (black outside the image). */
  rgb(x: number, y: number): [number, number, number];
}

/** A PNG's luminance (0-255 per pixel) and colour, decoded by the browser. */
async function lumaOf(page: Page, png: Buffer): Promise<Luma> {
  const { width, height, base64 } = await page.evaluate(async (data) => {
    const image = new Image();
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
  const rgba = Buffer.from(base64, 'base64');
  const index = (x: number, y: number): number => {
    const [i, j] = [Math.round(x), Math.round(y)];
    return i < 0 || j < 0 || i >= width || j >= height ? -1 : (j * width + i) * 4;
  };
  const rgb = (x: number, y: number): [number, number, number] => {
    const k = index(x, y);
    return k < 0 ? [0, 0, 0] : [rgba[k] as number, rgba[k + 1] as number, rgba[k + 2] as number];
  };
  return {
    width,
    height,
    rgb,
    at: (x, y) => {
      const [r, g, b] = rgb(x, y);
      return Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
    },
  };
}

const median = (values: number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[sorted.length >> 1] as number;
};

/** A specimen's place on the sheet: its core's centre in pixels, one core radius in pixels, its cell. */
function placeOf(index: number, state: { radius: number }) {
  const grid = galleryGrid(FILES.length, GALLERY_VIEWPORT.width, GALLERY_VIEWPORT.height);
  const cell = galleryCell(index, grid);
  return {
    cell,
    x: cell.x + cell.w / 2,
    y: cell.y + (cell.h - LABEL_HEIGHT) / 2,
    r: state.radius,
  };
}

/** The water's luminance in a cell: the median beyond 2.6 core radii from the specimen. */
function waterIn(luma: Luma, place: ReturnType<typeof placeOf>): number {
  const values: number[] = [];
  const { cell } = place;
  for (let y = cell.y + 2; y < cell.y + cell.h - LABEL_HEIGHT - 2; y += 2) {
    for (let x = cell.x + 2; x < cell.x + cell.w - 2; x += 2) {
      if (Math.hypot(x - place.x, y - place.y) > 2.6 * place.r) values.push(luma.at(x, y));
    }
  }
  return median(values);
}

/**
 * How many of eight 45° directions hold bright pixels clearly past the body: outside its outline
 * (segments, carapace and eyes) grown by 30%. Karyotype v2 heads in front of a chain are drawn
 * smaller than the core (M6 T14b), so a fixed radius from the core would no longer mean "past the
 * body".
 */
function directionsReached(
  luma: Luma,
  place: ReturnType<typeof placeOf>,
  bright: number,
  plan: BodyPlan,
): number {
  const counts = new Array<number>(8).fill(0);
  const reach = 2.6 * place.r;
  for (let y = Math.floor(place.y - reach); y <= place.y + reach; y++) {
    for (let x = Math.floor(place.x - reach); x <= place.x + reach; x++) {
      const d = Math.hypot(x - place.x, y - place.y);
      if (d > reach || luma.at(x, y) < bright) continue;
      if (withinBody(plan, (x - place.x) / place.r, (place.y - y) / place.r, 1.3)) continue;
      const sector = Math.floor(
        ((Math.atan2(place.y - y, x - place.x) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4),
      );
      counts[sector % 8] = (counts[sector % 8] as number) + 1;
    }
  }
  return counts.filter((n) => n >= 4).length;
}

/** Inside the body's segments, carapace or eyes, each grown to `scale` about its centre. */
function withinBody(plan: BodyPlan, x: number, y: number, scale: number): boolean {
  const c = plan.carapace;
  const shells = c.count > 0 ? [...plan.segments, c] : plan.segments;
  const inEllipse = shells.some((s) => {
    const [dx, dy] = [x - s.x, y - s.y];
    const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / (s.rx * scale);
    const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / (s.ry * scale);
    return u * u + v * v <= 1;
  });
  const e = plan.eyes;
  const inEye =
    e.count > 0 && [1, -1].some((side) => Math.hypot(x - e.x, y - side * e.y) <= e.size * scale);
  return inEllipse || inEye;
}

/**
 * The most separate thin bright strokes crossing one circle round the core, outside the body. A
 * stroke starts above `bright` and ends below `dark` (so grain and glow never split one), and
 * counts when it is at most `thin` pixels wide and does not touch the body (with a 2 px margin).
 */
function strokes(
  luma: Luma,
  place: ReturnType<typeof placeOf>,
  plan: BodyPlan,
  levels: { bright: number; dark: number },
  thin: number,
): number {
  let best = 0;
  for (let k = 0; k <= 16; k++) {
    const radius = place.r * (1.05 + 0.05 * k);
    const samples = Math.ceil(2 * Math.PI * radius * 2);
    const at = Array.from({ length: samples }, (_, i) => {
      const a = (2 * Math.PI * i) / samples;
      const [c, n] = [Math.cos(a), Math.sin(a)];
      const near = (radius - 2) / place.r;
      if (insideBody(plan, c * near, n * near)) return null;
      return luma.at(place.x + radius * c, place.y - radius * n);
    });
    const start = at.findIndex((v) => v !== null && v < levels.dark);
    if (start < 0) continue;
    let count = 0;
    let run = 0;
    let on = false;
    for (let i = 1; i <= samples; i++) {
      const v = at[(start + i) % samples] ?? null;
      if (v === null) {
        [on, run] = [false, 0];
        continue;
      }
      if (!on && v >= levels.bright) [on, run] = [true, 0];
      if (on && v < levels.dark) {
        if (run / 2 <= thin) count++;
        on = false;
      }
      if (on) run++;
    }
    best = Math.max(best, count);
  }
  return best;
}

const insidePolygon = (points: readonly Point[], x: number, y: number): boolean =>
  points.every((a, i) => {
    const b = points[(i + 1) % points.length] as Point;
    return (b.x - a.x) * (y - a.y) - (b.y - a.y) * (x - a.x) >= 0;
  });

const insideBody = (plan: BodyPlan, x: number, y: number): boolean =>
  plan.segments.some((s) => {
    const [dx, dy] = [x - s.x, y - s.y];
    const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / s.rx;
    const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / s.ry;
    return u * u + v * v <= 1;
  });

/** Inside the body with every segment ellipse shrunk to `scale` about its centre. */
const insideScaled = (plan: BodyPlan, x: number, y: number, scale: number): boolean =>
  plan.segments.some((s) => {
    const [dx, dy] = [x - s.x, y - s.y];
    const u = (dx * Math.cos(s.angle) + dy * Math.sin(s.angle)) / (s.rx * scale);
    const v = (-dx * Math.sin(s.angle) + dy * Math.cos(s.angle)) / (s.ry * scale);
    return u * u + v * v <= 1;
  });

/**
 * The hue variance of a set of pixels: the spread of their chroma vectors (chroma, max − min, along
 * the hue angle), so grey and dark pixels, whose hue means nothing, count as no colour rather than
 * as noise.
 */
function hueVariance(pixels: readonly [number, number, number][]): number {
  const chroma = pixels.map(([r, g, b]) => {
    const [max, min] = [Math.max(r, g, b), Math.min(r, g, b)];
    const s = (max - min) / 255;
    const d = max - min || 1;
    const h = max === r ? (g - b) / d : max === g ? 2 + (b - r) / d : 4 + (r - g) / d;
    const a = (Math.PI / 3) * h;
    return [s * Math.cos(a), s * Math.sin(a)] as const;
  });
  const n = chroma.length || 1;
  const [mx, my] = chroma.reduce(([x, y], [cx, cy]) => [x + cx / n, y + cy / n], [0, 0]);
  return chroma.reduce((v, [cx, cy]) => v + ((cx - mx) ** 2 + (cy - my) ** 2) / n, 0);
}

/** The inside is the hull shrunk to this; the rim band lies between `RIM` and the hull. */
const INNER = 0.8;
const RIM = 0.88;

/** A specimen's pixels, by where they lie: deep inside the hull, or in the shell's rim band. */
function bodyPixels(place: ReturnType<typeof placeOf>, plan: BodyPlan) {
  const inside: { x: number; y: number }[] = [];
  const rim: { x: number; y: number }[] = [];
  const reach = 2.6 * place.r;
  for (let py = Math.floor(place.y - reach); py <= place.y + reach; py++) {
    for (let px = Math.floor(place.x - reach); px <= place.x + reach; px++) {
      const [x, y] = [(px - place.x) / place.r, (place.y - py) / place.r];
      if (insideScaled(plan, x, y, INNER)) inside.push({ x: px, y: py });
      else if (insideScaled(plan, x, y, 1) && !insideScaled(plan, x, y, RIM)) {
        rim.push({ x: px, y: py });
      }
    }
  }
  return { inside, rim };
}

/** Separate bright blobs among `pixels`: 4-connected groups of at least `least` pixels above `bright`. */
function blobs(
  luma: Luma,
  pixels: readonly { x: number; y: number }[],
  bright: number,
  least: number,
): number {
  const lit = new Set(
    pixels.filter((p) => luma.at(p.x, p.y) >= bright).map((p) => `${p.x},${p.y}`),
  );
  let count = 0;
  for (const start of lit) {
    lit.delete(start);
    let size = 0;
    const stack = [start];
    while (stack.length > 0) {
      const [x, y] = (stack.pop() as string).split(',').map(Number) as [number, number];
      size++;
      for (const key of [`${x + 1},${y}`, `${x - 1},${y}`, `${x},${y + 1}`, `${x},${y - 1}`]) {
        if (lit.delete(key)) stack.push(key);
      }
    }
    if (size >= least) count++;
  }
  return count;
}

test.describe('the gallery sheet', () => {
  test.use({ viewport: GALLERY_VIEWPORT, deviceScaleFactor: 1 });

  let luma: Luma;
  let radius: number;

  test.beforeAll(async ({ browser, baseURL }) => {
    const context = await browser.newContext({
      viewport: GALLERY_VIEWPORT,
      deviceScaleFactor: 1,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const png = await captureGallery(page, baseURL as string);
    const state = await page.evaluate(() => window.__gallery?.state());
    if (!state) throw new Error('no gallery');
    radius = state.radius;
    luma = await lumaOf(page, png);
    await context.close();
  });

  // The T9 copepod has no antennae (its parts all sit on its rear segments), so the spiny larva's
  // spines stand in for long parts reaching round the body.
  test("the crab's legs and the spiny larva's spines reach past the body in six directions", () => {
    const reached: Record<string, number> = {};
    for (const prefix of ['30-specimen-crab', '23-specimen-spiny-larva', '01-genesis']) {
      const s = specimen(prefix);
      const place = placeOf(s.index, { radius });
      reached[prefix] = directionsReached(luma, place, waterIn(luma, place) + 40, s.plan);
    }
    console.log('directions reached past the body:', reached);
    expect(reached['30-specimen-crab']).toBeGreaterThanOrEqual(6);
    expect(reached['23-specimen-spiny-larva']).toBeGreaterThanOrEqual(6);
    // The measure means something: a plain genesis cell with two short flagella does not reach round.
    expect(reached['01-genesis']).toBeLessThan(6);
  });

  test('setae show as at least 20 separate thin bright strokes on the setose specimen', () => {
    const shrimp = specimen('27-specimen-shrimp');
    expect(shrimp.plan.appendages.reduce((n, a) => n + a.setae, 0)).toBeGreaterThanOrEqual(40);
    const place = placeOf(shrimp.index, { radius });
    const water = waterIn(luma, place);
    const count = strokes(luma, place, shrimp.plan, { bright: water + 30, dark: water + 12 }, 4);
    const bare = specimen('01-genesis');
    const barePlace = placeOf(bare.index, { radius });
    const bareWater = waterIn(luma, barePlace);
    const control = strokes(
      luma,
      barePlace,
      bare.plan,
      { bright: bareWater + 30, dark: bareWater + 12 },
      4,
    );
    console.log(`setae strokes: shrimp ${count}, bare cell ${control}`);
    expect(count).toBeGreaterThanOrEqual(20);
    expect(control).toBeLessThan(20);
  });

  test("the winged specimen's membranes are drawn over their whole sheet", () => {
    const winged = specimen('31-specimen-winged');
    const { plan } = winged;
    const place = placeOf(winged.index, { radius });
    const lit = waterIn(luma, place) + 8;
    // Pixels inside a membrane polygon and outside the body, a pixel in from every edge.
    let inside = 0;
    let shown = 0;
    let sheetArea = 0;
    const bodyArea = { n: 0 };
    for (let py = place.y - 2.6 * place.r; py <= place.y + 2.6 * place.r; py++) {
      for (let px = place.x - 2.6 * place.r; px <= place.x + 2.6 * place.r; px++) {
        const [x, y] = [(px - place.x) / place.r, (place.y - py) / place.r];
        const body = insideBody(plan, x, y);
        if (body) bodyArea.n++;
        const inSheet = (dx: number, dy: number) =>
          plan.membranes.some((m) => insidePolygon(m.points, x + dx / place.r, y + dy / place.r));
        if (!inSheet(0, 0)) continue;
        sheetArea++;
        if (body || !inSheet(1.5, 0) || !inSheet(-1.5, 0) || !inSheet(0, 1.5) || !inSheet(0, -1.5))
          continue;
        inside++;
        if (luma.at(px, py) >= lit) shown++;
      }
    }
    console.log(
      `winged: membranes ${sheetArea} px, body ${bodyArea.n} px, ${shown} of ${inside} sheet pixels lit`,
    );
    // The plan's wings cover at least the quarter of the body that makes it winged (T8).
    expect(sheetArea).toBeGreaterThanOrEqual(bodyArea.n * 0.25);
    expect(inside).toBeGreaterThan(200);
    expect(shown / inside).toBeGreaterThanOrEqual(0.9);
  });
  // Inner anatomy (M6 T12): the colour lives inside, and the organs show through the shell.
  test('colour lives inside every body, and bilateral bodies of 3+ segments show 3+ bright organs', () => {
    const rows: string[] = [];
    const failures: string[] = [];
    FILES.forEach((file, index) => {
      const s = specimen(file.slice(0, 3));
      const place = placeOf(index, { radius });
      const { inside, rim } = bodyPixels(place, s.plan);
      const ratio =
        hueVariance(inside.map((p) => luma.rgb(p.x, p.y))) /
        Math.max(hueVariance(rim.map((p) => luma.rgb(p.x, p.y))), 1e-6);
      const values = inside.map((p) => luma.at(p.x, p.y));
      const lit = blobs(luma, inside, median(values) + 25, 3);
      const counted = !s.plan.form.radial && s.plan.segments.length >= 3;
      rows.push(`${file.slice(0, 24)} hue x${ratio.toFixed(1)} blobs ${lit}${counted ? ' *' : ''}`);
      if (ratio < 3)
        failures.push(`${file}: inside hue variance only x${ratio.toFixed(2)} the rim's`);
      if (counted && lit < 3) failures.push(`${file}: ${lit} bright blobs inside`);
    });
    console.log(rows.join('\n'));
    expect(failures).toEqual([]);
    // The blob count applies to some specimens at all.
    const counted = FILES.filter((f) => {
      const { plan } = specimen(f.slice(0, 3));
      return !plan.form.radial && plan.segments.length >= 3;
    });
    expect(counted.length).toBeGreaterThanOrEqual(3);
  });

  // Materials v2 (M6 T13): silvery glass shells, colour inside, and glints that rise with rarity.
  test('shells stay pale: the median share of saturated shell pixels is below 5% of the body', () => {
    const shares: number[] = [];
    const rows: string[] = [];
    FILES.forEach((file, index) => {
      const s = specimen(file.slice(0, 3));
      const place = placeOf(index, { radius });
      const { hull, shell } = shellPixels(place, s);
      const saturated = shell.filter((p) => saturation(luma.rgb(p.x, p.y)) > 0.6).length;
      shares.push(saturated / hull.length);
      rows.push(`${file.slice(0, 24)} ${((100 * saturated) / hull.length).toFixed(1)}%`);
    });
    console.log(`saturated shell pixels (share of the body):\n${rows.join('\n')}`);
    expect(median(shares)).toBeLessThan(0.05);
  });

  test('the exotic specimen glints at least 8 times and the common one at most twice', () => {
    const counts: Record<string, number> = {};
    for (const file of FILES) {
      const s = specimen(file.slice(0, 3));
      counts[file.slice(0, 24)] = glintMaxima(luma, placeOf(s.index, { radius }));
    }
    console.log('glint maxima:', counts);
    const exotic = specimen('36-specimen-tier-exotic');
    const common = specimen('33-specimen-tier-common');
    expect(glintMaxima(luma, placeOf(exotic.index, { radius }))).toBeGreaterThanOrEqual(8);
    expect(glintMaxima(luma, placeOf(common.index, { radius }))).toBeLessThanOrEqual(2);
  });

  test("every specimen's rim stays the brightest ring of its body", () => {
    const failures: string[] = [];
    const rows: string[] = [];
    FILES.forEach((file, index) => {
      const s = specimen(file.slice(0, 3));
      const rings = ringMeans(luma, placeOf(index, { radius }), s.plan);
      rows.push(`${file.slice(0, 24)} ${rings.map((v) => v.toFixed(0)).join(' ')}`);
      const [rim = 0, ...inner] = rings;
      if (inner.some((v) => v > rim)) failures.push(`${file}: rings ${rings.map(Math.round)}`);
    });
    console.log(`mean luminance, rim ring first:\n${rows.join('\n')}`);
    expect(failures).toEqual([]);
  });
});

const saturation = ([r, g, b]: readonly [number, number, number]): number => {
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
};

/**
 * A specimen's hull pixels, and those of its shell: the hull less its organs (each disc widened by
 * half, plus 2 px for the glow) and its gut line, where the pigment lives (T12).
 */
function shellPixels(place: ReturnType<typeof placeOf>, s: ReturnType<typeof specimen>) {
  const creature = buildCreature(s.genome);
  const { organs, gut } = anatomyOf(creature.plan, creature.traits, creature.hash);
  const margin = 2 / place.r;
  const inOrgan = (x: number, y: number): boolean =>
    organs.some((o) => Math.hypot(x - o.x, y - o.y) <= o.r * 1.5 + margin) ||
    gut.some((g) => Math.hypot(x - g.x, y - g.y) <= g.r * 1.5 + margin + 0.04);
  const hull: { x: number; y: number }[] = [];
  const shell: { x: number; y: number }[] = [];
  const reach = 2.6 * place.r;
  for (let py = Math.floor(place.y - reach); py <= place.y + reach; py++) {
    for (let px = Math.floor(place.x - reach); px <= place.x + reach; px++) {
      const [x, y] = [(px - place.x) / place.r, (place.y - py) / place.r];
      if (!insideScaled(creature.plan, x, y, 1)) continue;
      hull.push({ x: px, y: py });
      if (!inOrgan(x, y)) shell.push({ x: px, y: py });
    }
  }
  return { hull, shell };
}

/**
 * Glints: isolated white-hot points within 2.6 core radii of a specimen. A glint is a pixel of at
 * least 250 luminance that stands 30 levels above every pixel on the circle 3 px round it (so a rim,
 * a seta or an organ's broad glow, which run through the circle as bright, never counts) and 100
 * above the circle's median (so the star's own thin rays do not hide it, while it still outshines a
 * bright part it sits on), and is at least 4 px from a brighter one.
 */
function glintMaxima(luma: Luma, place: ReturnType<typeof placeOf>): number {
  const reach = 2.6 * place.r;
  const peaks: { x: number; y: number; v: number }[] = [];
  const ring = Array.from({ length: 24 }, (_, k) => {
    const a = (2 * Math.PI * k) / 24;
    return [3 * Math.cos(a), 3 * Math.sin(a)] as const;
  });
  for (let y = Math.floor(place.y - reach); y <= place.y + reach; y++) {
    for (let x = Math.floor(place.x - reach); x <= place.x + reach; x++) {
      const v = luma.at(x, y);
      if (v < 250 || Math.hypot(x - place.x, y - place.y) > reach) continue;
      const around = ring.map(([dx, dy]) => luma.at(x + dx, y + dy)).sort((a, b) => a - b);
      const [middle, top] = [
        around[around.length >> 1] as number,
        around[around.length - 1] as number,
      ];
      if (v - top >= 30 && v - middle >= 100) peaks.push({ x, y, v });
    }
  }
  peaks.sort((a, b) => b.v - a.v);
  const kept: typeof peaks = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= 4)) kept.push(p);
  }
  return kept.length;
}

/** Mean luminance of the hull's bands, rim first: [0.88, 1], [0.66, 0.88], [0.44, 0.66], [0, 0.44] of the hull. */
function ringMeans(luma: Luma, place: ReturnType<typeof placeOf>, plan: BodyPlan): number[] {
  const edges = [1, 0.88, 0.66, 0.44, 0];
  const sums = new Array<number>(4).fill(0);
  const counts = new Array<number>(4).fill(0);
  const reach = 2.6 * place.r;
  for (let py = Math.floor(place.y - reach); py <= place.y + reach; py++) {
    for (let px = Math.floor(place.x - reach); px <= place.x + reach; px++) {
      const [x, y] = [(px - place.x) / place.r, (place.y - py) / place.r];
      const band = edges.findIndex(
        (outer, i) =>
          i < 4 &&
          insideScaled(plan, x, y, outer) &&
          !insideScaled(plan, x, y, edges[i + 1] as number),
      );
      if (band < 0) continue;
      sums[band] = (sums[band] as number) + luma.at(px, py);
      counts[band] = (counts[band] as number) + 1;
    }
  }
  return sums.map((s, i) => s / Math.max(1, counts[i] as number));
}

test("the player's body at default zoom keeps the medium budget and a bright rim", async ({
  page,
}) => {
  const { genome } = specimen('31-specimen-winged');
  await openGame(page, `?debug=1&quality=medium&seed=mesh&genome=${genomeToBase64url(genome)}`);
  await hatch(page);
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
  // Hold the world still so the screenshot shows the frame the hook describes.
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  await page.waitForTimeout(300);
  const info = await page.evaluate(() => (window.__bs as BsHook).render.info());
  expect(info.preset).toBe('medium');
  expect(info.lod).toBe('medium');
  expect(info.vertices).toBeGreaterThan(0);
  expect(info.vertices).toBeLessThanOrEqual(6_000);

  const player = await page.evaluate(() => (window.__bs as BsHook).state().player);
  if (!player) throw new Error('no player');
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  const luma = await lumaOf(page, await page.screenshot());
  const r = player.radius * info.pxPerWu;
  const [cx, cy] = [width / 2, height / 2];
  const water: number[] = [];
  const body: number[] = [];
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      const d = Math.hypot(x - cx, y - cy);
      if (d <= 1.05 * r) body.push(luma.at(x, y));
      else if (d >= 3 * r && d <= 4.5 * r) water.push(luma.at(x, y));
    }
  }
  body.sort((a, b) => a - b);
  const rim = body[Math.floor(body.length * 0.98)] as number;
  console.log(
    `player: ${info.vertices} vertices, radius ${r.toFixed(1)} px, rim ${rim}, water ${median(water)}`,
  );
  expect(rim - median(water)).toBeGreaterThanOrEqual(40);
});

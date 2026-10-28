import { readdirSync, readFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import type { BodyPlan, Point } from '../../src/genome/develop';
import { buildCreature } from '../../src/genome/stats';
import { galleryCell, galleryGrid, LABEL_HEIGHT, parseSpecimen } from '../../src/lab/gallery';
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
}

/** A PNG's luminance, 0-255 per pixel, decoded by the browser. */
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
    const out = new Uint8Array(image.width * image.height);
    for (let i = 0; i < out.length; i++) {
      const [r, gr, b] = [rgba[i * 4] ?? 0, rgba[i * 4 + 1] ?? 0, rgba[i * 4 + 2] ?? 0];
      out[i] = Math.round(0.2126 * r + 0.7152 * gr + 0.0722 * b);
    }
    let text = '';
    for (let i = 0; i < out.length; i += 0x8000) {
      text += String.fromCharCode(...out.subarray(i, i + 0x8000));
    }
    return { width: image.width, height: image.height, base64: btoa(text) };
  }, png.toString('base64'));
  const luma = Buffer.from(base64, 'base64');
  return {
    width,
    height,
    at: (x, y) => {
      const [i, j] = [Math.round(x), Math.round(y)];
      return i < 0 || j < 0 || i >= width || j >= height ? 0 : (luma[j * width + i] as number);
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

/** How many of eight 45° directions hold bright pixels past 1.6 core radii from the core's centre. */
function directionsReached(luma: Luma, place: ReturnType<typeof placeOf>, bright: number): number {
  const counts = new Array<number>(8).fill(0);
  const reach = 2.6 * place.r;
  for (let y = Math.floor(place.y - reach); y <= place.y + reach; y++) {
    for (let x = Math.floor(place.x - reach); x <= place.x + reach; x++) {
      const d = Math.hypot(x - place.x, y - place.y);
      if (d <= 1.6 * place.r || d > reach || luma.at(x, y) < bright) continue;
      const sector = Math.floor(
        ((Math.atan2(place.y - y, x - place.x) + 2 * Math.PI) % (2 * Math.PI)) / (Math.PI / 4),
      );
      counts[sector % 8] = (counts[sector % 8] as number) + 1;
    }
  }
  return counts.filter((n) => n >= 4).length;
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
      reached[prefix] = directionsReached(luma, place, waterIn(luma, place) + 40);
    }
    console.log('directions reached past 1.6 core radii:', reached);
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
});

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

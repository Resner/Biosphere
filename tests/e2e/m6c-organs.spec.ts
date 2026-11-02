import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import {
  brighterOutside,
  decodePng,
  type HueClusters,
  hueArc,
  hueClusters,
  type Image,
  meanHue,
  type OrganLook,
  organLook,
} from './look-metrics';

// Organs in two related tones, eyes in the organ colour, a faint inner glow (M6c T7, ADR 0043),
// judged on the gallery sheet by region, from the hook's masks. The glow is found by drawing the
// sheet again without it (`&glow=0`) and comparing.

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: GALLERY_VIEWPORT,
  deviceScaleFactor: 1,
});

/** At most two hue clusters, their centres at most this far apart (turns). */
const SPREAD = 0.1;
/** The share of a cell's organ pixels that may lie outside both clusters (edges, glass over them). */
const OUTSIDE = 0.05;
/** The iris's hue lies this close to the main organ hue. */
const IRIS_HUE = 0.05;
/** A glow pixel is one the glow lifts by at least this many luminance levels (0-255). */
const GLOW_RISE = 3;
/** No glow pixel lies farther than this from its organ. */
const GLOW_REACH = 2;
/** Fewer coloured pixels than this in a region is too few to judge. */
const MIN_PIXELS = 20;

interface Cell {
  file: string;
  look: OrganLook;
  clusters: HueClusters;
  glow: { brighter: number; outside: number };
}

let cells: Cell[];

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: GALLERY_VIEWPORT,
    deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const png = await captureGallery(page, baseURL as string);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/m6c-organs-sheet.png', png);
  const state = (await page.evaluate(() => window.__gallery?.state())) as GalleryState | undefined;
  if (!state) throw new Error('no gallery');
  const image: Image = await decodePng(page, png);
  const unlitPng = await captureGallery(page, baseURL as string, '&glow=0');
  writeFileSync('test-results/m6c-organs-unlit.png', unlitPng);
  writeFileSync('test-results/m6c-organs-state.json', JSON.stringify(state));
  const unlit: Image = await decodePng(page, unlitPng);
  await context.close();
  cells = state.specimens.map((s) => {
    const look = organLook(image, s.masks);
    return {
      file: s.file,
      look,
      clusters: hueClusters(look.organs),
      glow: brighterOutside(image, unlit, s.masks, s.masks.glow, GLOW_RISE, GLOW_REACH),
    };
  });
  const f = (v: number) => v.toFixed(3);
  console.log(
    cells
      .map((c) => {
        const iris =
          c.look.iris.length >= MIN_PIXELS && c.look.main.length >= MIN_PIXELS
            ? f(hueArc(meanHue(c.look.iris), meanHue(c.look.main)))
            : '    -';
        return `${c.file.slice(0, 28).padEnd(28)} organs ${String(c.look.organs.length).padStart(4)} px  centres ${f(c.clusters.centres[0])} ${f(c.clusters.centres[1])}  spread ${f(c.clusters.spread)}  outside ${f(c.clusters.outside)}  iris ${iris} (${c.look.iris.length} px)  glow ${c.glow.brighter} px, ${c.glow.outside} outside`;
      })
      .join('\n'),
  );
});

test('per cell, the organ pixels fall into at most 2 hue clusters at most 0.1 turns apart', () => {
  const judged = cells.filter((c) => c.look.organs.length >= MIN_PIXELS);
  // Slim evolved bodies' organs are a few pixels across, but most cells show theirs; a check over few
  // would pass on nothing.
  expect(judged.length).toBeGreaterThanOrEqual(cells.length / 2);
  const off = judged
    .map((c) => ({
      file: c.file,
      spread: Number(c.clusters.spread.toFixed(3)),
      outside: Number(c.clusters.outside.toFixed(3)),
    }))
    .filter((c) => !(c.spread <= SPREAD && c.outside <= OUTSIDE));
  expect(off).toEqual([]);
});

test('the eye-iris hue is within 0.05 of the main organ hue', () => {
  const judged = cells.filter(
    (c) => c.look.iris.length >= MIN_PIXELS && c.look.main.length >= MIN_PIXELS,
  );
  // The sheet's eyed specimens (oculatus, big eyes) show their irises.
  expect(judged.length).toBeGreaterThanOrEqual(2);
  const off = judged
    .map((c) => ({
      file: c.file,
      arc: Number(hueArc(meanHue(c.look.iris), meanHue(c.look.main)).toFixed(3)),
    }))
    .filter((c) => !(c.arc <= IRIS_HUE));
  expect(off).toEqual([]);
});

test('no organ-glow pixel lies more than 2 px outside its organ', () => {
  // The glow shows: most cells have pixels it lifts.
  expect(cells.filter((c) => c.glow.brighter > 0).length).toBeGreaterThanOrEqual(cells.length / 2);
  const off = cells.filter((c) => c.glow.outside > 0).map((c) => ({ file: c.file, ...c.glow }));
  expect(off).toEqual([]);
});

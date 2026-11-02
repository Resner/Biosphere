import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { galleryCell, galleryGrid, LABEL_HEIGHT } from '../../src/lab/gallery';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import {
  type BodyLook,
  bodyLook,
  decodePng,
  type Image,
  insidePolygon,
  median,
} from './look-metrics';

// Pass 1's glass without the haze and the glow (M6b T3, ADR 0034), judged on the gallery sheet and
// masked by the hook's drawn geometry: the colour stays in the organs, and the shell is clear.

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: GALLERY_VIEWPORT,
  deviceScaleFactor: 1,
});

/**
 * Pass 1's sheet (36 specimens), the realism baseline: cells 01–06 hold the same genesis genomes as
 * now, so their shells compare (ADR 0043). M6c T6 brought pass 1's face back, and the shell may be
 * no milkier than pass 1's: its median excess over the water on those cells at most this much above.
 */
const PASS1 = new URL('../../docs/art/gallery/pass-1.png', import.meta.url);
const PASS1_SPECIMENS = 36;
const BASELINE = 6;
const PASS1_SPREAD = 0.15;

let image: Image;
let state: GalleryState;
let looks: (BodyLook & { file: string })[];
let pass1: BodyLook[];

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: GALLERY_VIEWPORT,
    deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const png = await captureGallery(page, baseURL as string);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/m6b-look-sheet.png', png);
  const read = await page.evaluate(() => window.__gallery?.state());
  if (!read) throw new Error('no gallery');
  state = read;
  image = await decodePng(page, png);
  const old = await decodePng(page, readFileSync(PASS1));
  await context.close();
  const grid = galleryGrid(state.specimens.length, state.width, state.height);
  const room = (i: number, g: typeof grid) => {
    const cell = galleryCell(i, g);
    const r = { ...cell, h: cell.h - LABEL_HEIGHT };
    return { room: r, centre: { x: cell.x + cell.w / 2, y: cell.y + r.h / 2 } };
  };
  looks = state.specimens.map((s, i) => {
    const { room: r, centre } = room(i, grid);
    // The eyes' irises carry the main organ colour (M6c T7, ADR 0043): pigment, like the organs.
    const pigment = { organs: [...s.organs, ...s.eyes], outline: s.outline };
    return { file: s.file, ...bodyLook(image, r, centre, state.radius, pigment) };
  });
  // The same bodies' geometry placed on pass 1's layout: moved to the old cell, scaled by its radius.
  const oldGrid = galleryGrid(PASS1_SPECIMENS, state.width, state.height);
  const k = oldGrid.radius / grid.radius;
  pass1 = state.specimens.slice(0, BASELINE).map((s, i) => {
    const [now, then] = [room(i, grid).centre, room(i, oldGrid)];
    const at = (p: { x: number; y: number }) => ({
      x: then.centre.x + (p.x - now.x) * k,
      y: then.centre.y + (p.y - now.y) * k,
    });
    return bodyLook(old, then.room, then.centre, oldGrid.radius, {
      organs: s.organs.map((o) => ({ ...at(o), r: o.r * k })),
      outline: s.outline.map(at),
    });
  });
  console.log(
    looks
      .map(
        (l) =>
          `${l.file.slice(0, 28).padEnd(28)} colour ${String(l.coloured).padStart(5)} in organs ${(100 * l.inOrgans).toFixed(0).padStart(3)}%  shell ${l.shellLuma.toFixed(0).padStart(3)} over water ${l.water.toFixed(0)} (+${l.excess.toFixed(1)})`,
      )
      .join('\n'),
  );
});

test('the hook reports each body as drawn: organs inside its outline', () => {
  for (const s of state.specimens) {
    expect(s.outline.length, s.file).toBeGreaterThanOrEqual(8);
    expect(s.organs.length, s.file).toBeGreaterThanOrEqual(3);
    const inside = s.organs.filter((o) => insidePolygon(s.outline, o.x, o.y)).length;
    expect(inside / s.organs.length, s.file).toBeGreaterThanOrEqual(0.9);
    for (const o of s.organs) expect(o.r, s.file).toBeLessThan(state.radius);
  }
});

test('colour stays in the organs: 85% of the coloured pixels inside each body lie within 1.3 organ radii', () => {
  const failures = looks.filter((l) => l.inOrgans < 0.85).map((l) => `${l.file} ${l.inOrgans}`);
  expect(failures).toEqual([]);
});

test("the shell is no milkier than pass 1's: on cells 01–06 its median excess over the water is within 15% of pass 1's", () => {
  const now = median(looks.slice(0, BASELINE).map((l) => l.excess));
  const then = median(pass1.map((l) => l.excess));
  console.log(`shell excess on cells 01–06: ${now.toFixed(1)}, pass 1 ${then.toFixed(1)}`);
  expect(now).toBeLessThanOrEqual(then * (1 + PASS1_SPREAD));
});

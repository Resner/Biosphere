import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { galleryCell, galleryGrid, LABEL_HEIGHT } from '../../src/lab/gallery';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import { type BodyLook, bodyLook, decodePng, type Image, insidePolygon } from './look-metrics';

// Pass 1's glass without the haze and the glow (M6b T3, ADR 0034), judged on the gallery sheet and
// masked by the hook's drawn geometry: the colour stays in the organs, and the shell is clear.

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: GALLERY_VIEWPORT,
  deviceScaleFactor: 1,
});

/**
 * The sheet median of the shell's excess luminance over the water (0-255), measured on main before
 * T3 (pass 5's organ halos and scattered light; per body 22 to 152). T3's bar is half of it.
 */
const MAIN_SHELL_EXCESS = 63.1;

let image: Image;
let state: GalleryState;
let looks: (BodyLook & { file: string })[];

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
  await context.close();
  const grid = galleryGrid(state.specimens.length, state.width, state.height);
  looks = state.specimens.map((s, i) => {
    const cell = galleryCell(i, grid);
    const room = { ...cell, h: cell.h - LABEL_HEIGHT };
    const centre = { x: cell.x + cell.w / 2, y: cell.y + room.h / 2 };
    return { file: s.file, ...bodyLook(image, room, centre, state.radius, s) };
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

test("the shell is clear: its median excess over the water is at most half of main's", () => {
  const excess = [...looks.map((l) => l.excess)].sort((a, b) => a - b);
  const median = excess[excess.length >> 1] as number;
  console.log(`shell excess: sheet median ${median.toFixed(1)}, main ${MAIN_SHELL_EXCESS}`);
  expect(median).toBeLessThanOrEqual(MAIN_SHELL_EXCESS / 2);
});

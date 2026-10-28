import { readdirSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { galleryCell, galleryGrid, LABEL_HEIGHT } from '../../src/lab/gallery';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';

// The look-pass gallery (M6 T5, ADR 0024): `lab.html?gallery=1` draws every specimen file in name
// order on a fixed 1600×1000 sheet, and two captures from one build are byte-identical, so the
// committed sheets of successive passes compare.

test.use({
  // The sheet is drawn on the high preset whatever the stored setting.
  storageState: { cookies: [], origins: [] },
  viewport: GALLERY_VIEWPORT,
  deviceScaleFactor: 1,
});

const FILES = readdirSync(new URL('../fixtures/gallery/', import.meta.url))
  .filter((f) => f.endsWith('.hex'))
  .sort();

test('the gallery draws every specimen in file-name order on a fixed sheet, offline', async ({
  page,
  baseURL,
}) => {
  const problems: string[] = [];
  const foreign: string[] = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(m.text());
  });
  page.on('pageerror', (e) => problems.push(e.message));
  const origin = new URL(baseURL as string).origin;
  page.on('request', (r) => {
    const url = new URL(r.url());
    if (url.protocol.startsWith('http') && url.origin !== origin) foreign.push(r.url());
  });
  const png = await captureGallery(page, baseURL as string);

  const state = await page.evaluate(() => window.__gallery?.state());
  if (!state) throw new Error('no gallery');
  expect(FILES.length).toBeGreaterThanOrEqual(20);
  expect(state.specimens.map((s) => s.file)).toEqual(FILES);
  expect(state.specimens.every((s) => s.valid && s.vertices > 0)).toBe(true);
  const grid = galleryGrid(FILES.length, state.width, state.height);
  expect([state.width, state.height]).toEqual([1600, 1000]);
  expect([state.cols, state.rows]).toEqual([grid.cols, grid.rows]);
  const canvas = await page.getByTestId('gallery-canvas').evaluate((c: HTMLCanvasElement) => ({
    width: c.width,
    height: c.height,
  }));
  expect(canvas).toEqual({ width: 1600, height: 1000 });
  await expect(page.locator('.gallery-label')).toHaveCount(FILES.length);

  // Every cell holds a lit body above its caption, against the dark water.
  const rects = FILES.map((_, i) => galleryCell(i, grid));
  const lit = await page.evaluate(
    async ({ base64, rects, band }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const c = document.createElement('canvas');
      c.width = image.width;
      c.height = image.height;
      const g = c.getContext('2d');
      if (!g) throw new Error('2D canvas unavailable');
      g.drawImage(image, 0, 0);
      const { data } = g.getImageData(0, 0, image.width, image.height);
      return rects.map((r) => {
        let n = 0;
        for (let y = Math.ceil(r.y); y < Math.floor(r.y + r.h - band); y++) {
          for (let x = Math.ceil(r.x); x < Math.floor(r.x + r.w); x++) {
            const i = (y * image.width + x) * 4;
            if ((data[i] ?? 0) + (data[i + 1] ?? 0) + (data[i + 2] ?? 0) > 120) n++;
          }
        }
        return n;
      });
    },
    { base64: png.toString('base64'), rects, band: LABEL_HEIGHT },
  );
  expect(lit.every((n) => n > 200)).toBe(true);
  expect(problems).toEqual([]);
  expect(foreign).toEqual([]);
});

test('two captures of the gallery from one build are byte-identical', async ({
  browser,
  baseURL,
}) => {
  const capture = async () => {
    const context = await browser.newContext({ viewport: GALLERY_VIEWPORT, deviceScaleFactor: 1 });
    try {
      return await captureGallery(await context.newPage(), baseURL as string);
    } finally {
      await context.close();
    }
  };
  const first = await capture();
  const second = await capture();
  expect(first.length).toBeGreaterThan(10_000);
  expect(first.equals(second)).toBe(true);
});

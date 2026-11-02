import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import { galleryCell, galleryGrid, LABEL_HEIGHT } from '../../src/lab/gallery';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import { decodePng, type GlassLook, glassLook, type Image } from './look-metrics';

// Pass 1's glass again (M6c T6, ADR 0043), judged on the gallery sheet by region, from the hook's
// masks: the face as bright as pass 1's on the same genesis cells, limbs of the same glass as the
// body's rim, and a mouth that is glass, not a dark hole.

test.use({
  storageState: { cookies: [], origins: [] },
  viewport: GALLERY_VIEWPORT,
  deviceScaleFactor: 1,
});

/** Pass 1's sheet held 36 specimens; cells 01–06 were the same genesis genomes as now. */
const PASS1 = new URL('../../docs/art/gallery/pass-1.png', import.meta.url);
const PASS1_SPECIMENS = 36;
const BASELINE = 6;
/** The face may differ from pass 1's by this share at most. */
const FACE_SPREAD = 0.15;
/** The limbs' median over the rim's peak. */
const LIMB_RATIO = [0.85, 1.15] as const;
/** The mouth's mean over the face's, at least. */
const MOUTH_RATIO = 0.8;
/** Fewer pixels than this in a region is too few to judge (a cell without limbs, say). */
const MIN_PIXELS = 12;

let state: GalleryState;
let looks: (GlassLook & { file: string })[];
let pass1: number[];

test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({
    viewport: GALLERY_VIEWPORT,
    deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  const png = await captureGallery(page, baseURL as string);
  mkdirSync('test-results', { recursive: true });
  writeFileSync('test-results/m6c-glass-sheet.png', png);
  const read = await page.evaluate(() => window.__gallery?.state());
  if (!read) throw new Error('no gallery');
  state = read;
  const image: Image = await decodePng(page, png);
  const old: Image = await decodePng(page, readFileSync(PASS1));
  await context.close();
  for (const [i, s] of state.specimens.entries()) {
    if (![31, 34, 7].includes(i)) continue;
    const { maskBits } = await import('./look-metrics');
    const m = s.masks;
    for (const name of ['face', 'rim', 'limbs', 'mouth'] as const) {
      const bits = maskBits(m[name], m.w * m.h);
      writeFileSync(`test-results/dbg-${i}-${name}.pgm`, Buffer.concat([Buffer.from(`P5 ${m.w} ${m.h} 255\n`), Buffer.from(bits.map((b) => b * 255))]));
    }
  }
  looks = state.specimens.map((s) => ({ file: s.file, ...glassLook(image, s.masks) }));
  // The same face masks, placed on pass 1's layout: each body's centre moved to its old cell and
  // scaled by the old radius.
  const grid = galleryGrid(state.specimens.length, state.width, state.height);
  const oldGrid = galleryGrid(PASS1_SPECIMENS, state.width, state.height);
  const centre = (index: number, g: typeof grid) => {
    const cell = galleryCell(index, g);
    return { x: cell.x + cell.w / 2, y: cell.y + (cell.h - LABEL_HEIGHT) / 2 };
  };
  const k = oldGrid.radius / grid.radius;
  pass1 = state.specimens.slice(0, BASELINE).map((s, i) => {
    const [now, then] = [centre(i, grid), centre(i, oldGrid)];
    return glassLook(old, s.masks, (x, y) => ({
      x: then.x + (x + 0.5 - now.x) * k - 0.5,
      y: then.y + (y + 0.5 - now.y) * k - 0.5,
    })).face;
  });
  const f = (v: number) => (Number.isNaN(v) ? '  -' : v.toFixed(0).padStart(3));
  console.log(
    looks
      .map(
        (l, i) =>
          `${l.file.slice(0, 28).padEnd(28)} face ${f(l.face)}${i < BASELINE ? ` (pass 1 ${f(pass1[i] as number)})` : '            '}  rim ${f(l.rim)}  limbs ${f(l.limbs)} (${l.counts.limbs} px, ${(l.limbs / l.rim).toFixed(2)})  mouth ${f(l.mouth)} (${l.counts.mouth} px, ${(l.mouth / l.face).toFixed(2)}; around ${f(l.aroundMouth)} ${l.counts.aroundMouth} px, ${(l.mouth / l.aroundMouth).toFixed(2)}) low ${f(l.faceLow)} med ${f(l.faceMedian)} m/low ${(l.mouth / l.faceLow).toFixed(2)} m/med ${(l.mouth / l.faceMedian).toFixed(2)}`,
      )
      .join('\n'),
  );
});

test('the hook masks every cell: a face, a rim and a mouth on the body', () => {
  for (const l of looks) {
    expect(l.counts.face, l.file).toBeGreaterThanOrEqual(MIN_PIXELS);
    expect(l.counts.rim, l.file).toBeGreaterThanOrEqual(MIN_PIXELS);
  }
  // Every genesis cell has its mouth on the body's front.
  for (const l of looks.slice(0, BASELINE)) {
    expect(l.counts.mouth, l.file).toBeGreaterThanOrEqual(MIN_PIXELS);
  }
});

test("cells 01–06: the face's mean luminance is within 15% of pass 1's", () => {
  const off = looks
    .slice(0, BASELINE)
    .map((l, i) => ({ file: l.file, now: l.face, then: pass1[i] as number }))
    .filter(
      (c) => !(Math.abs(c.now - c.then) <= FACE_SPREAD * c.then) || Number.isNaN(c.then),
    );
  expect(off).toEqual([]);
});

test("per cell, the limbs' median luminance is 0.85–1.15 of the body rim's", () => {
  const judged = looks.filter((l) => l.counts.limbs >= MIN_PIXELS);
  // Most cells have limbs; a check over none would pass on nothing.
  expect(judged.length).toBeGreaterThanOrEqual(looks.length / 2);
  const off = judged
    .map((l) => ({ file: l.file, ratio: Number((l.limbs / l.rim).toFixed(3)) }))
    .filter((c) => !(c.ratio >= LIMB_RATIO[0] && c.ratio <= LIMB_RATIO[1]));
  expect(off).toEqual([]);
});

test("per cell, the mouth's mean luminance is at least 0.8 of the face's: no dark hole", () => {
  const off = looks
    .filter((l) => l.counts.mouth >= MIN_PIXELS)
    .map((l) => ({ file: l.file, ratio: Number((l.mouth / l.face).toFixed(3)) }))
    .filter((c) => !(c.ratio >= MOUTH_RATIO));
  expect(off).toEqual([]);
});

import { mkdirSync, writeFileSync } from 'node:fs';
import { type Browser, type ConsoleMessage, chromium, expect, test } from '@playwright/test';
import type { CellMasks } from '../../src/lab/gallery-masks';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, chromiumPath, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import { CROWD_VIEWPORT, openCrowdGame, stageCrowd } from './crowd';
import { decodePng, type Image, luminance, maskBits } from './look-metrics';

// Firefox draws creatures cleanly (M6c T8). The owner's Firefox showed dotted white lines and a
// coarse cell pattern in the middle of a body. In Firefox (the `firefox` project, `E2E full` only):
// the gallery and a crowded play screen raise no WebGL warning beyond three.js's known texture-upload
// notices, and the fine detail inside each gallery body (the Laplacian's energy over its face mask)
// is at most 1.3× Chromium's for the same cell. CI draws both through Mesa, which may not show every
// driver's artefact; the owner checks his own Firefox and GPU.

test.skip(({ browserName }) => browserName !== 'firefox', 'Firefox only: the firefox project');
// Both tests read what one capture measured.
test.describe.configure({ mode: 'serial' });

/**
 * Warnings three.js is known to raise in Firefox on texture uploads (Firefox deprecates unpack
 * premultiply and flip for uploads that are not DOM elements, which three sets on every texture).
 */
const ALLOWED = [
  /texImage(2D|3D)?: Alpha-premult and y-flip are deprecated for non-DOM-Element uploads/,
];
/** What counts as a WebGL warning in the console. */
const WEBGL = /WebGL|GL_|shader|THREE\./i;
/** The energy inside a body may be at most this many times Chromium's. */
const MAX_RATIO = 1.3;
/**
 * A floor under Chromium's energy (luminance levels squared): on a face of near-flat glass both
 * browsers read a few levels of dither and grain, whose ratio says nothing.
 */
const FLOOR = 4;
/** Fewer face pixels with a whole face round them than this are too few to judge. */
const MIN_PIXELS = 40;
/** Slim and limb-crowded bodies have little open face; the round genesis cells and most specimens do. */
const MIN_CELLS = 10;

/** Captures of a sheet that comes back blank before the test gives up. */
const BLANK_ATTEMPTS = 3;

let warnings: string[] = [];
let energy: { file: string; firefox: number; chromium: number; pixels: number }[] = [];

/** The mean squared 4-neighbour Laplacian of luminance over the face pixels whose neighbours are face too. */
function faceEnergy(image: Image, masks: CellMasks): { energy: number; pixels: number } {
  const bits = maskBits(masks.face, masks.w * masks.h);
  const at = (x: number, y: number): boolean =>
    x >= 0 && y >= 0 && x < masks.w && y < masks.h && bits[y * masks.w + x] === 1;
  const lum = (x: number, y: number): number =>
    luminance(image.rgba, ((masks.y + y) * image.width + masks.x + x) * 4);
  let sum = 0;
  let pixels = 0;
  for (let y = 0; y < masks.h; y++) {
    for (let x = 0; x < masks.w; x++) {
      if (!(at(x, y) && at(x - 1, y) && at(x + 1, y) && at(x, y - 1) && at(x, y + 1))) continue;
      const l = 4 * lum(x, y) - lum(x - 1, y) - lum(x + 1, y) - lum(x, y - 1) - lum(x, y + 1);
      sum += l * l;
      pixels++;
    }
  }
  return { energy: pixels === 0 ? Number.NaN : sum / pixels, pixels };
}

/**
 * True when no face on the sheet holds more than dither's worth of detail: the canvas reached the
 * capture blank. A flat sheet is not always exactly zero (E2E main: the Chromium reference read
 * energies under 0.05 on every face), while the round genesis cells of a drawn sheet read 90 and more.
 */
function blankSheet(image: Image, specimens: GalleryState['specimens']): boolean {
  return specimens.every((s) => !(faceEnergy(image, s.masks).energy > FLOOR));
}

/**
 * The gallery sheet and its masks, captured in `browser` at the sheet's own viewport. Software GL
 * under load now and then hands the screenshot a blank canvas (E2E main, M6c T9: the Chromium
 * reference came back flat), which says nothing about either browser: such a capture is taken again.
 */
async function gallery(
  browser: Browser,
  baseURL: string,
  name: string,
  listen?: (m: ConsoleMessage) => void,
) {
  for (let attempt = 1; ; attempt++) {
    const context = await browser.newContext({
      viewport: GALLERY_VIEWPORT,
      deviceScaleFactor: 1,
      storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    if (listen) page.on('console', listen);
    const png = await captureGallery(page, baseURL);
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/m6c-firefox-${name}.png`, png);
    const state = (await page.evaluate(() => window.__gallery?.state())) as
      | GalleryState
      | undefined;
    if (!state) throw new Error('no gallery');
    const image = await decodePng(page, png);
    await context.close();
    if (!blankSheet(image, state.specimens)) return { image, state };
    if (attempt === BLANK_ATTEMPTS) throw new Error(`the ${name} gallery sheet is blank`);
    console.log(`the ${name} gallery sheet came back blank; capturing it again`);
  }
}

test.beforeAll(async ({ browser, browserName, baseURL }) => {
  if (browserName !== 'firefox') return;
  // Software GL draws the high preset slowly, in two browsers here.
  test.setTimeout(300_000);
  const listen = (m: ConsoleMessage): void => {
    if ((m.type() === 'warning' || m.type() === 'error') && WEBGL.test(m.text())) {
      warnings.push(m.text().slice(0, 400));
    }
  };
  const firefox = await gallery(browser, baseURL as string, 'firefox', listen);

  // The play screen on high, with a crowd of bodies on screen.
  const context = await browser.newContext({
    viewport: CROWD_VIEWPORT,
    deviceScaleFactor: 1,
    storageState: { cookies: [], origins: [] },
    baseURL: baseURL as string,
  });
  const page = await context.newPage();
  page.on('console', listen);
  await openCrowdGame(page, 'high');
  await stageCrowd(page, [20, 30, 40, 50]);
  await context.close();

  const executablePath = chromiumPath(chromium.executablePath());
  const other = await chromium.launch(executablePath ? { executablePath } : {});
  const reference = await gallery(other, baseURL as string, 'chromium');
  await other.close();

  energy = firefox.state.specimens.map((s, i) => {
    const masks = reference.state.specimens[i]?.masks as CellMasks;
    const ff = faceEnergy(firefox.image, s.masks);
    return {
      file: s.file,
      firefox: ff.energy,
      chromium: faceEnergy(reference.image, masks).energy,
      pixels: ff.pixels,
    };
  });
  warnings = [...new Set(warnings)];
  console.log(`Firefox WebGL console messages:\n${warnings.join('\n') || '(none)'}`);
  console.log(
    energy
      .map(
        (e) =>
          `${e.file.slice(0, 28).padEnd(28)} firefox ${e.firefox.toFixed(1)} chromium ${e.chromium.toFixed(1)} (${e.pixels} px)`,
      )
      .join('\n'),
  );
});

test('no WebGL warning in the gallery or the play screen beyond the known texture notices', () => {
  expect(warnings.filter((w) => !ALLOWED.some((a) => a.test(w)))).toEqual([]);
});

test("the fine detail inside each body is at most 1.3× Chromium's for the same cell", () => {
  const judged = energy.filter((e) => e.pixels >= MIN_PIXELS);
  // A check over few cells would pass on nothing.
  expect(judged.length).toBeGreaterThanOrEqual(MIN_CELLS);
  const off = judged
    .map((e) => ({
      file: e.file,
      ratio: Number((e.firefox / Math.max(e.chromium, FLOOR)).toFixed(3)),
    }))
    .filter((e) => !(e.ratio <= MAX_RATIO));
  expect(off).toEqual([]);
});

// The gallery capture (M6 T5, ADR 0024), shared by `npm run gallery` and its E2E so the test checks
// the tool's own path: the sheet at a fixed viewport and pixel ratio, captured once it holds still.
import { existsSync } from 'node:fs';

export const GALLERY_PATH = 'lab.html?gallery=1';
export const GALLERY_VIEWPORT = { width: 1600, height: 1000 };
/** Software GL draws the high preset slowly; the sheet still takes only seconds. */
const READY_TIMEOUT = 120_000;

/** The pre-installed Chromium of cloud sessions, when the pinned Playwright's build is missing. */
export function chromiumPath(expected) {
  const preinstalled = '/opt/pw-browsers/chromium';
  return !existsSync(expected) && existsSync(preinstalled) ? preinstalled : undefined;
}

/** Opens the gallery on `page` (viewport `GALLERY_VIEWPORT`, scale 1) and returns the sheet as PNG. */
export async function captureGallery(page, baseURL) {
  await page.goto(new URL(GALLERY_PATH, baseURL).href);
  await page.waitForFunction(() => window.__gallery?.ready === true, null, {
    timeout: READY_TIMEOUT,
  });
  return page.getByTestId('gallery').screenshot({ animations: 'disabled', caret: 'hide' });
}

/** `--pass <n>` (a whole number, required) and `--no-build` (capture the existing `dist/`). */
export function parseGalleryArgs(argv) {
  let pass = null;
  let build = true;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--no-build') build = false;
    else if (arg === '--pass') pass = argv[++i] ?? null;
    else if (arg?.startsWith('--pass=')) pass = arg.slice('--pass='.length);
    else throw new Error(`unknown argument ${arg}`);
  }
  if (pass === null || !/^\d+$/.test(pass)) throw new Error('usage: npm run gallery -- --pass <n>');
  return { pass: Number(pass), build };
}

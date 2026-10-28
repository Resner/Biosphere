// Renders the look-pass gallery (M6 T5, ADR 0024): `npm run gallery -- --pass <n>` builds the site,
// serves `dist/`, opens `lab.html?gallery=1` in the shared Chromium and saves the sheet to
// `docs/art/gallery/pass-<n>.png`. `--no-build` captures the `dist/` already there.
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { build, preview } from 'vite';
import {
  captureGallery,
  chromiumPath,
  GALLERY_VIEWPORT,
  parseGalleryArgs,
} from './gallery-capture.mjs';

const args = parseGalleryArgs(process.argv.slice(2));
if (args.build) await build({ logLevel: 'warn' });
const server = await preview({ logLevel: 'error', preview: { port: 0, open: false } });
const executablePath = chromiumPath(chromium.executablePath());
const browser = await chromium.launch(executablePath ? { executablePath } : {});
try {
  const { port } = server.httpServer.address();
  const page = await browser.newPage({ viewport: GALLERY_VIEWPORT, deviceScaleFactor: 1 });
  const png = await captureGallery(page, `http://localhost:${port}/`);
  const dir = new URL('../docs/art/gallery/', import.meta.url);
  await mkdir(dir, { recursive: true });
  const out = new URL(`pass-${args.pass}.png`, dir);
  await writeFile(out, png);
  process.stdout.write(`gallery: ${out.pathname} (${Math.round(png.length / 1024)} kB)\n`);
} finally {
  await browser.close();
  await new Promise((resolve) => server.httpServer.close(resolve));
}

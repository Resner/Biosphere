import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import { galleryCell, galleryGrid, LABEL_HEIGHT, parseSpecimen } from '../../src/lab/gallery';
import type { GalleryState } from '../../src/lab/gallery-page';
import { captureGallery, GALLERY_VIEWPORT } from '../../tools/gallery-capture.mjs';
import { hatch, openGame } from './helpers';
import { decodePng, solidWhite } from './look-metrics';

// No white clipping (M6b T4, ADR 0034): where bright strokes stack (setae, setules, the edges of
// broad parts), bloom and the grade's shoulder used to burn them to solid white. Every gallery cell,
// and every one of the worst specimens drawn in game, holds at most 12 solid-white pixels.

test.use({ storageState: { cookies: [], origins: [] } });

/** ADR 0034's bar: solid-white pixels (min(R, G, B) ≥ 245 with eight such neighbours) per body. */
const MAX_WHITE = 12;

const DIR = new URL('../fixtures/gallery/', import.meta.url);
const FILES = readdirSync(DIR)
  .filter((f) => f.endsWith('.hex'))
  .sort();

/** A gallery specimen's genome as drawn (its v2 upgrade), as base64url. */
function specimenGenome(prefix: string): string {
  const file = FILES.find((f) => f.startsWith(prefix));
  if (!file) throw new Error(`no specimen ${prefix}`);
  const parsed = parseSpecimen(file, readFileSync(new URL(file, DIR), 'utf8'));
  if (!parsed) throw new Error(`unreadable specimen ${file}`);
  return genomeToBase64url(parsed.genome);
}

test.describe('the gallery sheet', () => {
  test.use({ viewport: GALLERY_VIEWPORT, deviceScaleFactor: 1 });

  test('every cell holds at most 12 solid-white pixels', async ({ page, baseURL }) => {
    test.setTimeout(120_000);
    const png = await captureGallery(page, baseURL as string);
    mkdirSync('test-results', { recursive: true });
    writeFileSync('test-results/m6b-clip-sheet.png', png);
    const state = (await page.evaluate(() => window.__gallery?.state())) as GalleryState;
    const image = await decodePng(page, png);
    const grid = galleryGrid(state.specimens.length, state.width, state.height);
    const counts = state.specimens.map((s, i) => {
      const cell = galleryCell(i, grid);
      // The label strip under each body is text, not the body.
      const room = { ...cell, h: cell.h - LABEL_HEIGHT };
      return { file: s.file, white: solidWhite(image.rgba, image.width, room) };
    });
    console.log(
      `solid white per cell:\n${counts.map((c) => `${c.file.slice(0, 28).padEnd(28)} ${c.white}`).join('\n')}`,
    );
    expect(counts.filter((c) => c.white > MAX_WHITE)).toEqual([]);
  });
});

/** Six of the specimens that clipped worst on pass 5, drawn as remotes (the spec's in-game check). */
const IN_GAME = ['07-', '08-', '31-', '37-', '38-', '39-'] as const;

async function frames(page: Page, count = 3): Promise<void> {
  const now = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    now + count,
    { timeout: 60_000 },
  );
}

for (const quality of ['medium', 'high'] as const) {
  test(`in game at ${quality}, the worst specimens hold at most 12 solid-white pixels each`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await openGame(page, `?debug=1&seed=clip&quality=${quality}`);
    await hatch(page);
    await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
    const genomes = IN_GAME.map(specimenGenome);
    const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
    await page.evaluate(
      ({ genomes, width, height }) => {
        const { debug, render } = window.__bs as BsHook;
        if (!debug) throw new Error('no debug hook');
        debug.timeScale(0);
        const at = debug.setZone('twilight');
        const { pxPerWu } = render.info();
        // A 3 × 2 grid round the player, which sits in the middle of the frame.
        debug.setRemotes(
          genomes.map((genome, i) => ({
            id: `clip${i}`,
            name: `C${i}`,
            genome,
            // The hatchling's tier (no size outline), about five times its biomass.
            biomass: 200,
            x: at.x + (((i % 3) - 1) * width) / 3 / pxPerWu,
            y: at.y + ((Math.floor(i / 3) - 0.5) * 0.52 * height) / pxPerWu,
          })),
        );
      },
      { genomes, width, height },
    );
    await page.waitForFunction(
      (n) => {
        const { state, render } = window.__bs as BsHook;
        return (
          render.info().remoteBodies === n && state().remotes.every((remote) => remote.alpha === 1)
        );
      },
      genomes.length,
      { timeout: 60_000 },
    );
    await frames(page);
    // The canvas alone: name labels and the HUD are DOM text, not bodies.
    await page.addStyleTag({ content: 'body > :not(#scene) { visibility: hidden !important; }' });
    await frames(page);
    const view = await page.evaluate(() => {
      const { state, render } = window.__bs as BsHook;
      const s = state();
      const info = render.info();
      const { camX, camY } = render.fx();
      return { camX, camY, remotes: s.remotes, pxPerWu: info.pxPerWu, preset: info.preset };
    });
    expect(view.preset).toBe(quality);
    const png = await page.screenshot();
    mkdirSync('test-results', { recursive: true });
    writeFileSync(`test-results/m6b-clip-${quality}.png`, png);
    const image = await decodePng(page, png);
    const rows = view.remotes.map((r, i) => {
      // Each body's box: its parts reach up to about 2.6 core radii.
      const x = width / 2 + (r.x - view.camX) * view.pxPerWu;
      const y = height / 2 - (r.y - view.camY) * view.pxPerWu;
      const reach = 2.6 * r.radius * view.pxPerWu;
      const box = { x: x - reach, y: y - reach, w: 2 * reach, h: 2 * reach };
      return {
        id: IN_GAME[i],
        px: Math.round(r.radius * view.pxPerWu),
        white: solidWhite(image.rgba, image.width, box),
      };
    });
    console.log(`${quality}: ${rows.map((r) => `${r.id} r${r.px} ${r.white}`).join(', ')}`);
    expect(rows).toHaveLength(IN_GAME.length);
    expect(rows.every((r) => r.px >= 10)).toBe(true);
    expect(rows.filter((r) => r.white > MAX_WHITE)).toEqual([]);
  });
}

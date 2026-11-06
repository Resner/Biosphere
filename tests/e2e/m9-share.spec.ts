import { readFile } from 'node:fs/promises';
import { expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import { clickHatch, M9_SHARE_HUB, openRecorded, state, waitPlaying } from './helpers';
import { decodePng } from './look-metrics';

// From the game to the card and its image (M9 T14): A hatches and opens the menu's Lineage. Its
// creature's "Card" link opens the card in a new tab, with the local hub carried over. "Save image"
// waits for the verdict, then downloads a 1200 × 630 PNG of the creature, its name and its verdict.

test.describe.configure({ mode: 'serial', timeout: 120_000 }); // the recorded hatch alone takes about 15 s
// The card and its image are judged by eye: the card opens on its own (high) preset.
test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 1280, height: 800 } });

const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

test('the Lineage section opens a creature’s card, whose image saves as a 1200 × 630 PNG @slow', async ({
  context,
}) => {
  const page = await context.newPage();
  // The game itself on low: only the card is judged.
  await openRecorded(page, '&quality=low', M9_SHARE_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  const s = await state(page);
  if (!s.life.creature || !s.player) throw new Error('A hatched no recorded creature');
  const creature = s.life.creature;

  // Esc opens the menu, which holds Lineage.
  await page.keyboard.press('Escape');
  await page.getByTestId('menu-lineage').click();
  const link = page.getByTestId('lineage-card').first();
  await expect(link, 'the Lineage section lists A’s creature with its card').toBeVisible({
    timeout: 15_000,
  });
  const href = await link.getAttribute('href');
  expect(href).toBe(`card.html?c=${creature}&hub=${encodeURIComponent(M9_SHARE_HUB)}`);
  expect(await link.getAttribute('target')).toBe('_blank');

  // The verifier's worker is held so the button is seen waiting for the verdict.
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await context.route(/verify-worker-[^/]*\.js$/, async (route) => {
    await held;
    await route.continue();
  });
  const [card] = await Promise.all([context.waitForEvent('page'), link.click()]);
  await card.waitForFunction(() => window.__card?.state().drawn === true, null, {
    timeout: 30_000,
  });
  expect(await cardState(card)).toMatchObject({ verdict: null, image: { ready: false } });
  await expect(card.getByTestId('card-save')).toBeDisabled();
  release();

  await card
    .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
      timeout: 30_000,
    })
    .catch(async (error) => {
      throw new Error(`the card never finished: ${JSON.stringify(await cardState(card))}`, {
        cause: error,
      });
    });
  const c = await cardState(card);
  expect(c).toMatchObject({
    phase: 'done',
    subject: creature,
    species: s.player.species,
    verdict: 'verified',
    image: { ready: true, saved: 0 },
  });
  await expect(card.getByTestId('card-save')).toBeEnabled();

  const [download] = await Promise.all([
    card.waitForEvent('download'),
    card.getByTestId('card-save').click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-biosphere\.png$/);
  const png = await readFile(await download.path());
  // The PNG signature, then the IHDR's width and height.
  expect(png.subarray(1, 4).toString('latin1')).toBe('PNG');
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1200, 630]);
  expect((await cardState(card)).image.saved).toBe(1);

  // The creature is drawn on the left of the image: pixels brighter than the water.
  const image = await decodePng(card, png);
  let lit = 0;
  for (let y = 0; y < 560; y += 2) {
    for (let x = 0; x < 600; x += 2) {
      const i = (y * image.width + x) * 4;
      const rgba = image.rgba;
      if ((rgba[i] as number) + (rgba[i + 1] as number) + (rgba[i + 2] as number) > 90) lit++;
    }
  }
  expect(lit, 'the creature drawn on the image').toBeGreaterThan(100);
  await download.saveAs('test-results/m9-share-image.png');
  await test.info().attach('m9-share-image', {
    path: 'test-results/m9-share-image.png',
    contentType: 'image/png',
  });
  await card.screenshot({ path: 'test-results/m9-share-card.png' });
});

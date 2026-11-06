import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { openGame, state } from './helpers';

// M10 T6: the page's witness availability (`avail`, ADR 0058) and Settings' "Help referee fights".
// No hub: the page judges itself the same way, and `state().witness.avail` is what it would say.

const avail = async (page: Page) => (await state(page)).witness.avail;

async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

test('the page offers to witness by default, and not while hidden or with the setting off', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=avail');
  // Software rendering draws slowly: skip the draw, as the witness specs do.
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  await expect
    .poll(() => avail(page), { timeout: 30_000, message: 'avail on after 5 s of fast frames' })
    .toBe(true);
  await setHidden(page, true);
  expect(await avail(page)).toBe(false);
  await setHidden(page, false);
  await expect
    .poll(() => avail(page), { timeout: 30_000, message: 'avail on again once visible' })
    .toBe(true);

  await page.getByTestId('settings-open').click();
  const box = page.getByTestId('help-referee');
  await expect(box).toBeChecked();
  await expect(page.getByTestId('referee-note')).toHaveText(
    "Lets the game use a little of your connection to referee other players' fights.",
  );
  await box.uncheck();
  expect(await avail(page)).toBe(false);
  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('help-referee')).not.toBeChecked();
  expect(await avail(page)).toBe(false);
});

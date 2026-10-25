import { expect, test } from '@playwright/test';
import { openGame } from './helpers';

const playerId = async (page: import('@playwright/test').Page) => {
  await page.waitForFunction(() => window.__bs?.state().playerId != null);
  return page.evaluate(() => window.__bs?.state().playerId);
};

test('the playerId survives a reload and changes when site data is cleared', async ({ page }) => {
  await openGame(page, '?seed=identity');
  const first = await playerId(page);
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);

  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
  expect(await playerId(page)).toBe(first);

  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('biosphere-identity');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      }),
  );
  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
  const second = await playerId(page);
  expect(second).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(second).not.toBe(first);
});

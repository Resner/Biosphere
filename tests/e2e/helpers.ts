import type { Page } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';

/** Opens the game on the title screen and waits for the test hook. */
export async function openGame(page: Page, query: string): Promise<void> {
  await page.goto(`./${query}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
}

/** Clicks Hatch and waits until play has started. */
export async function hatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
}

export async function playerOf(page: Page): Promise<NonNullable<BsState['player']>> {
  const { player } = await page.evaluate(() => (window.__bs as BsHook).state());
  if (!player) throw new Error('the player has not hatched');
  return player;
}

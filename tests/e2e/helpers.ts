import type { Page } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';

/** Opens the game on the title screen and waits for the test hook. */
export async function openGame(page: Page, query: string): Promise<void> {
  await page.goto(`./${query}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
}

/**
 * Clicks Hatch and waits until play has started. The click leaves the cursor on the button, which
 * would steer the cell away, so the cursor is parked on the cell (inside its dead zone).
 */
export async function hatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

export async function playerOf(page: Page): Promise<NonNullable<BsState['player']>> {
  const { player } = await page.evaluate(() => (window.__bs as BsHook).state());
  if (!player) throw new Error('the player has not hatched');
  return player;
}

/** Bundles a source file into one browser script (an IIFE that sets `globalName`). */
export async function bundleForBrowser(entry: string, globalName: string): Promise<string> {
  const { build } = await import('vite');
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry, name: globalName, formats: ['iife'], fileName: 'bundle' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const chunk = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error(`no bundle for ${entry}`);
  return chunk.code;
}

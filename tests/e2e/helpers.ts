import { expect, type Page } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';

/**
 * Opens the game on the title screen and waits for the test hook. A test that does not pin a body
 * with `genome=` gets the starter cell, so the thresholds of the M1 and M2 specs stay meaningful.
 */
export async function openGame(page: Page, query: string): Promise<void> {
  const pinned = /[?&]genome=/.test(query)
    ? query
    : `${query}${query.includes('?') ? '&' : '?'}genome=starter`;
  await page.goto(`./${pinned}`);
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

export const state = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

/** Types a chat line through the real UI (Enter, text, Enter). */
export async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeHidden();
}

export const chatTexts = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).state().social.chat.map((l) => l.text));

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

/** Mean luminance (0..1) of the square patches of `2 * half + 1` pixels around each point of a PNG. */
export async function patchLuma(
  page: Page,
  png: Buffer,
  points: { x: number; y: number }[],
  half = 4,
): Promise<number[]> {
  return page.evaluate(
    async ({ base64, points, half }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      return points.map((p) => {
        const size = 2 * half + 1;
        const { data } = context.getImageData(
          Math.round(p.x) - half,
          Math.round(p.y) - half,
          size,
          size,
        );
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum +=
            (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)) /
            255;
        }
        return sum / (size * size);
      });
    },
    { base64: png.toString('base64'), points, half },
  );
}

/** The authority the M4 specs share: `wrangler dev --e2e`, serving recorded drand rounds. */
export const M4_HUB = 'http://localhost:8790';

/** The M4 authority with lifespans at 1% (about 45 s), for the old-age spec. */
export const M4_SHORT_LIFE_HUB = 'http://localhost:8791';

/** Opens the game against an M4 hub with no pinned body, so a hatch goes through the ledger. */
export async function openRecorded(page: Page, extra = '', hub = M4_HUB): Promise<void> {
  await page.goto(`./?debug=1&hub=${hub}${extra}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
  await page.waitForFunction(() => window.__bs?.state().playerId);
}

/** Clicks Hatch on the title screen without waiting for play to start. */
export const clickHatch = (page: Page) =>
  page.getByRole('button', { name: 'Hatch', exact: true }).click();

/** Waits for play to start after a recorded hatch, which takes a beacon round (3 to 6 s). */
export async function waitPlaying(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
    timeout: 15_000,
  });
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

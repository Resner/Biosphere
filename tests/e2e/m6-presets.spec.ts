import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS, type PresetName } from '../../src/render/presets';
import { hatch, openGame } from './helpers';

// Quality presets (M6 T1): the URL, the stored setting and the settings panel all end in the same
// `render.info()`. A device ratio of 2 makes every preset's pixel ratio distinguishable.
test.use({ deviceScaleFactor: 2 });

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

async function waitForFrames(page: Page, frames = 3): Promise<void> {
  const before = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    before + frames,
  );
}

async function choose(page: Page, quality: string): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByTestId('lineage-settings').click();
  await page.getByTestId(`quality-${quality}`).check();
  await page.getByTestId('settings-close').click();
  await page.getByTestId('lineage-close').click();
}

const EXPECT: Record<PresetName, { ratio: number }> = {
  low: { ratio: 1 },
  medium: { ratio: 1.5 },
  high: { ratio: 2 },
};

test('?quality= starts the game on that preset', async ({ page }) => {
  for (const preset of ['low', 'high'] as const) {
    await openGame(page, `?debug=1&seed=presets&quality=${preset}`);
    await hatch(page);
    const now = await info(page);
    expect(now.preset).toBe(preset);
    expect(now.pixelRatio).toBe(EXPECT[preset].ratio);
    expect(now.calls).toBeLessThanOrEqual(PRESETS[preset].budget.calls);
  }
});

test('the settings panel switches preset at runtime and the choice survives a reload', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=presets');
  await hatch(page);
  await waitForFrames(page);
  const medium = await info(page);
  expect(medium.preset).toBe('medium');
  expect(medium.pixelRatio).toBe(1.5);

  await choose(page, 'low');
  await waitForFrames(page);
  const low = await info(page);
  expect(low.preset).toBe('low');
  expect(low.pixelRatio).toBe(1);
  expect(low.particles).toBeLessThan(medium.particles);
  expect(low.calls).toBeLessThanOrEqual(PRESETS.low.budget.calls);
  const canvasWidth = await page.locator('#scene').evaluate((c) => (c as HTMLCanvasElement).width);
  const cssWidth = await page.locator('#scene').evaluate((c) => c.clientWidth);
  expect(canvasWidth).toBe(cssWidth);

  await choose(page, 'high');
  await waitForFrames(page);
  const high = await info(page);
  expect(high.preset).toBe('high');
  expect(high.pixelRatio).toBe(2);
  expect(high.particles).toBeGreaterThan(medium.particles);
  expect(high.calls).toBeLessThanOrEqual(PRESETS.high.budget.calls);

  await openGame(page, '?debug=1&seed=presets');
  expect((await info(page)).preset).toBe('high');
  // ?quality= beats the stored value without overwriting it.
  await openGame(page, '?debug=1&seed=presets&quality=low');
  expect((await info(page)).preset).toBe('low');
  await openGame(page, '?debug=1&seed=presets');
  expect((await info(page)).preset).toBe('high');
});

test('Auto resolves to a preset and says which', async ({ page }) => {
  await openGame(page, '?debug=1&seed=presets');
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('quality-auto')).toBeChecked();
  await expect(page.getByTestId('quality-note')).toContainText('medium');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('settings')).toBeHidden();
});

test('the game still runs with localStorage blocked', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'localStorage', {
      get() {
        throw new Error('blocked');
      },
    });
  });
  await openGame(page, '?debug=1&seed=presets');
  await hatch(page);
  await waitForFrames(page);
  expect((await info(page)).preset).toBe('medium');
  await choose(page, 'low');
  expect((await info(page)).preset).toBe('low');
  expect((await page.evaluate(() => (window.__bs as BsHook).state())).screen).toBe('playing');
});

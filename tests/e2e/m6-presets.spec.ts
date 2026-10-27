import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS, type PresetName } from '../../src/render/presets';
import { hatch, openGame } from './helpers';

// Quality presets (M6 T1): the URL, the stored setting and the settings panel all end in the same
// `render.info()`. A device ratio of 2 makes every preset's pixel ratio distinguishable.
test.use({ deviceScaleFactor: 2, storageState: { cookies: [], origins: [] } });

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

// Independent of PRESETS: the pixel ratios DESIGN §12 lists, at a device ratio of 2.
const RATIO: Record<PresetName, number> = { low: 1, medium: 1.5, high: 2 };

test('?quality= starts the game on that preset', async ({ page }) => {
  for (const preset of ['low', 'high'] as const) {
    await openGame(page, `?debug=1&seed=presets&quality=${preset}`);
    await hatch(page);
    const now = await info(page);
    expect(now.preset).toBe(preset);
    expect(now.pixelRatio).toBe(RATIO[preset]);
    expect(now.calls).toBeLessThanOrEqual(PRESETS[preset].budget.calls);
  }
});

// One switch per test since the post chain (M6 T2): high at a device ratio of 2 renders slowly in
// software, and a test doing both ran past the 20 s a PR-gate scenario may take.
test('the settings panel switches from medium to low at runtime', async ({ page }) => {
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
});

test('the settings panel switches from low to high at runtime', async ({ page }) => {
  await openGame(page, '?debug=1&seed=presets&quality=low');
  await hatch(page);
  await waitForFrames(page);
  const low = await info(page);
  expect(low.preset).toBe('low');

  await choose(page, 'high');
  await waitForFrames(page);
  const high = await info(page);
  expect(high.preset).toBe('high');
  expect(high.pixelRatio).toBe(2);
  expect(high.particles).toBeGreaterThan(low.particles);
  expect(high.calls).toBeLessThanOrEqual(PRESETS.high.budget.calls);
});

test('the choice survives a reload, and ?quality= beats it without overwriting it', async ({
  page,
}) => {
  // The same panel from the title screen, so no hatch is needed.
  await openGame(page, '?debug=1&seed=presets');
  await page.getByTestId('settings-open').click();
  await page.getByTestId('quality-low').check();
  await page.getByTestId('settings-close').click();
  expect((await info(page)).preset).toBe('low');

  await openGame(page, '?debug=1&seed=presets');
  expect((await info(page)).preset).toBe('low');
  await openGame(page, '?debug=1&seed=presets&quality=medium');
  expect((await info(page)).preset).toBe('medium');
  await openGame(page, '?debug=1&seed=presets');
  expect((await info(page)).preset).toBe('low');
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

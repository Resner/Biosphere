import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { openGame } from './helpers';

// Auto-detect and adaptive resolution (M6 T4). Test automation never benchmarks and pins the render
// scale at 1, so `debug.setBench` forces the frame times. Everything happens on the title screen,
// where the benchmark runs, at a small viewport the software renderer can afford.
test.use({
  viewport: { width: 640, height: 360 },
  storageState: { cookies: [], origins: [] },
});

const bs = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state().quality);
const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());
const setBench = (page: Page, ms: number) =>
  page.evaluate((m) => (window.__bs as BsHook).debug?.setBench(m), ms);
const waitForScale = (page: Page, want: 'below' | 'full') =>
  page.waitForFunction(
    (t) => {
      const scale = (window.__bs as BsHook).render.info().renderScale;
      return t === 'below' ? scale < 1 : scale === 1;
    },
    want,
    { timeout: 15_000 },
  );

test('setBench picks high, medium and low, and the stored choice skips the benchmark', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=auto');
  // Automation skips the benchmark: auto means medium.
  expect(await bs(page)).toEqual({ setting: 'auto', detected: 'medium', bench: 'skipped' });
  expect((await info(page)).preset).toBe('medium');

  for (const [ms, preset, label] of [
    [8, 'high', 'Auto (High)'],
    [15, 'medium', 'Auto (Medium)'],
    [30, 'low', 'Auto (Low)'],
  ] as const) {
    await setBench(page, ms);
    expect(await bs(page)).toEqual({ setting: 'auto', detected: preset, bench: 'measured' });
    expect((await info(page)).preset).toBe(preset);
    await expect(page.getByTestId('quality-auto-name')).toHaveText(label);
  }

  await setBench(page, 8);
  await openGame(page, '?debug=1&seed=auto');
  expect(await bs(page)).toEqual({ setting: 'auto', detected: 'high', bench: 'stored' });
  expect((await info(page)).preset).toBe('high');
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('quality-auto')).toBeChecked();
  await expect(page.getByTestId('quality-auto-name')).toHaveText('Auto (High)');
});

test('a slow frame budget steps the render scale down and a fast one steps it back up', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=auto&quality=medium');
  const canvas = page.locator('#scene');
  const css = await canvas.evaluate((c) => [c.clientWidth, c.clientHeight]);
  const full = await info(page);
  expect(full.renderScale).toBe(1);

  await setBench(page, 30);
  await waitForScale(page, 'below');
  const scaled = await info(page);
  expect(scaled.preset).toBe('medium');
  expect(scaled.renderScale).toBe(0.9);
  expect(scaled.targetBytes).toBeLessThan(full.targetBytes);
  // Only the scene target shrinks: the canvas, its backing store and the HUD keep their size.
  expect(await canvas.evaluate((c) => [c.clientWidth, c.clientHeight])).toEqual(css);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).width)).toBe(
    Math.floor((css[0] ?? 0) * full.pixelRatio),
  );
  await expect(page.getByTestId('settings-open')).toBeVisible();

  await setBench(page, 8);
  await waitForScale(page, 'full');
  const back = await info(page);
  expect(back.renderScale).toBe(1);
  expect(back.targetBytes).toBe(full.targetBytes);
});

test('on low the canvas backing store shrinks, never its CSS size', async ({ page }) => {
  await openGame(page, '?debug=1&seed=auto&quality=low');
  const canvas = page.locator('#scene');
  const css = await canvas.evaluate((c) => [c.clientWidth, c.clientHeight]);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).width)).toBe(css[0]);

  await setBench(page, 30);
  await waitForScale(page, 'below');
  expect((await info(page)).renderScale).toBe(0.9);
  expect(await canvas.evaluate((c) => [c.clientWidth, c.clientHeight])).toEqual(css);
  expect(await canvas.evaluate((c) => (c as HTMLCanvasElement).width)).toBe(
    Math.floor((css[0] ?? 0) * 0.9),
  );
});

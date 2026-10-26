import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, openRecorded, state, waitPlaying } from './helpers';

// The hatch bucket (M4 T10): three quick deaths use up the recorded hatches; the fourth Hatch shows
// the countdown and offers the practice cell instead.

test.describe.configure({ mode: 'serial' });

test('after three quick deaths the fourth hatch waits, and the practice cell plays unrecorded', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await openRecorded(page);
  await expect(page.getByTestId('history-empty')).toBeVisible();

  await clickHatch(page);
  await waitPlaying(page);
  for (let life = 1; life <= 3; life++) {
    expect((await state(page)).life.status).toBe('playing');
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy(0);
      bs.debug?.timeScale(10);
    });
    await page.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 20_000,
    });
    expect((await state(page)).death?.cause).toBe('starved');
    if (life < 3) {
      await page.getByTestId('hatch-again').click();
      await waitPlaying(page);
    }
  }

  // The bucket is empty: Hatch waits and says for how long.
  await page.getByTestId('hatch-again').click();
  await expect(page.getByTestId('hatch-note')).toHaveText(/^Next recorded hatch in \d+:\d\d$/);
  await expect(page.getByTestId('hatch-again')).toBeDisabled();
  await expect(page.getByTestId('practice-again')).toBeVisible();
  expect((await state(page)).screen).toBe('dead');
  expect((await state(page)).life.limitMs).toBeGreaterThan(0);
  await page.screenshot({ path: 'test-results/m4-limit-countdown.png' });

  // The practice cell plays like any other, marked as not recorded.
  await page.getByTestId('practice-again').click();
  await waitPlaying(page);
  const practice = await state(page);
  expect(practice.life.status).toBe('practice');
  await expect(page.getByTestId('practice-badge')).toBeVisible();
  await expect(page.getByTestId('hud-life')).toBeHidden();
  expect(practice.player?.alive).toBe(true);
  await context.close();
});

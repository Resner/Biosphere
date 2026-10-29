import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, state } from './helpers';

// The audio engine in the running game (M6 T22): it starts on the first gesture, suspends in a
// hidden tab, follows the depth zone and obeys the Settings panel.

const audio = async (page: Page) => (await state(page)).audio;

/** Makes the tab look hidden (or visible again) and tells the page, as a real tab switch would. */
async function setHidden(page: Page, hidden: boolean): Promise<void> {
  await page.evaluate((h) => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => h });
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => (h ? 'hidden' : 'visible'),
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
}

const audioState = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state().audio.state);

test('the audio starts on a click, suspends while hidden and resumes on return', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=audio');
  expect((await audio(page)).state).toBe('idle');
  await hatch(page);
  await expect.poll(() => audioState(page)).toBe('running');

  await setHidden(page, true);
  await expect.poll(() => audioState(page)).toBe('suspended');
  await setHidden(page, false);
  await expect.poll(() => audioState(page)).toBe('running');
});

test('changing the zone changes the ambience', async ({ page }) => {
  await openGame(page, '?debug=1&seed=audio');
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  const seen: Record<string, NonNullable<Awaited<ReturnType<typeof audio>>['ambience']>> = {};
  for (const zone of ['shallows', 'abyss'] as const) {
    await page.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    await expect.poll(async () => (await audio(page)).zone).toBe(zone);
    const now = await audio(page);
    if (!now.ambience) throw new Error('no ambience');
    seen[zone] = now.ambience;
  }
  const { shallows, abyss } = seen;
  if (!shallows || !abyss) throw new Error('missing zone');
  expect(shallows.bodyHz).toBeGreaterThan(abyss.bodyHz);
  expect(shallows.air).toBeGreaterThan(abyss.air);
  expect(abyss.pressure).toBeGreaterThan(0);
  expect(shallows.pressure).toBe(0);
});

test('volume and mute in the Settings panel apply at once and survive a reload', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=audio');
  expect(await audio(page)).toMatchObject({ volume: 60, muted: false });
  await page.getByTestId('settings-open').click();
  await page.getByTestId('volume').fill('25');
  expect(await audio(page)).toMatchObject({ volume: 25, gain: 0.0625 });
  await page.getByTestId('mute').check();
  // Mute is instant: the master gain's target drops to zero with the click.
  expect(await audio(page)).toMatchObject({ muted: true, gain: 0 });
  await page.getByTestId('settings-close').click();

  await page.reload();
  await page.waitForFunction(() => window.__bs?.ready === true);
  expect(await audio(page)).toMatchObject({ volume: 25, muted: true, gain: 0 });
  await page.getByTestId('settings-open').click();
  await expect(page.getByTestId('volume')).toHaveValue('25');
  await expect(page.getByTestId('mute')).toBeChecked();
  await page.getByTestId('mute').uncheck();
  expect(await audio(page)).toMatchObject({ muted: false, gain: 0.0625 });
});

test.describe('reduced motion', () => {
  test('defaults to prefers-reduced-motion and the setting overrides it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await openGame(page, '?debug=1&seed=audio');
    expect((await state(page)).egg.motion).toBe('fade');
    await page.getByTestId('settings-open').click();
    const box = page.getByTestId('reduced-motion');
    await expect(box).toBeChecked();
    await box.uncheck();
    expect((await state(page)).egg.motion).toBe('shake');

    // The choice is stored: it beats the system preference after a reload.
    await page.reload();
    await page.waitForFunction(() => window.__bs?.ready === true);
    expect((await state(page)).egg.motion).toBe('shake');
  });

  test('without the system preference the egg shakes until the player asks', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await openGame(page, '?debug=1&seed=audio');
    expect((await state(page)).egg.motion).toBe('shake');
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('reduced-motion')).not.toBeChecked();
    await page.getByTestId('reduced-motion').check();
    expect((await state(page)).egg.motion).toBe('fade');
  });
});

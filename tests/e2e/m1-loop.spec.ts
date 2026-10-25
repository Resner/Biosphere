import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame } from './helpers';

// The whole M1 loop through the real UI and the `window.__bs` hook: hatch, forage, starve, hatch
// again. Time is sped up with `debug.timeScale`, never with sleeps.

const goldenNames = ['idle-starve', 'forage-route', 'hazard-dash'];

test.describe('the M1 loop', () => {
  test('the title screen offers Hatch, and hatching shows a full HUD', async ({ page }) => {
    await openGame(page, '?seed=loop-title');
    expect(await page.evaluate(() => window.__bs?.state().screen)).toBe('title');
    await expect(page.getByRole('button', { name: 'Hatch', exact: true })).toBeVisible();

    // Click and read in one task: the HUD must show the starter before the first tick moves it.
    const hud = await page.evaluate(() => {
      (document.querySelector('[data-testid="hatch"]') as HTMLElement).click();
      const text = (id: string) => document.querySelector(`[data-testid="${id}"]`)?.textContent;
      return {
        biomass: text('hud-biomass'),
        energy: text('hud-energy'),
        health: text('hud-health'),
      };
    });
    expect(hud).toEqual({ biomass: '100', energy: '60%', health: '100' });
    await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
  });

  test('steering to food eats it', async ({ page }) => {
    await openGame(page, '?debug=1&seed=loop-eat');
    await hatch(page);
    for (let i = 0; i < 3; i++) {
      const reached = await page.evaluate(async () => {
        const bs = window.__bs as BsHook;
        const food = bs.debug?.nearestFood();
        if (!food) throw new Error('no food near the player');
        return bs.debug?.steerTo(food);
      });
      expect(reached).toBe(true);
    }
    const { events, player } = await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      return { events: bs.events(), player: bs.state().player };
    });
    expect(events.eat).toBeGreaterThanOrEqual(3);
    // Three items fed more than the metabolism burned on the way (a starter starts at 120).
    expect(player?.energy).toBeGreaterThan(120 - 20);
  });

  test('starving ends in a death screen that names the cause, then hatching again works', async ({
    page,
  }) => {
    await openGame(page, '?debug=1&seed=loop-starve');
    await hatch(page);
    // The cursor sits on the cell (inside the dead zone), so it idles instead of swimming off.
    await page.mouse.move(480, 270);
    await page.evaluate(() => {
      window.__bs?.debug?.setEnergy(0);
      window.__bs?.debug?.timeScale(4);
    });
    await expect(page.getByTestId('death-cause')).toHaveText('Starved', { timeout: 10_000 });
    await expect(page.getByTestId('death-survived')).toContainText('s');
    await expect(page.getByTestId('death-peak')).toContainText('100');
    expect(await page.evaluate(() => window.__bs?.state().screen)).toBe('dead');

    await page.getByRole('button', { name: 'Hatch again' }).click();
    await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
    const player = await page.evaluate(() => window.__bs?.state().player);
    expect(player?.alive).toBe(true);
    expect(player?.biomass).toBe(100);
    await expect(page.getByTestId('hud-biomass')).toHaveText('100');
  });

  test('a toxic plume poisons the player to death', async ({ page }) => {
    await openGame(page, '?debug=1&seed=loop-toxin');
    await hatch(page);
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      const { x, y } = bs.state().player ?? { x: 0, y: 0 };
      bs.debug?.spawnPlume(x, y, 200);
      bs.debug?.timeScale(4);
    });
    await expect(page.getByTestId('death-cause')).toHaveText('Poisoned', { timeout: 10_000 });
  });

  for (const name of goldenNames) {
    test(`replay of ${name} matches the Node golden hash`, async ({ page }) => {
      const golden = JSON.parse(
        readFileSync(new URL(`../../src/sim/__golden__/${name}.json`, import.meta.url), 'utf8'),
      ) as { log: unknown; hash: string };
      await openGame(page, '');
      const result = await page.evaluate((log) => window.__bs?.replay(log as never), golden.log);
      expect(result?.hash).toBe(golden.hash);
    });
  }

  test('the debug helpers exist only with ?debug=1', async ({ page }) => {
    await openGame(page, '?seed=loop-nodebug');
    expect(await page.evaluate(() => window.__bs?.debug)).toBeUndefined();
    await openGame(page, '?debug=1&seed=loop-nodebug');
    expect(await page.evaluate(() => typeof window.__bs?.debug)).toBe('object');
  });
});

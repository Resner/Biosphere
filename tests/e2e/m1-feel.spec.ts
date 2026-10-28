import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, playerOf } from './helpers';

// Feel and feedback: every consequence has a visible cue (DESIGN §10). Cues are read through
// `__bs.render.fx()`, never by pixel peeking, and time is sped up with `timeScale`, not sleeps.

async function play(page: Page, seed: string): Promise<void> {
  await openGame(page, `?debug=1&seed=${seed}`);
  await hatch(page);
}

test.describe('feel and feedback', () => {
  test('each eat shows a pop', async ({ page }) => {
    await play(page, 'feel-eat');
    for (let i = 1; i <= 3; i++) {
      await page.evaluate(async () => {
        const bs = window.__bs as BsHook;
        const food = bs.debug?.nearestFood();
        if (!food) throw new Error('no food near the player');
        await bs.debug?.steerTo(food);
      });
      const { fx, events } = await page.evaluate(() => {
        const bs = window.__bs as BsHook;
        return { fx: bs.render.fx(), events: bs.events() };
      });
      expect(fx.eat).toBeGreaterThanOrEqual(i);
      expect(fx.eat).toBe(events.eat);
    }
  });

  test('a dash spawns a ripple', async ({ page }) => {
    await play(page, 'feel-dash');
    expect((await page.evaluate(() => window.__bs?.render.fx()))?.dash).toBe(0);
    await page.keyboard.press(' ');
    await page.waitForFunction(() => (window.__bs?.render.fx().dash ?? 0) >= 1);
    expect(await page.evaluate(() => window.__bs?.render.fx().rings)).toBeGreaterThanOrEqual(0);
  });

  test('damage raises the vignette, and it fades once the damage stops', async ({ page }) => {
    await play(page, 'feel-damage');
    expect(await page.evaluate(() => window.__bs?.render.fx().vignette)).toBe(0);
    const plume = await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      const { x, y } = bs.state().player ?? { x: 0, y: 0 };
      bs.debug?.spawnPlume(x, y, 200);
      return { x, y };
    });
    await page.waitForFunction(() => (window.__bs?.render.fx().vignette ?? 0) > 0.2);
    expect(await page.evaluate(() => window.__bs?.render.fx().damage)).toBeGreaterThan(0);

    // Swim out of the cloud, far enough that it can no longer touch the cell.
    await page.evaluate(({ x, y }) => {
      window.__bs?.debug?.teleport(x + 2000, y);
    }, plume);
    await page.waitForFunction(() => (window.__bs?.render.fx().vignette ?? 1) < 0.02);
  });

  test('death dissolves the body for at least a second before the death screen', async ({
    page,
  }) => {
    await play(page, 'feel-death');
    await page.evaluate(() => {
      window.__bs?.debug?.setEnergy(0);
      window.__bs?.debug?.timeScale(4);
    });
    const seen = await page.evaluate(
      () =>
        new Promise<{ gapMs: number; dissolveMidway: number; screenAtDeath: string }>((resolve) => {
          const bs = window.__bs as BsHook;
          let diedAt = 0;
          let screenAtDeath = '';
          let dissolveMidway = 0;
          const timer = setInterval(() => {
            const now = performance.now();
            if (bs.state().death !== null && diedAt === 0) {
              diedAt = now;
              screenAtDeath = bs.state().screen;
            }
            if (diedAt > 0) dissolveMidway = Math.max(dissolveMidway, bs.render.fx().dissolve);
            if (bs.state().screen === 'dead') {
              clearInterval(timer);
              resolve({ gapMs: now - diedAt, dissolveMidway, screenAtDeath });
            }
          }, 10);
        }),
    );
    expect(seen.screenAtDeath).toBe('playing');
    expect(seen.gapMs).toBeGreaterThanOrEqual(1000);
    expect(seen.dissolveMidway).toBe(1);
    await expect(page.getByTestId('death-cause')).toHaveText('Starved');
  });

  test('the dissolve starts over on the next hatch', async ({ page }) => {
    await play(page, 'feel-again');
    await page.evaluate(() => {
      window.__bs?.debug?.setEnergy(0);
      window.__bs?.debug?.timeScale(4);
    });
    await page.getByRole('button', { name: 'Hatch again' }).click({ timeout: 15_000 });
    await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
    const fx = await page.evaluate(() => window.__bs?.render.fx());
    expect(fx?.dissolve).toBe(0);
    expect(fx?.eat).toBe(0);
    expect((await playerOf(page)).alive).toBe(true);
  });

  test('the size line follows growth, and each tenth of the adult size shows a ring (M6 T18)', async ({
    page,
  }) => {
    await play(page, 'feel-growth');
    const line = page.getByTestId('hud-growth');
    // The starter hatches at 100 biomass and grows to 400.
    await expect(line).toHaveText(/^Size 2\d% of adult$/);
    const before = await page.evaluate(() => window.__bs?.render.fx().grow ?? 0);
    await page.evaluate(() => window.__bs?.debug?.setBiomass(250));
    await expect(line).toHaveText(/^Size 62% of adult/);
    await expect
      .poll(() => page.evaluate(() => window.__bs?.render.fx().grow ?? 0))
      .toBeGreaterThan(before);
    // Past the adult size the line stays at 100%.
    await page.evaluate(() => window.__bs?.debug?.setBiomass(500));
    await expect(line).toHaveText('Size 100% of adult');
  });

  test('growing from 100 to 400 biomass eases the zoom out without overshoot', async ({ page }) => {
    await play(page, 'feel-zoom');
    const run = await page.evaluate(
      () =>
        new Promise<{ from: number; to: number; peak: number; end: number }>((resolve) => {
          const bs = window.__bs as BsHook;
          const from = bs.render.fx().halfHeight;
          bs.debug?.setBiomass(400);
          // The starter's adult radius is 20 (maximum biomass 400), where the view is 9 * 20^0.9.
          const to = 9 * 20 ** 0.9;
          const start = performance.now();
          let peak = from;
          const sample = () => {
            peak = Math.max(peak, bs.render.fx().halfHeight);
            if (performance.now() - start >= 1500) {
              resolve({ from, to, peak, end: bs.render.fx().halfHeight });
            } else {
              requestAnimationFrame(sample);
            }
          };
          requestAnimationFrame(sample);
        }),
    );
    expect(run.to).toBeGreaterThan(run.from * 1.5);
    expect(run.peak).toBeLessThanOrEqual(run.to * 1.05);
    expect(Math.abs(run.end - run.to) / (run.to - run.from)).toBeLessThan(0.05);
  });
});

import { expect, type Page, test } from '@playwright/test';
import { clickHatch, M4_SHORT_LIFE_HUB, openRecorded, state, waitPlaying } from './helpers';

// Old age (M4 T10), against an authority with lifespans at 1% (about 45 s): the creature turns
// old at 85% of its time, slows by about a fifth, dies of old age, and the next hatch is new.

test.describe.configure({ mode: 'serial' });

/** The steady top speed with the mouse held to the east: the highest speed of the window's second half. */
async function topSpeed(page: Page, windowMs: number): Promise<number> {
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width - 8, height / 2);
  const speed = await page.evaluate(
    (ms) =>
      new Promise<number>((resolve) => {
        const samples: number[] = [];
        const timer = setInterval(() => samples.push(window.__bs?.state().player?.speed ?? 0), 100);
        setTimeout(() => {
          clearInterval(timer);
          resolve(Math.max(...samples.slice(Math.floor(samples.length / 2))));
        }, ms);
      }),
    windowMs,
  );
  await page.mouse.move(width / 2, height / 2);
  return speed;
}

test('a creature grows old, slows, dies of old age, and the next hatch is a new creature', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  await openRecorded(page, '', M4_SHORT_LIFE_HUB);
  await clickHatch(page);
  await waitPlaying(page);

  const young = await state(page);
  expect(young.life.stage).toBe('young');
  expect(young.player?.elder).toBe(false);
  await expect(page.getByTestId('hud-stage')).toHaveText('Young');
  const youngSpeed = await topSpeed(page, 3000);
  expect(youngSpeed).toBeGreaterThan(0);

  // The first report brings the real lifespan; 85% of it later the creature turns old.
  await page.waitForFunction(() => window.__bs?.state().life.stage === 'old', undefined, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('hud-stage')).toHaveText('Old');
  await expect(page.getByTestId('toast')).toHaveText('Feeling old');
  expect((await state(page)).player?.elder).toBe(true);
  await page.screenshot({ path: 'test-results/m4-oldage-old.png' });
  const oldSpeed = await topSpeed(page, 3000);
  expect(oldSpeed / youngSpeed).toBeGreaterThan(0.7);
  expect(oldSpeed / youngSpeed).toBeLessThan(0.9);
  await expect(page.getByTestId('hud-remaining')).toContainText('left');

  await page.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 30_000,
  });
  const dead = await state(page);
  expect(dead.death?.cause).toBe('old-age');
  expect(dead.life.status).toBe('dead');
  await expect(page.getByTestId('death-cause')).toHaveText('Died of old age');
  await expect(page.getByTestId('death-survived')).toHaveText(/^\d+ s$/);
  await page.screenshot({ path: 'test-results/m4-oldage-dead.png' });

  // Rehatching asks for a new genesis; a reload then shows the first life in History.
  await page.getByTestId('hatch-again').click();
  await waitPlaying(page);
  const second = await state(page);
  expect(second.life.creature).not.toBe(dead.life.creature);
  expect(second.player?.genomeHash).not.toBe(young.player?.genomeHash);

  await page.reload();
  await page.waitForFunction(() => window.__bs?.state().playerId);
  await expect(page.getByTestId('history-list').locator('li')).toHaveCount(1);
  await expect(page.getByTestId('history-list')).toContainText('Died of old age');
  await expect(page.getByTestId('history-empty')).toBeHidden();
  await page.screenshot({ path: 'test-results/m4-oldage-history.png' });
  await clickHatch(page);
  await waitPlaying(page);
  expect((await state(page)).life.creature).toBe(second.life.creature);
  await context.close();
});

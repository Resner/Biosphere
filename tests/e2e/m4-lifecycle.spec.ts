import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M4_TWO_SEAT_HUB as HUB, openRecorded, state, waitPlaying } from './helpers';

// The whole M4 life in one scenario (@slow, release gate): hatch, eat, reload, move the creature to
// another browser with the recovery code, die three times, see the history, the empty hatch bucket
// and the practice cell, then the admission queue on a two-seat authority.

test.describe.configure({ mode: 'serial' });

/** Starves the current creature at ten times speed and waits for the death screen. */
async function starve(page: Page): Promise<void> {
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.setEnergy(0);
    bs.debug?.timeScale(10);
  });
  await page.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 20_000,
  });
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  // A drifting plume can get to a starving cell first; this test is about the loop, not the cause.
  expect(['starved', 'toxin']).toContain((await state(page)).death?.cause);
}

/** The recovery code, read on a page that stays offline so it does not take the session over. */
async function readCode(page: Page, playerId: string): Promise<string> {
  const reader = await page.context().newPage();
  await reader.goto('./?debug=1');
  await reader.waitForFunction(() => window.__bs?.ready === true);
  await reader.waitForFunction(() => window.__bs?.state().playerId);
  expect((await state(reader)).playerId).toBe(playerId);
  await reader.getByTestId('recovery-open').click();
  const shown = reader.getByTestId('recovery-code');
  await shown.click();
  await expect(shown).toHaveAttribute('data-revealed', 'true');
  const code = (await shown.textContent()) ?? '';
  await reader.close();
  return code;
}

test('@slow hatch, reload, recovery code, three deaths, history, practice and the queue', async ({
  browser,
}) => {
  test.setTimeout(300_000);

  // Hatch and eat.
  const a = await browser.newContext();
  const pageA = await a.newPage();
  await openRecorded(pageA, '', HUB);
  await clickHatch(pageA);
  await waitPlaying(pageA);
  await pageA.evaluate(async () => {
    const bs = window.__bs as BsHook;
    for (let i = 0; i < 2; i++) {
      const food = bs.debug?.nearestFood();
      if (food) await bs.debug?.steerTo(food);
    }
  });
  const first = await state(pageA);
  expect(first.life.status).toBe('playing');
  expect(first.player?.biomass).toBeGreaterThan(0);

  // Reload: the same creature comes back.
  await pageA.reload();
  await pageA.waitForFunction(() => window.__bs?.ready === true);
  await pageA.waitForFunction(() => window.__bs?.state().playerId);
  await clickHatch(pageA);
  await waitPlaying(pageA);
  const resumed = await state(pageA);
  expect(resumed.life.creature).toBe(first.life.creature);
  expect(resumed.player?.genomeHash).toBe(first.player?.genomeHash);

  // Export the code and import it in a second browser, which takes the creature over.
  const code = await readCode(pageA, first.playerId);
  const b = await browser.newContext();
  const pageB = await b.newPage();
  await openRecorded(pageB, '', HUB);
  const otherPlayer = (await state(pageB)).playerId;
  await pageB.getByTestId('recovery-open').click();
  await pageB.getByTestId('recovery-input').fill(code);
  await pageB.getByTestId('recovery-import').click();
  await pageB.getByTestId('recovery-yes').click();
  await pageB.waitForFunction(
    (was) => window.__bs?.ready === true && window.__bs.state().playerId !== was,
    otherPlayer,
  );
  expect((await state(pageB)).playerId).toBe(first.playerId);
  await pageA.waitForFunction(() => window.__bs?.state().net.status === 'replaced');
  await a.close();
  await clickHatch(pageB);
  await waitPlaying(pageB);
  expect((await state(pageB)).life.creature).toBe(first.life.creature);

  // Three deaths: the same creature, then two new ones. The species of each life, oldest first.
  const species: string[] = [];
  for (let life = 1; life <= 3; life++) {
    expect((await state(pageB)).life.status).toBe('playing');
    species.push((await state(pageB)).player?.species ?? '');
    await starve(pageB);
    if (life < 3) {
      await pageB.getByTestId('hatch-again').click();
      await waitPlaying(pageB);
      expect((await state(pageB)).life.creature).not.toBe(first.life.creature);
    }
  }

  // The bucket is empty: Hatch waits, and the practice cell plays unrecorded.
  await pageB.getByTestId('hatch-again').click();
  await expect(pageB.getByTestId('hatch-note')).toHaveText(/^Next recorded hatch in \d+:\d\d$/);
  await expect(pageB.getByTestId('hatch-again')).toBeDisabled();
  await pageB.getByTestId('practice-again').click();
  await waitPlaying(pageB);
  expect((await state(pageB)).life.status).toBe('practice');
  await expect(pageB.getByTestId('practice-badge')).toBeVisible();

  // History lists the three lives, newest first.
  await pageB.reload();
  await pageB.waitForFunction(() => window.__bs?.ready === true);
  const rows = pageB.locator('[data-testid="history-list"] .history-name');
  await expect(rows).toHaveCount(3);
  await expect.poll(() => rows.allTextContents()).toEqual([...species].reverse());
  await expect(pageB.getByTestId('history-empty')).toBeHidden();

  // The queue: the authority has two seats. B holds one, C the other, D waits.
  await pageB.waitForFunction(() => window.__bs?.state().net.status === 'online');
  const c = await browser.newContext();
  const pageC = await c.newPage();
  await openRecorded(pageC, '', HUB);
  await pageC.waitForFunction(() => window.__bs?.state().net.status === 'online');
  const d = await browser.newContext();
  const pageD = await d.newPage();
  await openRecorded(pageD, '', HUB);
  await pageD.waitForFunction(
    () => window.__bs?.state().net.text === 'Waiting for a place (1st in line)',
  );
  expect((await state(pageD)).screen).toBe('title');
  await c.close();
  await pageD.waitForFunction(() => window.__bs?.state().net.status === 'online', undefined, {
    timeout: 30_000,
  });
  await clickHatch(pageD);
  await waitPlaying(pageD);
  await b.close();
  await d.close();
});

import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, openRecorded, state, waitPlaying } from './helpers';

// A recorded creature survives a closed tab (M4 T9): same creature, same body, its condition and
// its life clock as the hub last took them, and no time counted for the time away.

test.describe.configure({ mode: 'serial' });

test('closing the tab and coming back resumes the same creature @slow', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await openRecorded(first);
  await clickHatch(first);
  await waitPlaying(first);

  // Feed it, then run the sim fast: a progress report goes out every 30 s of play.
  await first.evaluate(async () => {
    const bs = window.__bs as BsHook;
    for (let i = 0; i < 2; i++) {
      const food = bs.debug?.nearestFood();
      if (food) await bs.debug?.steerTo(food);
    }
    bs.debug?.timeScale(30);
  });
  // Back to real time in the same breath as the first ack is seen, so no second report (due 30 s of
  // sim later, one second away at this speed) can land before the tab closes.
  await first.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      if (bs.state().life.lastAckN < 1) return false;
      bs.debug?.timeScale(1);
      return true;
    },
    undefined,
    { timeout: 20_000 },
  );
  await first.waitForTimeout(300);
  const before = await state(first);
  expect(before.life.activeMs).toBeGreaterThan(0);
  // The condition in the report the hub took; the creature has changed since (it feeds and burns).
  const ackedBiomass = before.life.ackedBiomass;
  expect(ackedBiomass).toBeGreaterThan(0);
  await first.close();

  // Time away is not life: the same clock comes back after a pause.
  await new Promise((r) => setTimeout(r, 4000));
  const second = await context.newPage();
  await openRecorded(second);
  await clickHatch(second);
  await waitPlaying(second);
  const after = await state(second);
  expect(after.life.status).toBe('playing');
  expect(after.life.creature).toBe(before.life.creature);
  expect(after.player?.genomeHash).toBe(before.player?.genomeHash);
  expect(after.life.activeMs).toBe(before.life.activeMs);
  // The hub held the condition it clamped from the last report: never more than was reported.
  expect(after.player?.biomass).toBeGreaterThan(0);
  expect(after.player?.biomass).toBeLessThanOrEqual(ackedBiomass + 0.01);
  await context.close();
});

test('a second tab with the same identity takes over, and the first stops', async ({ browser }) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await openRecorded(first);
  await clickHatch(first);
  await waitPlaying(first);
  const before = await state(first);

  const second = await context.newPage();
  await openRecorded(second);
  await first.waitForFunction(() => window.__bs?.state().net.status === 'replaced');
  expect((await state(first)).net.text).toBe('Playing in another tab');

  // The second tab picks up the creature the first one was playing.
  await clickHatch(second);
  await waitPlaying(second);
  const after = await state(second);
  expect(after.life.creature).toBe(before.life.creature);
  // And the first tab does not come back on its own.
  await first.waitForTimeout(2500);
  expect((await state(first)).net.status).toBe('replaced');
  await context.close();
});

test('a death ends the creature: even after a reload the next hatch is a new genesis @slow', async ({
  browser,
}) => {
  const context = await browser.newContext();
  const first = await context.newPage();
  await openRecorded(first);
  await clickHatch(first);
  await waitPlaying(first);
  const before = await state(first);

  await first.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.setEnergy(0);
    bs.debug?.timeScale(10);
  });
  await first.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 20_000,
  });
  expect((await state(first)).death?.cause).toBe('starved');
  expect((await state(first)).life.status).toBe('dead');
  await first.close();

  const second = await context.newPage();
  await openRecorded(second);
  expect((await state(second)).screen).toBe('title');
  await clickHatch(second);
  await waitPlaying(second);
  const after = await state(second);
  expect(after.life.status).toBe('playing');
  expect(after.life.creature).not.toBe(before.life.creature);
  expect(after.player?.genomeHash).not.toBe(before.player?.genomeHash);
  await context.close();
});

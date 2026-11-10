import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M6C_EGG_HUB, openRecorded, state, waitPlaying } from './helpers';
import { decodePng } from './look-metrics';

// The egg reveal as a still scene with clicks that matter (M6c T11): from the egg's arrival until
// its burst, the camera holds on it, the water's clock pauses and the rest dims; each poke charges
// the show, and after the beacon the player cracks the egg (or it cracks by itself after 6 s). The
// child is the beacon's whatever the player does: the card shows the recorded child's tier.

test.describe.configure({ mode: 'serial' });

/** Hatches from the title screen, the cursor parked in a corner, and waits for the egg. */
async function hatchEgg(page: Page): Promise<void> {
  await clickHatch(page);
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting', undefined, {
    timeout: 10_000,
  });
}

/** Mean absolute difference (0-255 levels, over R, G and B) between two shots of one patch. */
function meanDiff(a: { rgba: ArrayLike<number> }, b: { rgba: ArrayLike<number> }): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < a.rgba.length; i += 4) {
    for (let k = 0; k < 3; k++) sum += Math.abs((a.rgba[i + k] ?? 0) - (b.rgba[i + k] ?? 0));
    n += 3;
  }
  return sum / n;
}

/**
 * Twelve pokes, 260 ms of the egg's clock apart (never three within 0.5 s), on the egg as soon as it
 * stirs. The world freezes in the same task and the egg's clock is set for each poke, so the pokes
 * play on that clock and not on the page's: a slow page can neither stretch the gaps into the
 * egg's own 6 s wait (which cracks it and ends the charge) nor squeeze three into half a second.
 */
interface Charged {
  charge: number;
  phase: string;
  hint: string;
  ticks: number;
}

async function chargeFull(page: Page): Promise<Charged> {
  return page.evaluate(
    () =>
      new Promise<Charged>((resolve) => {
        const bs = window.__bs as BsHook;
        const canvas = document.getElementById('scene') as HTMLCanvasElement;
        // On the egg at the screen's centre.
        const where = {
          button: 0,
          clientX: innerWidth / 2,
          clientY: innerHeight / 2,
          bubbles: true,
        };
        const look = setInterval(() => {
          const { phase, paced, beaconAt } = bs.state().egg;
          if (phase !== 'stirring' || !paced) return;
          clearInterval(look);
          bs.debug?.timeScale(0);
          for (let k = 0; k < 12; k++) {
            bs.debug?.setClock(((beaconAt ?? 0) + 100 + k * 260) / 1000);
            canvas.dispatchEvent(new PointerEvent('pointerdown', where));
            dispatchEvent(new PointerEvent('pointerup', where));
          }
          const { egg, audio } = bs.state();
          const { charge, phase: after, hint } = egg;
          resolve({ charge, phase: after, hint: String(hint), ticks: audio.cues.charge ?? 0 });
        }, 10);
      }),
  );
}

/** The player charges the egg full during the paced crack, then cracks it with Enter. */
async function charged(browser: Browser): Promise<void> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6C_EGG_HUB);
  const pokes = chargeFull(page);
  await hatchEgg(page);
  const after = await pokes;
  // Held still, fully charged: the full ring, the cracks, the last sparks and the settled hint.
  await page.screenshot({ path: 'test-results/m6c-egg-charged.png' });
  // Then Enter cracks it.
  await page.evaluate(() => {
    (window.__bs as BsHook).debug?.timeScale(1);
    dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
  });
  expect(after.charge).toBe(1);
  // Each poke ticked; paced pokes never crack it: it still waited for the player.
  expect(after.ticks).toBe(12);
  expect(after.phase).toBe('stirring');
  await waitPlaying(page, { paced: true });
  // The card stays up for 3 s: take its tier in the frame that shows it, not from a later read.
  const shownCard = await page.waitForFunction(
    () => {
      const card = window.__bs?.state().egg.card;
      return card?.shown ? { tier: card.tier } : false;
    },
    undefined,
    { timeout: 10_000 },
  );
  const { tier: cardTier } = (await shownCard.jsonValue()) as { tier: string | null };
  const s = await state(page);
  expect(s.egg.crackedBy).toBe('player');
  expect(s.egg.charge).toBe(1);
  // The show was charged, the child was not: the hint and the card show the recorded child's tier.
  const recorded = await page.evaluate(() => (window.__bs as BsHook).life.recompute());
  expect(s.player?.genomeHash).toBe(recorded?.genomeHash);
  expect(cardTier).toBe(s.player?.rarity);
  expect(after.hint === 'cycling' || after.hint === s.player?.rarity).toBe(true);
  expect(s.egg.hint).toBe(s.player?.rarity);
  // A full charge's burst adds its shockwave.
  const fx = await page.evaluate(() => (window.__bs as BsHook).render.fx());
  expect(fx.shockwaves).toBe(1);
  await page.context().close();
}

/** With no input the egg cracks by itself 6 s after the beacon, and play begins. */
async function untouched(browser: Browser): Promise<void> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6C_EGG_HUB);
  await hatchEgg(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'stirring', undefined, {
    timeout: 15_000,
  });
  const stirring = await state(page);
  await page.screenshot({ path: 'test-results/m6c-egg-stirring.png' });
  expect(stirring.egg.paced).toBe(true);
  expect(stirring.egg.still).toBe(true);
  await waitPlaying(page, { paced: true });
  const s = await state(page);
  expect(s.egg.crackedBy).toBe('auto');
  expect(s.egg.charge).toBe(0);
  const { beaconAt, crackAt } = s.egg;
  // Timed on the egg's own clock, so a slow page does not stretch it.
  expect((crackAt ?? Number.NaN) - (beaconAt ?? Number.NaN)).toBeLessThanOrEqual(6500);
  expect((crackAt ?? Number.NaN) - (beaconAt ?? Number.NaN)).toBeGreaterThanOrEqual(5900);
  await page.context().close();
}

test('clicks charge the egg, the player or its 6 s wait cracks it, and the card shows the recorded tier', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  await Promise.all([charged(browser), untouched(browser)]);
});

test('after a death while moving, the reveal holds a still scene @slow', async ({ browser }) => {
  test.setTimeout(90_000);
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6C_EGG_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  // Swim, and starve while swimming: the camera follows the body as it drifts and dissolves.
  await page.keyboard.down('d');
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.setEnergy(0);
    bs.debug?.timeScale(30);
  });
  await page.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
    timeout: 30_000,
  });
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
  await page.keyboard.up('d');
  await expect(page.getByTestId('hatch-again')).toBeVisible();
  await page.getByTestId('hatch-again').click();
  await page.mouse.move(2, 2);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  // Once the death screen has stepped aside and the scene has dimmed (0.35 s each).
  await expect(page.getByTestId('hatch-again')).toBeHidden();
  await page.waitForFunction(() => window.__bs?.state().egg.dim === 1, undefined, {
    timeout: 5_000,
  });
  const viewport = page.viewportSize() ?? { width: 960, height: 540 };
  // Two patches in the corners, away from the egg at the centre.
  const patches = [
    { x: 24, y: 24, width: 160, height: 100 },
    { x: viewport.width - 184, y: viewport.height - 124, width: 160, height: 100 },
  ];
  const shoot = () =>
    Promise.all(
      patches.map((clip) => page.screenshot({ clip }).then((png) => decodePng(page, png))),
    );
  const first = await shoot();
  const before = await state(page);
  expect(before.egg.still).toBe(true);
  expect((await page.evaluate(() => (window.__bs as BsHook).render.info())).veil).toBeCloseTo(
    0.35,
    6,
  );
  // 2 s of the reveal, by the egg's clock (the beacon may come meanwhile; the crack waits 6 s).
  const from = await page.evaluate(() => performance.now());
  await page.waitForFunction((t) => performance.now() - t >= 2000, from, { timeout: 10_000 });
  const second = await shoot();
  expect((await state(page)).egg.still, 'still the reveal').toBe(true);
  for (let i = 0; i < patches.length; i++) {
    expect(
      meanDiff(first[i] as { rgba: Uint8Array }, second[i] as { rgba: Uint8Array }),
    ).toBeLessThan(1);
  }
  await page.screenshot({ path: 'test-results/m6c-egg-still.png' });
  await page.context().close();
});

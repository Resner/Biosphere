import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, openGame, state } from './helpers';

// Event sounds in the running game (M6 T23): what the player does and suffers asks for its cue,
// counted in `state().audio.cues` (audible or not), and a peer's ping is placed by its position.

const cues = async (page: Page) => (await state(page)).audio.cues;

test('eating plays the bubble pop', async ({ page }) => {
  await openGame(page, '?debug=1&seed=cues-eat');
  await hatch(page);
  expect((await cues(page)).eat ?? 0).toBe(0);
  const reached = await page.evaluate(async () => {
    const bs = window.__bs as BsHook;
    const food = bs.debug?.nearestFood();
    if (!food) throw new Error('no food near the player');
    return bs.debug?.steerTo(food);
  });
  expect(reached).toBe(true);
  const events = await page.evaluate(() => (window.__bs as BsHook).events());
  expect((await cues(page)).eat).toBe(events.eat);
});

test('a plume hurts with a dull hit, warns as it nears, and poisoning ends in the death tone', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=cues-plume');
  await hatch(page);
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    const { x, y } = bs.state().player ?? { x: 0, y: 0 };
    bs.debug?.spawnPlume(x, y, 200);
  });
  await expect.poll(async () => (await cues(page)).hurt ?? 0).toBeGreaterThan(0);
  const first = await cues(page);
  expect(first['hazard-near']).toBe(1);
  // The hit repeats slowly while the poison lasts, not every tick.
  const hits = (await page.evaluate(() => (window.__bs as BsHook).events())).damage ?? 0;
  expect(first.hurt ?? 0).toBeLessThan(Math.max(2, hits));
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(4));
  await expect(page.getByTestId('death-cause')).toHaveText('Poisoned', { timeout: 15_000 });
  expect((await cues(page)).death).toBe(1);
});

test('growing swells softly, and a new size tier swells bigger', async ({ page }) => {
  await openGame(page, '?debug=1&seed=cues-grow');
  await hatch(page);
  await page.evaluate(() => window.__bs?.debug?.setBiomass(250));
  await expect.poll(async () => (await cues(page)).grow ?? 0).toBeGreaterThan(0);
  // Tier 1 begins at a radius of 32 (biomass 1,024).
  await page.evaluate(() => window.__bs?.debug?.setBiomass(1100));
  await expect.poll(async () => (await cues(page)).tier ?? 0).toBe(1);
});

test('a starved death plays the death tone, after the low-energy pulse', async ({ page }) => {
  await openGame(page, '?debug=1&seed=cues-starve');
  await hatch(page);
  await page.evaluate(() => {
    window.__bs?.debug?.setEnergy(0);
    window.__bs?.debug?.timeScale(4);
  });
  await expect(page.getByTestId('death-cause')).toHaveText('Starved', { timeout: 25_000 });
  const heard = await cues(page);
  expect(heard.death).toBe(1);
  expect(heard['low-energy'] ?? 0).toBeGreaterThan(0);
  expect(heard.hurt ?? 0).toBeGreaterThan(0);
});

test("a peer's ping plays where it lands: panned to its side, quieter far away", async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=cues-ping');
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  const me = (await state(page)).player;
  if (!me) throw new Error('no player');
  // Half the screen's width, in world units: halfway from the centre to the right edge.
  const { halfHeight } = await page.evaluate(() => (window.__bs as BsHook).render.fx());
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  const half = (halfHeight * width) / height / 2;
  await page.evaluate(
    ({ x, y, half }) =>
      (window.__bs as BsHook).debug?.setRemotes([{ id: 'peer', name: 'Peer', x: x + half, y }]),
    { x: me.x, y: me.y, half },
  );
  await page.waitForFunction(() => window.__bs?.state().remotes.length === 1);
  const ping = (dx: number, dy: number) =>
    page.evaluate(
      ({ x, y }) => (window.__bs as BsHook).debug?.deliver('peer', { t: 'ping', kind: 1, x, y }),
      { x: me.x + dx, y: me.y + dy },
    );
  await ping(half, 0);
  await expect.poll(async () => (await cues(page)).ping ?? 0).toBe(1);
  const near = (await state(page)).audio.placed;
  expect(near?.cue).toBe('ping');
  expect(near?.pan ?? 0).toBeGreaterThan(0.3);

  // The peer's rate limit allows one ping a second.
  await page.waitForTimeout(1100);
  await ping(-half * 8, 0);
  await expect.poll(async () => (await cues(page)).ping ?? 0).toBe(2);
  const far = (await state(page)).audio.placed;
  expect(far?.pan ?? 0).toBeLessThan(-0.3);
  expect(far?.gain ?? 1).toBeLessThan((near?.gain ?? 0) * 0.5);

  // An emote plays over the peer's creature, to the right.
  await page.evaluate(() => (window.__bs as BsHook).debug?.deliver('peer', { t: 'emote', id: 2 }));
  await expect.poll(async () => (await cues(page)).emote ?? 0).toBe(1);
  expect((await state(page)).audio.placed?.pan ?? 0).toBeGreaterThan(0.3);
});

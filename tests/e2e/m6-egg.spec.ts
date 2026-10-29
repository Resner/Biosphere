import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import {
  clickHatch,
  goTo,
  hatch,
  M6_EGG_HUB,
  openGame,
  openRecorded,
  playerOf,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The egg (M6 T20): a genesis shows the reveal's phases in order; peers see a carried egg through
// the snapshot's egg mark; after a mating both players see both eggs, and H hatches the child out
// of the shell while the parent dissolves where it stood.

test.describe.configure({ mode: 'serial' });

const info = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

test('a genesis egg waits for the beacon, cracks and bursts, and the creature grows out', async ({
  browser,
}) => {
  test.setTimeout(45_000);
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M6_EGG_HUB);
  expect((await state(page)).egg).toMatchObject({ phase: 'none', carried: false, shown: false });
  await clickHatch(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  const waiting = await state(page);
  expect(waiting.screen).toBe('title');
  expect(waiting.egg.shown).toBe(true);
  expect(waiting.egg.motion).toBe('shake');
  expect((await info(page)).eggs).toBe(1);
  await page.screenshot({ path: 'test-results/m6-egg-waiting.png' });

  await waitPlaying(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 10_000,
  });
  expect((await state(page)).egg.phases).toEqual(['waiting', 'cracking', 'revealed']);
  expect((await page.evaluate(() => (window.__bs as BsHook).render.fx())).bursts).toBe(1);
  // The burst plays out, and nothing of the shell stays.
  await page.waitForFunction(() => window.__bs?.render.info().eggs === 0, undefined, {
    timeout: 5_000,
  });
  const after = await state(page);
  expect(after.egg).toMatchObject({ carried: false, shown: false });
  expect(after.player?.alive).toBe(true);
  await page.context().close();
});

test('reduced motion fades the waiting egg instead of shaking it', async ({ browser }) => {
  test.setTimeout(45_000);
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const page = await context.newPage();
  await openRecorded(page, '', M6_EGG_HUB);
  await clickHatch(page);
  await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
  expect((await state(page)).egg.motion).toBe('fade');
  await waitPlaying(page);
  await context.close();
});

test("a peer's egg mark shows its egg on a tether", async ({ page }) => {
  await openGame(page, '?debug=1');
  await hatch(page);
  const me = await playerOf(page);
  await page.evaluate(
    ([x, y]) =>
      (window.__bs as BsHook).debug?.setRemotes([
        { id: 'peer', name: 'Peer', x, y, egg: true },
        { id: 'plain', name: 'Plain', x, y: y + 40 },
      ]),
    [me.x + 50, me.y] as const,
  );
  await page.waitForFunction(() => window.__bs?.state().egg.peers.length === 1);
  const s = await state(page);
  expect(s.egg.peers).toEqual(['peer']);
  expect(s.remotes.find((r) => r.id === 'peer')?.egg).toBe(true);
  expect(s.remotes.find((r) => r.id === 'plain')?.egg).toBe(false);
  expect((await info(page)).eggs).toBe(1);
  // Our own creature carries none.
  expect(s.egg).toMatchObject({ carried: false, shown: false });
});

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', M6_EGG_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

test('after a mating both eggs show to both players, and H hatches the child out of its egg @slow', async ({
  browser,
}) => {
  test.setTimeout(150_000);
  const [a, b] = await Promise.all([
    hatched(await browser.newContext()),
    hatched(await browser.newContext()),
  ]);
  await Promise.all([ripe(a), ripe(b)]);
  const idA = (await state(a)).playerId as string;
  const idB = (await state(b)).playerId as string;
  await Promise.all([topUp(a), topUp(b)]);
  const before = (await playerOf(a)).biomass;
  // The first press may land before the hub has answered the check, and on a loaded runner the
  // two drift apart again: park A beside B and press until B is invited.
  await expect(async () => {
    await goTo(a, idB);
    await expect(a.getByTestId('mate-hint')).toHaveText(/^E: court /, { timeout: 3_000 });
    await a.keyboard.press('e');
    await expect(b.getByTestId('invite')).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 40_000 });
  await b.keyboard.press('e');

  // The commitment: each body shrinks with a pulse and the egg waits beside it.
  for (const page of [a, b]) {
    await page.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting', undefined, {
      timeout: 20_000,
    });
    expect((await page.evaluate(() => (window.__bs as BsHook).render.fx())).cost).toBe(1);
  }
  expect((await playerOf(a)).biomass).toBeLessThan(before);
  await a.screenshot({ path: 'test-results/m6-egg-mate-waiting.png' });

  // The beacon: each egg cracks, bursts and is then carried, with the card beside it.
  for (const page of [a, b]) {
    await page.waitForFunction(
      () => {
        const egg = window.__bs?.state().egg;
        return egg?.phase === 'revealed' && egg.carried;
      },
      undefined,
      { timeout: 40_000 },
    );
    expect((await state(page)).egg.phases.slice(-3)).toEqual(['waiting', 'cracking', 'revealed']);
    await expect(page.getByTestId('offspring')).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId('hud-egg')).toHaveText('Egg: H to hatch');
  }
  // Both eggs are visible to the other player, through the snapshot's egg mark.
  for (const [page, other] of [
    [a, idB],
    [b, idA],
  ] as const) {
    await page.waitForFunction((id) => window.__bs?.state().egg.peers.includes(id), other, {
      timeout: 10_000,
    });
    expect((await state(page)).egg.shown).toBe(true);
    expect((await info(page)).eggs).toBe(2);
  }
  await a.screenshot({ path: 'test-results/m6-egg-carried.png' });

  // H: the egg cracks open, the child grows out of it and the parent dissolves where it stood.
  const child = (await state(a)).offspring.creature;
  // Watch every frame from the key press on: the parent must be drawn dissolving, then be gone.
  const ghost = a.evaluate(
    () =>
      new Promise<boolean>((resolve) => {
        let seen = false;
        const started = performance.now();
        const look = () => {
          seen ||= window.__bs?.state().egg.ghost === true;
          if (performance.now() - started > 8_000) resolve(seen);
          else requestAnimationFrame(look);
        };
        look();
      }),
  );
  await a.keyboard.press('h');
  await a.waitForFunction((id) => window.__bs?.state().life.creature === id, child, {
    timeout: 20_000,
  });
  expect((await state(a)).egg.carried).toBe(false);
  await a.waitForFunction(() => window.__bs?.state().egg.phase === 'revealed', undefined, {
    timeout: 5_000,
  });
  expect((await state(a)).egg.phases.slice(-2)).toEqual(['cracking', 'revealed']);
  await a.screenshot({ path: 'test-results/m6-egg-hatch.png' });
  expect(await ghost).toBe(true);
  // Within a second and a bit the parent is gone: B's body is the only other one drawn.
  await a.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      return !bs.state().egg.ghost && bs.render.info().remoteBodies <= 1;
    },
    undefined,
    { timeout: 3_000 },
  );
  expect((await state(a)).egg.shown).toBe(false);
  await expect(a.getByTestId('hud-egg')).toBeHidden();
  // B sees A's egg go.
  await b.waitForFunction((id) => !window.__bs?.state().egg.peers.includes(id), idA, {
    timeout: 10_000,
  });
  await a.context().close();
  await b.context().close();
});

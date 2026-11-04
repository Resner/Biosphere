import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M8_PROXY_HUB, openRecorded, state, waitPlaying } from './helpers';
import { open, seen, stage } from './m7-fight';
import { chase, engage, flee, waitOver, watched, watchFrom } from './m8-fight';

// Away fighters stay visible (M8 T11): A engages B while C watches from beside B, and B's page
// closes. B's autopilot fights on. A still draws B from its fight, faded and marked away, and C
// sees B by proxy (A relays B's pose): moving, away, and never offered for an attack. A swims off,
// and A's hash equals the referee's. A fight can end before B's page closes or before C sees the
// proxy, so B opens again in the same browser and A engages again, at most 3 times.

test.describe.configure({ mode: 'serial' });

type Ids = { idA: string; idB: string };

/** B's page again, in its own browser context (its identity), back on the title and then playing. */
async function reopen(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=low', M8_PROXY_HUB);
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

/**
 * One try: A engages B, C watches, and B's page closes right after `enc-start`. The fight's id once
 * A draws B away and C has seen it move by proxy, else null (the fight ended first).
 */
async function tryAway(a: Page, b: Page, c: Page, ids: Ids, previous?: string) {
  const id = await engage(a, ids, previous);
  await chase(a, ids.idB);
  await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, id, {
    timeout: 5_000,
  });
  await watchFrom(c, ids.idB);
  await b.close();

  const over = async () => {
    const enc = (await state(a)).encounter;
    return enc?.id !== id || enc.over;
  };
  // A draws B from its fight, away: faded, named "away", and so in its encounter view.
  await expect
    .poll(
      async () => {
        if (await over()) return 'over';
        const s = await state(a);
        const drawn = s.remotes.find((r) => r.id === ids.idB);
        const fighter = s.encounter?.fighters.find((f) => f.player === ids.idB);
        return drawn?.away && fighter?.away && drawn.alpha <= 0.6 ? 'away' : 'waiting';
      },
      { message: 'A draws B away, or the fight ends', timeout: 20_000 },
    )
    .not.toBe('waiting');
  if (await over()) return null;
  await expect(a.locator('.remote-label', { hasText: 'away' })).toHaveCount(1);

  // C sees B by proxy: drawn away, moving between frames.
  await expect
    .poll(
      async () => {
        if (await over()) return 'over';
        const seenC = await watched(c);
        return seenC.away >= 10 && seenC.moves >= 3 ? 'moving' : 'waiting';
      },
      { message: 'C sees B move by proxy, or the fight ends', timeout: 20_000 },
    )
    .not.toBe('waiting')
    .catch(async (error) => {
      throw new Error(`C never saw B by proxy: ${JSON.stringify(await seen(c))}`, {
        cause: error,
      });
    });
  return (await over()) ? null : id;
}

test('an away fighter fights on: its opponent draws it faded and a spectator sees it by proxy @slow', async ({
  browser,
}) => {
  test.setTimeout(420_000);
  const [a, b, c] = await Promise.all([
    open(browser, M8_PROXY_HUB),
    open(browser, M8_PROXY_HUB),
    open(browser, M8_PROXY_HUB),
  ]);
  const contextB = b.context();
  try {
    await clickHatch(c);
    await waitPlaying(c);
    // B stays whole: a healthy starter neither flees nor dies soon on its autopilot.
    const ids = await stage(a, b, undefined, 1);
    let pageB = b;
    let id: string | null = null;
    let previous: string | undefined;
    for (let attempt = 0; attempt < 3 && id === null; attempt++) {
      if (previous) {
        await waitOver(a, previous, 'A');
        pageB = await reopen(contextB);
        await a.waitForFunction(
          (who) => window.__bs?.state().remotes.some((r) => r.id === who && !r.away),
          ids.idB,
          { timeout: 20_000 },
        );
      }
      id = await tryAway(a, pageB, c, ids, previous);
      previous = (await state(a)).encounter?.id;
    }
    if (!id)
      throw new Error(`B was never away in a running fight: ${JSON.stringify(await seen(a))}`);

    // The look, for the record: A's picture with B faded and named away.
    await a.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(false));
    await a.waitForFunction(() => (window.__bs as BsHook).render.info().calls > 0);
    await test.info().attach('away-fighter', {
      body: await a.screenshot(),
      contentType: 'image/png',
    });
    await a.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));

    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    const end = (await state(a)).encounter;
    expect(end?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(end?.hash).toBe(end?.endHash);
    expect(end?.desyncs).toBe(0);

    // Away on C until the end, never back and never offered for an attack, at most 60% opaque.
    const seenC = await watched(c);
    expect(seenC.back).toBe(0);
    expect(seenC.offered).toBe(false);
    expect(seenC.alpha).toBeGreaterThan(0);
    expect(seenC.alpha).toBeLessThanOrEqual(0.6);
    // After the end the proxies stop, and B fades out of C's pond.
    await c.waitForFunction(
      (who) => !window.__bs?.state().remotes.some((r) => r.id === who),
      ids.idB,
      { timeout: 20_000 },
    );
  } finally {
    await Promise.all([a.context().close(), contextB.close(), c.context().close()]);
  }
});

import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { slotAnchor } from '../../src/sim/food';
import { createWorld } from '../../src/sim/world';
import { hatch, openGame } from './helpers';

// Two tabs share one pond seed and clock; their food claims are relayed by the test (the hub and
// mesh arrive with the online session). The real claim book, codec validation and sim run in both.

const SEED = 'shared-food';

async function joinedTab(browser: Browser) {
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  await openGame(page, `?debug=1&seed=${SEED}`);
  return { page, context };
}

/** Connects two pages: what one sends, the other receives, as a data channel would deliver it. */
async function link(a: Page, b: Page, ids: { a: string; b: string }): Promise<void> {
  await a.exposeFunction('relayOut', (event: unknown) =>
    b.evaluate(
      ([from, e]) => (window.__bs as BsHook).debug?.deliver(from as string, e),
      [ids.a, event],
    ),
  );
  await b.exposeFunction('relayOut', (event: unknown) =>
    a.evaluate(
      ([from, e]) => (window.__bs as BsHook).debug?.deliver(from as string, e),
      [ids.b, event],
    ),
  );
}

async function join(page: Page, epoch: number): Promise<void> {
  const hubNow = Date.now();
  await page.evaluate(
    ({ epoch, hubNow, seed }) => {
      const bs = window.__bs as BsHook;
      bs.debug?.joinPond({
        seed,
        epoch,
        hubNow,
        send: (event) => void (window as unknown as { relayOut(e: unknown): void }).relayOut(event),
      });
    },
    { epoch, hubNow, seed: SEED },
  );
}

test('an item eaten in one tab disappears for the other and respawns for both', async ({
  browser,
}) => {
  // Two software-rendered tabs on a loaded runner need more than the default 30 s.
  test.setTimeout(60_000);
  const epoch = Date.now() - 50_000;
  const [a, b] = await Promise.all([joinedTab(browser), joinedTab(browser)]);
  try {
    await link(a.page, b.page, { a: 'peer-a', b: 'peer-b' });
    await join(a.page, epoch);
    await join(b.page, epoch);
    await hatch(a.page);
    await hatch(b.page);

    // Same pond seed and clock: both tabs hatched at the same tick, on the same spot.
    const [tickA, tickB] = await Promise.all(
      [a.page, b.page].map((p) => p.evaluate(() => (window.__bs as BsHook).state().tick)),
    );
    expect(Math.abs((tickA ?? 0) - (tickB ?? 0))).toBeLessThanOrEqual(30);

    // Freeze both sims while the item is picked and B is checked: a cell hatched beside the item
    // would otherwise eat it, or grow out of "full", between two steps of this test. Then A goes
    // hungry and steers to it in one synchronous step; B resumes once A has eaten.
    for (const { page } of [a, b]) {
      await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
    }
    const item = await a.page.evaluate(() => (window.__bs as BsHook).debug?.nearestFood());
    expect(item).toBeTruthy();
    const id = item?.id as string;
    const m = /^c(\d+)_(\d+)_s(\d+)_k0$/.exec(id);
    expect(m).toBeTruthy();
    await b.page.waitForFunction((id) => (window.__bs as BsHook).debug?.hasFood(id) === true, id);

    const reached = await a.page.evaluate((item) => {
      const debug = (window.__bs as BsHook).debug;
      debug?.setEnergy(10);
      debug?.timeScale(1);
      return debug?.steerTo(item as { id: string; x: number; y: number });
    }, item);
    expect(reached).toBe(true);
    await b.page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    await b.page.waitForFunction((id) => (window.__bs as BsHook).debug?.hasFood(id) === false, id, {
      timeout: 2000,
    });

    // Park both tabs full (a full cell does not eat) beside the slot's next item, then fast-forward.
    const [cx, cy, slot] = [Number(m?.[1]), Number(m?.[2]), Number(m?.[3])] as const;
    const anchor = slotAnchor(createWorld({ seed: SEED }), cx, cy, slot, 1);
    for (const { page } of [a, b]) {
      await page.evaluate(({ x, y }) => {
        const debug = (window.__bs as BsHook).debug;
        debug?.setEnergy(1e9);
        debug?.teleport(x + 80, y);
        debug?.timeScale(30);
      }, anchor);
    }
    const next = `c${cx}_${cy}_s${slot}_k1`;
    for (const { page } of [a, b]) {
      await page.waitForFunction(
        (next) => (window.__bs as BsHook).debug?.hasFood(next) === true,
        next,
        { timeout: 15_000 },
      );
    }
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

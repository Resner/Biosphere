import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, goTo, M5_HUB, openRecorded, ripe, state, topUp, waitPlaying } from './helpers';

// Courting (M5 T10) on an authority with lives of about 4 min and maturity in seconds: one player
// courts another in reach, the other accepts, both pay and wait for the round. A third, newly
// hatched creature is not mature, and the HUD says so.

test.describe.configure({ mode: 'serial' });

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', M5_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

const idOf = async (page: Page): Promise<string> => (await state(page)).playerId as string;

test('a court is answered, both pay, and a newborn is refused for being too young @slow', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const ctxC = await browser.newContext();
  const [a, b] = await Promise.all([hatched(ctxA), hatched(ctxB)]);
  await Promise.all([ripe(a), ripe(b)]);
  const [idB, idA] = [await idOf(b), await idOf(a)];

  // A third creature has not been reported yet: the hub counts it as not mature.
  const c = await hatched(ctxC);
  await goTo(a, await idOf(c));
  await expect(a.getByTestId('mate-hint')).toContainText('Not mature yet');
  await a.keyboard.press('e');
  await expect(a.getByTestId('mate-hint')).toContainText('Not mature yet');
  expect((await state(a)).mate.visited).not.toContain('courting');
  await a.screenshot({ path: 'test-results/m5-court-refused.png' });

  // A and B in reach: the hint offers the key, B sees the invitation.
  await goTo(a, idB);
  await expect(a.getByTestId('mate-hint')).toHaveText(/^E: court /);
  await expect(a.getByTestId('hud-ready')).toHaveText('Ready to mate');
  await Promise.all([topUp(a), topUp(b)]);
  const before = {
    a: (await state(a)).player,
    b: (await state(b)).player,
  };
  await a.keyboard.press('e');
  await a.keyboard.press('e');
  await expect(b.getByTestId('invite')).toBeVisible();
  const s = await state(b);
  expect(s.mate.invite?.from).toBe(idA);
  await expect(b.getByTestId('invite-band')).not.toBeEmpty();
  await expect(b.getByTestId('invite-left')).toHaveText(/^\d+ s$/);
  await b.screenshot({ path: 'test-results/m5-court-invite.png' });
  await b.keyboard.press('e');

  for (const page of [a, b]) {
    await page.waitForFunction(
      () => window.__bs?.state().mate.visited.includes('awaiting') === true,
      undefined,
      { timeout: 20_000 },
    );
  }
  const after = { a: (await state(a)).player, b: (await state(b)).player };
  for (const key of ['a', 'b'] as const) {
    const was = before[key];
    const now = after[key];
    expect(now?.biomass).toBeLessThan((was?.biomass ?? 0) * 0.92);
    expect(now?.biomass).toBeGreaterThan((was?.biomass ?? 0) * 0.8);
    expect((now?.energy ?? 0) / (was?.energy ?? 1)).toBeLessThan(0.8);
    expect((now?.energy ?? 0) / (was?.energy ?? 1)).toBeGreaterThan(0.6);
  }
  // One court, and the hub's cooldown reached both (it is only 3.6 s here, so the line may have run out).
  expect((await state(a)).mate.visited.filter((v) => v === 'courting')).toHaveLength(1);
  for (const page of [a, b]) expect((await state(page)).life.cooldownUntilMs).toBeGreaterThan(0);
  await expect(a.getByTestId('hud-ready')).toHaveText(/^Ready (in \d+:\d\d|to mate)$/);
  await a.screenshot({ path: 'test-results/m5-court-paid.png' });
  await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()]);
});

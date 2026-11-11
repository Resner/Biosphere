import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import {
  clickHatch,
  courtUntilInvited,
  M14_INTERRUPT_HUB,
  openRecorded,
  topUp,
  waitPlaying,
} from './helpers';
import { crash, grownUp, hold, hubIsWhole, reopen, attach as shoot } from './interrupt-kit';

// The page's kill matrix (M14 T4, ADR 0076). Each kill is a renderer crash (`Page.crash`, so nothing
// unloads and no close or `gone` is sent from the page), and each reopen is a new page in the same
// browser context: the same identity in IndexedDB, and only the hub's word on what is in flight.
// The hub (8840) runs short matings and lives; a scenario holds the recorded rounds
// (`POST /v1/e2e/beacons`) so a reopened page always finds its genesis or mating still waiting.

const HUB = M14_INTERRUPT_HUB;
const attach = (page: Page, step: string) => shoot(page, 'm14-interrupt', step);

test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', '`Page.crash` is Chromium’s');

const bs = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

/** The messages of each type the hub has taken from the player's seated session. */
async function received(request: APIRequestContext, player: string, type: string) {
  const res = await request.get(`${HUB}/v1/e2e/sessions`);
  const seated = (await res.json()) as { id: string; byType: Record<string, number> }[];
  return seated.find((s) => s.id === player)?.byType[type] ?? 0;
}

/** Waits until the hub has taken a message of `type` from the player. */
async function reached(request: APIRequestContext, player: string, type: string): Promise<void> {
  await expect
    .poll(() => received(request, player, type), { message: `the hub never took ${type}` })
    .toBeGreaterThan(0);
}

/** A recorded player of its own browser, playing a fresh genesis. */
async function joined(browser: Browser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await openRecorded(page, '', HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return { context, page };
}

test('a crashed tab resumes its genesis, its mating, its promotion, its death and its import @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(420_000);
  await hold(request, HUB, false);
  const contexts: BrowserContext[] = [];
  try {
    // Genesis: A spends its last hatch and the tab dies while the egg waits for its round.
    const ctxA = await browser.newContext();
    contexts.push(ctxA);
    let a = await ctxA.newPage();
    await openRecorded(a, '', HUB);
    const idA = (await bs(a)).playerId as string;
    await request.post(`${HUB}/v1/e2e/hatches`, { data: { player: idA, left: 1 } });
    await a.waitForFunction(() => window.__bs?.state().net.status === 'online');
    await hold(request, HUB, true);
    await clickHatch(a);
    await a.waitForFunction(() => window.__bs?.state().life.status === 'awaiting', undefined, {
      timeout: 20_000,
    });
    await crash(a);

    // Reopened: the title shows the egg (not Hatch, not the practice cell) though the bucket is empty.
    a = await reopen(ctxA, HUB);
    await a.waitForFunction(
      () => {
        const s = window.__bs?.state();
        return s?.life.inFlight.genesis !== null && s?.life.status === 'awaiting';
      },
      undefined,
      { timeout: 20_000 },
    );
    await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting');
    const waiting = await bs(a);
    expect(waiting.screen).toBe('title');
    expect(waiting.life.genesisIn).toBeGreaterThan(0);
    await expect(a.getByTestId('hatch')).toBeHidden();
    await expect(a.getByTestId('practice')).toBeHidden();
    await expect(a.getByTestId('hatch-note')).toHaveText('Awaiting beacon…');
    await attach(a, 'genesis');
    // The round comes: the reveal plays, and the creature is the one its round gives.
    await hold(request, HUB, false);
    await waitPlaying(a);
    const hatched = await bs(a);
    expect(hatched.life).toMatchObject({ status: 'playing', inFlight: { genesis: null } });
    const recomputed = await a.evaluate(() => (window.__bs as BsHook).life.recompute());
    expect(recomputed?.genomeHash).toBe(hatched.player?.genomeHash);
    const a0 = hatched.life.creature as string;
    await hubIsWhole(request, HUB);

    // Mating: A courts B, B accepts, and A's tab dies on `mating`, before `born`.
    const b = await joined(browser);
    contexts.push(b.context);
    const idB = (await bs(b.page)).playerId as string;
    await Promise.all([grownUp(a), grownUp(b.page)]);
    await Promise.all([topUp(a), topUp(b.page)]);
    await courtUntilInvited(a, b.page, idB);
    // A's world stands still and reports where it stands: the mating pays from exactly this.
    const { before, acked } = await a.evaluate(async () => {
      const b = window.__bs as BsHook;
      b.debug?.timeScale(0);
      const acked = b.state().life.lastAckN;
      await b.debug?.progressNow();
      return { before: b.state().player?.biomass ?? 0, acked };
    });
    await a.waitForFunction((n) => (window.__bs?.state().life.lastAckN ?? 0) > n, acked);
    await hold(request, HUB, true);
    await b.page.keyboard.press('e');
    await a.waitForFunction(() => window.__bs?.state().mate.state === 'awaiting', undefined, {
      timeout: 20_000,
    });
    await crash(a);

    // Reopened: the hub names the mating; A plays on having paid once, its egg waiting beside it.
    a = await reopen(ctxA, HUB);
    await a.waitForFunction(() => window.__bs?.state().life.inFlight.mating !== null, undefined, {
      timeout: 20_000,
    });
    expect((await bs(a)).mate.state).toBe('awaiting');
    await clickHatch(a);
    await waitPlaying(a);
    // The hub charged the biomass A's last report held, which is `before`. The resumed creature
    // grows with every tick it plays (a runner plays as many as its load allows), so its world
    // stands still from here: the read is the paid biomass plus a tick or two of growth.
    await a.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
    await a.waitForFunction(() => window.__bs?.state().egg.shown === true);
    const paid = await bs(a);
    expect(paid.life.creature).toBe(a0);
    // Paid once: 85% of before, then the growth of the ticks the page played on the way to its
    // egg (a second payment would leave 72%, growth included). It never reads below what was paid.
    const left = paid.player?.biomass ?? 0;
    expect(left).toBeGreaterThanOrEqual(0.85 * before - 0.5);
    expect(left).toBeLessThanOrEqual(0.92 * before);
    await a.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    await expect(a.getByTestId('mate-hint')).toHaveText('Awaiting beacon');
    await attach(a, 'mating');
    // The round comes: `born` reveals the child to both, and B never saw anything wrong.
    await hold(request, HUB, false);
    for (const page of [a, b.page]) {
      await page.waitForFunction(() => window.__bs?.state().offspring.kind === 'card', undefined, {
        timeout: 40_000,
      });
    }
    const bAfter = await bs(b.page);
    expect(bAfter.screen).toBe('playing');
    expect(bAfter.mate.visited).toContain('done');
    await hubIsWhole(request, HUB);

    // Promote: A presses H, and the tab dies once the hub has the request (its answer may or may not have come).
    const child = (await bs(a)).offspring.creature as string;
    await a.keyboard.press('h');
    await reached(request, idA, 'promote');
    await crash(a);
    a = await reopen(ctxA, HUB);
    // Lineage shows the parent once, frozen.
    await a.getByTestId('lineage-open').click();
    const chain = a.getByTestId('lineage-chain').locator('li');
    await expect(chain).toHaveCount(2, { timeout: 20_000 });
    await expect(chain.filter({ hasText: 'Frozen' })).toHaveCount(1);
    await a.getByTestId('lineage-close').click();
    await clickHatch(a);
    await waitPlaying(a);
    const promoted = await bs(a);
    expect(promoted.life.creature).toBe(child);
    expect(promoted.egg.phase).toBe('none');
    await attach(a, 'promote');
    await hubIsWhole(request, HUB);

    // Death: A starves, and the tab dies on the death screen.
    await a.evaluate(() => {
      const debug = (window.__bs as BsHook).debug;
      debug?.setEnergy(0);
      debug?.setHealth(1);
    });
    await a.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 30_000,
    });
    await crash(a);
    // Reopened: the death screen of that life, offering the ancestor.
    a = await reopen(ctxA, HUB);
    await a.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 20_000,
    });
    await expect(a.getByTestId('death-cause')).toHaveText('Starved');
    const back = a.getByTestId('death-fallback-ancestor');
    await expect(back).toBeVisible({ timeout: 20_000 });
    await attach(a, 'death');
    // A picks the ancestor, and the tab dies as soon as the hub has the request.
    await back.click();
    await reached(request, idA, 'restore');
    await crash(a);
    a = await reopen(ctxA, HUB);
    await clickHatch(a);
    await waitPlaying(a);
    expect((await bs(a)).life.creature).toBe(a0);
    await attach(a, 'restore');
    await hubIsWhole(request, HUB);

    // Import: B takes A's identity with its recovery code, and the tab dies as the import resolves.
    await a.close();
    const reader = await ctxA.newPage();
    await reader.goto('./?debug=1');
    await reader.waitForFunction(() => window.__bs?.state().playerId);
    await reader.getByTestId('recovery-open').click();
    const shown = reader.getByTestId('recovery-code');
    await shown.click();
    await expect(shown).toHaveAttribute('data-revealed', 'true');
    const code = (await shown.textContent()) ?? '';
    await reader.close();
    // The import is on the title screen. B's own tab is not used: nothing steers B's creature through
    // the minutes above, so it may have died by now (the death screen has no recovery button). A
    // browser that has never played always opens on the title.
    await b.page.close();
    const ctxC = await browser.newContext();
    contexts.push(ctxC);
    const importer = await reopen(ctxC, HUB);
    const idC = (await bs(importer)).playerId;
    expect(idC).toBeTruthy();
    expect(idC).not.toBe(idA);
    await importer.getByTestId('recovery-open').click();
    await importer.getByTestId('recovery-input').fill(code);
    await importer.getByTestId('recovery-import').click();
    // The page would reload once the code is stored: the tab dies at that moment instead (Chromium
    // won't crash a renderer with a navigation pending).
    await importer.evaluate(() => (window.__bs as BsHook).debug?.holdReload(true));
    await importer.getByTestId('recovery-yes').click();
    await importer.waitForFunction(() => window.__bs?.state().imported === true);
    await crash(importer);
    const c2 = await reopen(ctxC, HUB);
    expect((await bs(c2)).playerId).toBe(idA);
    await attach(c2, 'import');
    await hubIsWhole(request, HUB);
  } finally {
    await hold(request, HUB, false).catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
  }
});

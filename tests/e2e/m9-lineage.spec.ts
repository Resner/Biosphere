import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import {
  clickHatch,
  courtUntilInvited,
  M9_LINEAGE_HUB,
  openRecorded,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';
import { takeOver } from './m9-steps';

// The lineage viewer (M9 T13): A and B hatch, mate and both take over their children, then every
// page closes. The card of A's child draws both parents as genesis roots and the branch to A's
// genesis bold, each node verified, and a click on B's genesis node opens B's card, which verifies too.

test.describe.configure({ mode: 'serial' });
// The card is judged on its screenshot: no low preset, and the high one asked for.
test.use({ storageState: { cookies: [], origins: [] } });

const DESKTOP = { width: 1280, height: 900 };
const PHONE = { width: 390, height: 844 };

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=low', M9_LINEAGE_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

const cardUrl = (id: string): string => `./card.html?c=${id}&hub=${M9_LINEAGE_HUB}&quality=high`;
const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

async function waitDone(page: Page, what: string): Promise<CardState> {
  await page
    .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
      timeout: 30_000,
    })
    .catch(async (error) => {
      throw new Error(`${what} never finished: ${JSON.stringify(await cardState(page))}`, {
        cause: error,
      });
    });
  return cardState(page);
}

/** The id of the node that has the keyboard's focus, if any. */
const focusedNode = (page: Page): Promise<string | null> =>
  page.evaluate(
    () =>
      (document.activeElement as HTMLElement | null)?.closest<HTMLElement>('[data-node]')?.dataset
        .node ?? null,
  );

test("a child's card draws both parents and its branch, and opens an ancestor's card @slow", async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const [ctxA, ctxB] = [await browser.newContext(), await browser.newContext()];
  const [a, b] = await Promise.all([hatched(ctxA), hatched(ctxB)]);
  await Promise.all([ripe(a), ripe(b)]);
  const [a0, b0] = [(await state(a)).life.creature, (await state(b)).life.creature];
  if (!a0 || !b0) throw new Error('a player hatched no recorded creature');
  const idB = (await state(b)).playerId as string;
  await Promise.all([topUp(a), topUp(b)]);
  await courtUntilInvited(a, b, idB);
  await b.keyboard.press('e');
  const [a1] = await Promise.all([takeOver(a), takeOver(b)]);
  await Promise.all([ctxA.close(), ctxB.close()]);

  // Everyone has left. A's child's card, from a fresh browser.
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  await page.goto(cardUrl(a1));
  const s = await waitDone(page, "A's child's card");
  expect(s).toMatchObject({
    phase: 'done',
    subject: a1,
    generation: 1,
    verdict: 'verified',
    toGenesis: true,
    scaled: true,
    problems: [],
    missing: 0,
  });
  const nodes = new Map(s.graph.map((n) => [n.id, n]));
  expect(s.graph).toHaveLength(3);
  expect(nodes.get(a1)).toMatchObject({
    generation: 1,
    branch: true,
    root: false,
    verified: true,
    loaded: true,
  });
  expect(nodes.get(a0)).toMatchObject({
    generation: 0,
    branch: true,
    root: true,
    verified: true,
    loaded: true,
  });
  expect(nodes.get(b0)).toMatchObject({
    generation: 0,
    branch: false,
    root: true,
    verified: true,
    loaded: true,
  });
  // One edge from the birth to each parent; the one to A's genesis is the bold branch.
  await expect(page.getByTestId('card-lineage')).toBeVisible();
  await expect(page.getByTestId('graph-edge')).toHaveCount(2);
  await expect(page.locator('.graph-edge.branch')).toHaveCount(1);
  // A verified mark is a shape with its words, not only a colour.
  const marks = page.locator('[data-testid="graph-node"] .graph-mark');
  await expect(marks).toHaveCount(3);
  for (const mark of await marks.all()) {
    await expect(mark).toHaveText('✓');
    await expect(mark).toHaveAttribute('aria-label', 'Verified');
  }

  // The graph is reached by keyboard: Tab comes to B's genesis node.
  let reached = false;
  for (let i = 0; i < 30 && !reached; i++) {
    await page.keyboard.press('Tab');
    reached = (await focusedNode(page)) === b0;
  }
  expect(reached, "Tab reaches B's genesis node").toBe(true);
  await page.getByTestId('card-lineage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-results/m9-lineage-desktop.png', fullPage: true });
  await test.info().attach('m9-lineage-desktop', {
    path: 'test-results/m9-lineage-desktop.png',
    contentType: 'image/png',
  });

  // At phone width the graph scrolls in its own box, and the page never sideways.
  await page.setViewportSize(PHONE);
  await page.waitForFunction((w) => document.documentElement.clientWidth <= w, PHONE.width);
  const widths = await page.evaluate(() => ({
    scroll: document.documentElement.scrollWidth,
    client: document.documentElement.clientWidth,
  }));
  expect(widths.scroll).toBeLessThanOrEqual(widths.client);
  await page.screenshot({ path: 'test-results/m9-lineage-phone.png', fullPage: true });
  await test.info().attach('m9-lineage-phone', {
    path: 'test-results/m9-lineage-phone.png',
    contentType: 'image/png',
  });
  await page.setViewportSize(DESKTOP);

  // A click on B's genesis node opens its card, which verifies too.
  await page.locator(`[data-testid="graph-node"][data-node="${b0}"]`).click();
  await page.waitForURL((url) => url.searchParams.get('c') === b0);
  const t = await waitDone(page, "B's genesis card");
  expect(t).toMatchObject({
    phase: 'done',
    subject: b0,
    generation: 0,
    verdict: 'verified',
    toGenesis: true,
    scaled: true,
    problems: [],
  });
  await context.close();
});

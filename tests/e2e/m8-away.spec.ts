import { type APIRequestContext, type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { M8_AWAY_HUB, openRecorded, state } from './helpers';
import { FIGHT_WALL_MS, open, seen, stage } from './m7-fight';
import { chase, engage, flee, waitOver } from './m8-fight';

// Consequences at the next sign-in (M8 T12): a fight that ends while a player is away is settled
// by the authority (its 10 s wait is 500 ms on this hub), and the player's next sign-in tells what
// happened, once, in one plain line. The page that stayed checks the settlement itself.

test.describe.configure({ mode: 'serial' });

type Report = NonNullable<ReturnType<BsHook['state']>['report']>;
type Fighter = NonNullable<ReturnType<BsHook['state']>['encounter']>['fighters'][number];

/** Opens the game again in `page`'s browser context, so the same identity signs in. */
async function reopen(page: Page): Promise<Page> {
  const next = await page.context().newPage();
  await openRecorded(next, '&quality=low', M8_AWAY_HUB);
  return next;
}

/** The report the hub's `life` told on `page` for the fight `id`. */
async function reportOf(page: Page, id: string, who: string): Promise<Report> {
  await page
    .waitForFunction((enc) => window.__bs?.state().report?.enc === enc, id, { timeout: 20_000 })
    .catch(async (error) => {
      const s = await state(page);
      throw new Error(`${who} was never told the fight: ${JSON.stringify(s.report)} ${s.screen}`, {
        cause: error,
      });
    });
  return (await state(page)).report as Report;
}

/** The fighter's egg as the hub's `enc-end` gives it, from what the page simulated. */
const eggOf = (f: Fighter): Report['egg'] =>
  f.egg === null ? 'none' : f.egg.eaten ? 'eaten' : 'kept';

/** The name a page plays under (the title's name field, as it signed in). */
const nameOf = (page: Page) => page.getByTestId('name-input').inputValue();

/** Waits until the authority has settled the fight `id`, with nobody connected. */
async function settled(request: APIRequestContext, id: string): Promise<void> {
  await expect
    .poll(
      async () => {
        const r = await request.get(`${M8_AWAY_HUB}/v1/e2e/encounter/${id}`);
        return r.ok() ? ((await r.json()) as { settled: boolean }).settled : false;
      },
      { message: 'the authority settles the fight nobody is left in', timeout: FIGHT_WALL_MS },
    )
    .toBe(true);
}

async function players(browser: Browser): Promise<[Page, Page]> {
  return Promise.all([open(browser, M8_AWAY_HUB), open(browser, M8_AWAY_HUB)]);
}

test('B closes its page mid-fight; back after the end, it reads what happened, and A verified the settlement', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const [a, b] = await players(browser);
  let back: Page | null = null;
  try {
    // B stays whole: a healthy starter neither flees nor dies while it is away.
    const ids = await stage(a, b, undefined, 1);
    const nameA = await nameOf(a);
    const id = await engage(a, ids);
    await chase(a, ids.idB);
    await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, id, {
      timeout: 5_000,
    });
    await b.close();
    // A swims off: the fight ends by the rules (an escape, or a kill if B's autopilot strikes first).
    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    const end = (await state(a)).encounter;
    expect(end?.hash).toBe(end?.endHash);
    const foe = end?.fighters.find((f) => f.player === ids.idB) as Fighter;

    // A checked the settlement against its own frames and hash, off the frame loop.
    await a
      .waitForFunction(
        (enc) => {
          const e = window.__bs?.state().encounter;
          return e?.id === enc && e.verified !== null;
        },
        id,
        { timeout: 15_000 },
      )
      .catch(async (error) => {
        throw new Error(`A never checked the settlement: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });
    expect((await state(a)).encounter?.verified).toBe(true);

    back = await reopen(b);
    const report = await reportOf(back, id, 'B');
    expect(report.outcome).toBe(foe.outcome);
    expect(report.egg).toBe(eggOf(foe));
    if (report.outcome === 'killed') expect(report.by).toBe(nameA);
    // One plain line on the title, told once.
    const line = back.getByTestId('away-report');
    await expect(line).toBeVisible();
    await expect(line).toContainText(report.lines[0] as string);
    expect(report.lines[0]).toMatch(/^While you were away, /);
    await back.screenshot({ path: 'test-results/m8-away-report.png' });
    // A second sign-in has nothing more to tell.
    await back.reload();
    await back.waitForFunction(() => window.__bs?.ready === true && window.__bs.state().playerId);
    await expect
      .poll(async () => (await state(back as Page)).renewed, {
        message: "the hub's life after the second sign-in",
      })
      .not.toBeNull();
    expect((await state(back)).report).toBeNull();
    await expect(back.getByTestId('away-report')).toBeHidden();
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

test('both pages close mid-fight; once it is settled, both read reports that agree @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const [a, b] = await players(browser);
  try {
    const ids = await stage(a, b, undefined, 1);
    const [nameA, nameB] = [await nameOf(a), await nameOf(b)];
    const id = await engage(a, ids);
    await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, id, {
      timeout: 5_000,
    });
    await Promise.all([a.close(), b.close()]);
    await settled(request, id);

    const [backA, backB] = await Promise.all([reopen(a), reopen(b)]);
    const [ra, rb] = [await reportOf(backA, id, 'A'), await reportOf(backB, id, 'B')];
    // A kill on one side names the other, and so does an eaten egg.
    if (ra.outcome === 'killed') expect(ra.by).toBe(nameB);
    if (rb.outcome === 'killed') expect(rb.by).toBe(nameA);
    if (ra.egg === 'eaten') expect(ra.eggBy).toBe(nameB);
    if (rb.egg === 'eaten') expect(rb.eggBy).toBe(nameA);
    for (const [page, r] of [
      [backA, ra],
      [backB, rb],
    ] as const) {
      await expect(page.getByTestId('away-report')).toContainText(r.lines[0] as string);
    }
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

import {
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { clickHatch, M8_LIFECYCLE_HUB as HUB, openRecorded, state, waitPlaying } from './helpers';
import { seen, stage } from './m7-fight';
import {
  chase,
  engage,
  flee,
  reloadMidFight,
  reopenTitle,
  waitOver,
  watched,
  watchFrom,
} from './m8-fight';

// The M8 line in one scenario (@slow, release gate) at `?quality=medium`, on an authority with the default
// 10 s away wait (a restart closes every socket, and a short wait would settle the fight before
// anyone is back): A and B hatch while C watches; A engages B; B reloads and goes back to the
// fight; the authority restarts and everyone reconnects into the same fight; B's page closes, so A
// draws B away and C sees it by proxy; the fight ends, whatever the outcome, with A's hash equal to
// the referee's and the settlement verified on A; B opens again and reads the report that matches
// A's `enc-end`. Fights end in many ways, so a step that finds the fight over starts the line again
// (at most 3 times). Every page skips its draw call in between (a frame drawn in over 100 ms
// misses the referee's deadline) and draws briefly where the medium budget is checked.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

type Ids = { idA: string; idB: string };

/** One page of a player in its own browser context (its identity), at the medium preset. */
async function player(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '&quality=medium', HUB);
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  return page;
}

/** The page draws one frame with the medium chain, within the medium budget; then it stops drawing again. */
async function withinBudget(page: Page, step: string): Promise<void> {
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(false));
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().calls > 0, undefined, {
    timeout: 20_000,
  });
  const frame = await page.evaluate(() => (window.__bs as BsHook).render.info());
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  const { budget } = PRESETS.medium;
  expect(frame.preset, step).toBe('medium');
  expect(frame.calls, `${step}: draw calls`).toBeLessThanOrEqual(budget.calls);
  expect(frame.triangles, `${step}: triangles`).toBeLessThanOrEqual(budget.triangles);
  expect(frame.targetBytes, `${step}: target bytes`).toBeLessThanOrEqual(budget.targetBytes);
}

const over = async (a: Page, id: string) => {
  const enc = (await state(a)).encounter;
  return enc?.id !== id || enc.over;
};

/** Every page back in the fight `id` after the restart (one more resync than `before`), else false. */
async function rejoined(pages: Page[], before: number[], id: string): Promise<boolean> {
  await expect
    .poll(
      async () => {
        const encs = await Promise.all(pages.map(async (p) => (await state(p)).encounter));
        if (encs.some((e) => e?.id !== id || e.over)) return 'over';
        return encs.every((e, i) => (e?.rejoins ?? 0) > (before[i] ?? 0)) ? 'back' : 'waiting';
      },
      { message: 'both clients rejoin the fight after the restart', timeout: 30_000 },
    )
    .not.toBe('waiting');
  return !(await over(pages[0] as Page, id)) && !(await over(pages[1] as Page, id));
}

/**
 * One try, from an engage to B's closed page. The fight's id once B has reloaded and come back,
 * everyone has rejoined after the restart, and A draws B away while C sees it move by proxy; null
 * when the fight ended on the way (and B's page may be closed by then, in `closed`).
 */
async function tryLine(
  pages: { a: Page; b: Page; c: Page },
  ids: Ids,
  closed: { b: boolean },
  request: APIRequestContext,
  previous?: string,
): Promise<string | null> {
  const { a, b, c } = pages;
  const id = await engage(a, ids, previous);
  await chase(a, ids.idB);
  await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, id, {
    timeout: 5_000,
  });

  // 1. B reloads and goes back to the fight with one click.
  if (!(await reloadMidFight(a, b, id))) {
    await clickHatch(b);
    await waitPlaying(b);
    return null;
  }
  await b.getByTestId('resume-fight').click();
  await b.waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
    timeout: 10_000,
  });
  if (await over(b, id)) return null;
  expect((await state(b)).encounter?.rejoins).toBe(1);
  await withinBudget(b, 'B back in the fight');

  // 2. The authority restarts and everyone reconnects into the same fight.
  const before = await Promise.all(
    [a, b].map(async (p) => (await state(p)).encounter?.rejoins ?? 0),
  );
  const restarted = await request.post(`${HUB}/v1/e2e/restart`);
  expect(restarted.status()).toBe(204);
  if (!(await rejoined([a, b], before, id))) return null;
  await withinBudget(a, 'after the restart');

  // 3. B's page closes: A draws B away, and C sees it by proxy.
  await watchFrom(c, ids.idB);
  await b.close();
  closed.b = true;
  await expect
    .poll(
      async () => {
        if (await over(a, id)) return 'over';
        const s = await state(a);
        const drawn = s.remotes.find((r) => r.id === ids.idB);
        const fighter = s.encounter?.fighters.find((f) => f.player === ids.idB);
        return drawn?.away && fighter?.away && drawn.alpha <= 0.6 ? 'away' : 'waiting';
      },
      { message: 'A draws B away, or the fight ends', timeout: 20_000 },
    )
    .not.toBe('waiting');
  if (await over(a, id)) return null;
  await expect
    .poll(
      async () => {
        if (await over(a, id)) return 'over';
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
  if (await over(a, id)) return null;
  await withinBudget(c, 'C watches the away fighter');
  return id;
}

test('a fight through a reload, an authority restart and a closed tab, settled and reported @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(480_000);
  const [a, b, c] = await Promise.all([player(browser), player(browser), player(browser)]);
  const contextB = b.context();
  const closed = { b: false };
  try {
    await clickHatch(c);
    await waitPlaying(c);
    // B stays whole: a healthy starter neither flees nor dies on its autopilot while it is away.
    const ids = await stage(a, b, undefined, 1);
    await withinBudget(a, 'hatched');
    const nameA = await a.getByTestId('name-input').inputValue();

    let pageB = b;
    let id: string | null = null;
    let previous: string | undefined;
    for (let attempt = 0; attempt < 3 && id === null; attempt++) {
      if (previous) {
        await waitOver(a, previous, 'A');
        if (closed.b) {
          pageB = await reopenTitle(contextB, HUB, 'medium');
          await clickHatch(pageB);
          await waitPlaying(pageB);
          closed.b = false;
        }
        await a.waitForFunction(
          (who) => window.__bs?.state().remotes.some((r) => r.id === who && !r.away),
          ids.idB,
          { timeout: 20_000 },
        );
      }
      id = await tryLine({ a, b: pageB, c }, ids, closed, request, previous);
      previous = (await state(a)).encounter?.id;
    }
    if (!id)
      throw new Error(`no fight went through the whole line: ${JSON.stringify(await seen(a))}`);

    // 4. The fight ends, whatever the outcome: A's hash equals the referee's and the settlement
    // checks out on A.
    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    const end = (await state(a)).encounter;
    expect(end?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(end?.hash).toBe(end?.endHash);
    expect(end?.desyncs).toBe(0);
    expect(end?.rejoins).toBeGreaterThanOrEqual(1);
    await a.waitForFunction(
      (enc) => {
        const e = window.__bs?.state().encounter;
        return e?.id === enc && e.verified !== null;
      },
      id,
      { timeout: 15_000 },
    );
    expect((await state(a)).encounter?.verified).toBe(true);
    await withinBudget(a, 'after the fight');

    // 5. B opens again and reads the report that matches A's `enc-end`.
    const foe = end?.fighters.find((f) => f.player === ids.idB);
    const back = await reopenTitle(contextB, HUB, 'medium');
    await back
      .waitForFunction((enc) => window.__bs?.state().report?.enc === enc, id, { timeout: 20_000 })
      .catch(async (error) => {
        const s = await state(back);
        throw new Error(`B was never told the fight: ${JSON.stringify(s.report)} ${s.screen}`, {
          cause: error,
        });
      });
    const report = (await state(back)).report;
    expect(report?.outcome).toBe(foe?.outcome);
    expect(report?.egg).toBe(foe?.egg == null ? 'none' : foe.egg.eaten ? 'eaten' : 'kept');
    if (report?.outcome === 'killed') expect(report.by).toBe(nameA);
    await expect(back.getByTestId('away-report')).toContainText(report?.lines[0] as string);
  } finally {
    await Promise.all([a.context().close(), contextB.close(), c.context().close()]);
  }
});

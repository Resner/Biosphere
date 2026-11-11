import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import { clickHatch, M8_LIFECYCLE_HUB as HUB, openRecorded, state, waitPlaying } from './helpers';
import { seen, stage } from './m7-fight';
import { chase, engage, flee, waitOver, watched, watchFrom } from './m8-fight';

// The M8 line in one scenario (@slow, release gate) at `?quality=medium`, three players A, B and C:
// A engages B while C watches, B reloads and clicks back into the fight, the authority restarts and
// everyone reconnects into the same fight, B's page closes (A draws B away, C sees it by proxy), the
// fight ends whatever the outcome, and A's hash equals `enc-end`'s with the settlement verified; B
// then opens again and reads the report that matches A's `enc-end`. The medium budgets hold at each
// step. A fight can end before a step runs (B's autopilot flees, or A loses it): the attempt is
// dropped and A engages again, at most 4 times (a lost fight stages a fresh pair). Each path alone is `m8-resume`, `m8-restart`,
// `m8-proxy` and `m8-away`.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

type Ids = { idA: string; idB: string };

/** A page with the medium chain, no picture until a budget check asks for one. */
async function openPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '&quality=medium', HUB);
  await page.evaluate(() => (window as unknown as { __bs: BsHook }).__bs.debug?.skipDraw(true));
  return page;
}

/** One frame is drawn with the medium chain and stays within the medium budget. */
async function withinBudget(page: Page, step: string): Promise<void> {
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(false));
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().calls > 0);
  const frame = await page.evaluate(() => (window.__bs as BsHook).render.info());
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  const { budget } = PRESETS.medium;
  expect(frame.preset, step).toBe('medium');
  expect(frame.calls, `${step}: draw calls`).toBeLessThanOrEqual(budget.calls);
  expect(frame.triangles, `${step}: triangles`).toBeLessThanOrEqual(budget.triangles);
  expect(frame.targetBytes, `${step}: target bytes`).toBeLessThanOrEqual(budget.targetBytes);
}

/** The fight `id` is still running on `page`. */
const running = async (page: Page, id: string) => {
  const enc = (await state(page)).encounter;
  return enc?.id === id && !enc.over;
};

/** B reloads and clicks back into the fight `id`: true once it is in it again, false if it ended first. */
async function resume(a: Page, b: Page, id: string): Promise<boolean> {
  await b.reload();
  await b.waitForFunction(() => window.__bs?.ready === true && window.__bs.state().playerId);
  await b.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  const offered = b.getByTestId('resume-fight');
  await expect
    .poll(
      async () =>
        (await offered.isVisible()) ? 'offered' : (await running(a, id)) ? 'waiting' : 'over',
      {
        message: 'B is offered the fight, or the fight ends',
        timeout: 20_000,
      },
    )
    .not.toBe('waiting');
  if (!(await offered.isVisible())) {
    await clickHatch(b);
    await waitPlaying(b);
    return false;
  }
  await offered.click();
  await b.waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
    timeout: 10_000,
  });
  const back = (await state(b)).encounter;
  expect(back?.id).toBe(id);
  expect(back?.frame ?? 0).toBeGreaterThan(0);
  return !back?.over;
}

/** The hub restarts: every page that plays the fight `id` is back in it (a resync), or the fight ended. */
async function restart(request: APIRequestContext, pages: Page[], id: string) {
  const before = await Promise.all(
    pages.map(async (p) => (await state(p)).encounter?.rejoins ?? 0),
  );
  const res = await request.post(`${HUB}/v1/e2e/restart`);
  expect(res.status()).toBe(204);
  await expect
    .poll(
      async () => {
        const encs = await Promise.all(pages.map(async (p) => (await state(p)).encounter));
        if (encs.some((e) => e?.id !== id || e.over)) return 'over';
        return encs.every((e, i) => (e?.rejoins ?? 0) > (before[i] ?? 0)) ? 'back' : 'waiting';
      },
      { message: 'both fighters rejoin the fight after the restart', timeout: 30_000 },
    )
    .not.toBe('waiting');
  return running(pages[0] as Page, id);
}

test('one fight through a reload, an authority restart and a closed tab, then the report @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(480_000);
  let [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
  const ctxC = await browser.newContext();
  let [a, pageB] = await Promise.all([openPage(ctxA), openPage(ctxB)]);
  const c = await openPage(ctxC);
  // A and B hatched and squared up. B stays whole: a healthy starter neither flees nor dies soon on
  // its autopilot, so a fight between equals can be lost by A: the pair is staged again below.
  const stagePair = async (): Promise<Ids> => {
    const staged = await stage(a, pageB, undefined, 1);
    await pageB.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
    return staged;
  };
  try {
    await clickHatch(c);
    await waitPlaying(c);
    let ids: Ids = await stagePair();
    for (const [page, step] of [
      [a, 'A hatched'],
      [c, 'C hatched'],
    ] as const)
      await withinBudget(page, step);

    let id: string | null = null;
    let previous: string | undefined;
    for (let attempt = 0; attempt < 4 && id === null; attempt++) {
      if (previous) {
        await waitOver(a, previous, 'A');
        // A lost the last fight: it can't engage again, so a fresh pair is staged on new pages
        // (new identities), as `killB` does for a lost fight.
        if ((await state(a)).screen === 'dead') {
          await Promise.all([ctxA.close(), ctxB.close()]);
          [ctxA, ctxB] = await Promise.all([browser.newContext(), browser.newContext()]);
          [a, pageB] = await Promise.all([openPage(ctxA), openPage(ctxB)]);
          ids = await stagePair();
          previous = undefined;
        }
        // B may have closed in the last attempt: back on the title and playing.
        if (pageB.isClosed()) {
          pageB = await openPage(ctxB);
          await clickHatch(pageB);
          await waitPlaying(pageB);
        }
        await a.waitForFunction(
          (who) => window.__bs?.state().remotes.some((r) => r.id === who && !r.away),
          ids.idB,
          { timeout: 20_000 },
        );
      }
      // B's autopilot can escape within a second: a fight that is already over is tried again.
      const fight = await engage(a, ids, previous, true);
      previous = fight;
      if (!(await running(a, fight))) continue;
      await chase(a, ids.idB);
      await watchFrom(c, ids.idB);
      await pageB.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, fight, {
        timeout: 5_000,
      });
      await withinBudget(a, 'in the fight');

      // B reloads and goes back with one click.
      const r1 = await resume(a, pageB, fight);
      if (!r1) continue;
      await withinBudget(pageB, 'B back in the fight');

      // The authority restarts, and both fighters reconnect into the same fight.
      const r2 = await restart(request, [a, pageB], fight);
      if (!r2) continue;
      await withinBudget(a, 'after the restart');

      // B's page closes. A draws B away, and C sees it move by proxy.
      await pageB.close();
      await expect
        .poll(
          async () => {
            if (!(await running(a, fight))) return 'over';
            const s = await state(a);
            const drawn = s.remotes.find((r) => r.id === ids.idB);
            const fighter = s.encounter?.fighters.find((f) => f.player === ids.idB);
            return drawn?.away && fighter?.away && drawn.alpha <= 0.6 ? 'away' : 'waiting';
          },
          { message: 'A draws B away, or the fight ends', timeout: 20_000 },
        )
        .not.toBe('waiting');
      if (!(await running(a, fight))) continue;
      await expect
        .poll(
          async () => {
            if (!(await running(a, fight))) return 'over';
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
      if (await running(a, fight)) id = fight;
    }
    if (!id) throw new Error(`no fight went through every step: ${JSON.stringify(await seen(a))}`);
    await withinBudget(c, 'C watching B away');

    // The fight ends, whatever the outcome: A's hash is the referee's, and the settlement checks out.
    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    const end = (await state(a)).encounter;
    expect(end?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(end?.hash).toBe(end?.endHash);
    expect(end?.desyncs).toBe(0);
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
    const foe = end?.fighters.find((f) => f.player === ids.idB);
    const nameA = await a.getByTestId('name-input').inputValue();

    // B opens again and reads the report that matches A's `enc-end`.
    pageB = await openPage(ctxB);
    await pageB
      .waitForFunction((enc) => window.__bs?.state().report?.enc === enc, id, { timeout: 20_000 })
      .catch(async (error) => {
        const s = await state(pageB);
        throw new Error(`B was never told the fight: ${JSON.stringify(s.report)} ${s.screen}`, {
          cause: error,
        });
      });
    const report = (await state(pageB)).report;
    expect(report?.outcome).toBe(foe?.outcome);
    expect(report?.egg).toBe(foe?.egg === null ? 'none' : foe?.egg.eaten ? 'eaten' : 'kept');
    if (report?.outcome === 'killed') expect(report.by).toBe(nameA);
    await expect(pageB.getByTestId('away-report')).toContainText(report?.lines[0] as string);
    await withinBudget(pageB, 'B back');
  } finally {
    await Promise.all([ctxA.close(), ctxB.close(), ctxC.close()]);
  }
});

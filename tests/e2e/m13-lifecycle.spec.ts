import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { reopenText } from '../../src/game/queue-card';
import {
  clickHatch,
  M13_LIFECYCLE_HUB as HUB,
  openRecorded,
  pingLook,
  state,
  waitPlaying,
} from './helpers';

// M13 T12: the admission line from the first full house to the budget reopening, on one authority
// with two seats (`MAX_SESSIONS=2`) and short matings (@slow, release gate), in order:
// - full: A and B hatch and are seated; C opens and waits (`why: 'full'`, 1st in line, a wait in
//   words) and swims as a practice cell;
// - a seat frees: B's page closes, C hears its seat and its next hatch is recorded;
// - a reload: A reloads and is seated again at once;
// - the budget: today's requests are set past 90% of the budget; D opens and waits (`why:
//   'budget'`, the card names the reopening hour); A reloads again inside the 2 minutes and is
//   seated past the budget; A and C play on, neither dropped;
// - the meter (`/v1/e2e/metrics`): 2 seated, 1 queued, admission closed for `budget`, one wait
//   today, `where`, `progress` and `ping` counted, a per-player cost, relay reports counted with
//   0 KB;
// - the reopening: C's page closes, which frees a seat but not the budget, so D still waits; the
//   budget is then reset to 0 and D is seated within the next queue tick and hatches;
// - the end: every page closes, `GET /v1/audit` shows no flag (bar `authority-only`) and the meter counts two waits.

const SEATED_TOAST = 'A place is free: your next hatch is recorded';
/** The queue is looked at every 15 s; a seat is heard within a tick or two of the budget reopening. */
const SEAT_MS = 45_000;
/** Far past 90% of the free plan's 100,000 request-equivalents. */
const SPENT = 99_000;

test.describe.configure({ mode: 'serial' });

interface Metrics {
  live: { seated: number; queued: number };
  today: {
    waits: number;
    byType: Record<string, number>;
    perPlayerMinute: { messages: number; requests: number } | null;
    relay: { reports: number; kb: number };
  };
  admission: { open: boolean; why: string | null };
}

const metrics = async (): Promise<Metrics> => {
  const res = await fetch(`${HUB}/v1/e2e/metrics`);
  expect(res.ok).toBe(true);
  return (await res.json()) as Metrics;
};

const setRequests = async (requests: number): Promise<void> => {
  const res = await fetch(`${HUB}/v1/e2e/usage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  expect(res.status).toBe(204);
};

const online = (page: Page) =>
  page.waitForFunction(() => window.__bs?.state().net.status === 'online', undefined, {
    timeout: 20_000,
  });

/** Waits for the page to be waiting at `position` for `why`. */
const waitsFor = (page: Page, position: number, why: string) =>
  page.waitForFunction(
    ([p, w]) => {
      const q = window.__bs?.state().queue;
      return q?.position === p && q.why === w;
    },
    [position, why] as const,
    { timeout: 20_000 },
  );

async function hatchAndPlay(page: Page): Promise<string> {
  await clickHatch(page);
  await waitPlaying(page);
  const life = (await state(page)).life;
  expect(life.status).toBe('playing');
  expect(life.creature).toMatch(/^[0-9a-f]{64}$/);
  return life.creature as string;
}

test('the line from a full house to the budget reopening @slow', async ({ browser, request }) => {
  test.setTimeout(240_000);
  // Contexts open as each player arrives, so no more pages are alive than the scenario needs.
  const contexts: BrowserContext[] = [];
  const player = async (): Promise<BrowserContext> => {
    const context = await browser.newContext();
    contexts.push(context);
    return context;
  };
  try {
    await setRequests(0);
    // The hub keeps its day's counts between runs (CI repeats a spec on one hub): judge the
    // differences, from a hub where the last run's pages have left.
    await expect
      .poll(async () => (await metrics()).live, { timeout: 30_000 })
      .toMatchObject({ seated: 0, queued: 0 });
    const before = await metrics();

    // Full: A and B hatch and are seated.
    const ctxA = await player();
    const ctxB = await player();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await openRecorded(pageA, '', HUB);
    await openRecorded(pageB, '', HUB);
    await online(pageA);
    await online(pageB);
    await hatchAndPlay(pageA);
    await hatchAndPlay(pageB);
    const idA = (await state(pageA)).playerId;

    // C waits: the card names the guard, its place and the wait; C swims meanwhile.
    const ctxC = await player();
    const pageC = await ctxC.newPage();
    await openRecorded(pageC, '', HUB);
    await waitsFor(pageC, 1, 'full');
    const full = await state(pageC);
    expect(full.screen).toBe('title');
    const cardC = pageC.getByTestId('queue-card');
    await expect(cardC.locator('.queue-reason')).toHaveText('The water is full');
    await expect(cardC.locator('.queue-line')).toHaveText(
      /^1st in line · (under a minute|about \d+ min)$/,
    );
    await pageC.getByTestId('queue-swim').click();
    await waitPlaying(pageC);
    expect((await state(pageC)).life.status).toBe('practice');

    // A seat frees: B's page closes, C hears its seat and plays on.
    await ctxB.close();
    await expect(pageC.getByTestId('toast')).toHaveText(SEATED_TOAST, { timeout: 30_000 });
    await pageC.waitForFunction(() => {
      const s = window.__bs?.state();
      return s?.net.status === 'online' && s.queue === null;
    });
    // C's practice cell ends and its next hatch is recorded.
    await pageC.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy(0);
      bs.debug?.timeScale(10);
    });
    await pageC.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 30_000,
    });
    await pageC.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    await pageC.getByTestId('hatch-again').click();
    await waitPlaying(pageC);
    expect((await state(pageC)).life.status).toBe('playing');

    // A reload: A is seated again at once, though the water is full.
    await pageA.reload();
    await pageA.waitForFunction(() => window.__bs?.ready === true);
    await online(pageA);
    expect((await state(pageA)).queue).toBeNull();
    expect((await state(pageA)).playerId).toBe(idA);

    // The budget: today's requests are past 90%, so a fourth page waits for it.
    await setRequests(SPENT);
    const ctxD = await player();
    const pageD = await ctxD.newPage();
    await openRecorded(pageD, '', HUB);
    await waitsFor(pageD, 1, 'budget');
    const cardD = pageD.getByTestId('queue-card');
    await expect(cardD.locator('.queue-reason')).toHaveText("Today's room is used up");
    await expect(cardD.locator('.queue-line')).toContainText(reopenText(Date.now()));
    // A reloads again inside the 2 minutes and is seated past the budget.
    await pageA.reload();
    await pageA.waitForFunction(() => window.__bs?.ready === true);
    await online(pageA);
    expect((await state(pageA)).queue).toBeNull();
    // A and C play on.
    for (const page of [pageA, pageC]) {
      await pingLook(page);
      await (page.evaluate(() => (window.__bs as BsHook).debug?.progressNow()) as Promise<void>);
    }
    await online(pageA);
    await online(pageC);

    // The meter reports it: two seated, one waiting, the line closed for the budget.
    await expect
      .poll(async () => (await metrics()).live.queued, { timeout: 20_000 })
      .toBeGreaterThanOrEqual(1);
    const m = await metrics();
    expect(m.live.seated).toBe(2);
    expect(m.live.queued).toBe(1);
    expect(m.admission).toMatchObject({ open: false, why: 'budget' });
    expect(m.today.waits - before.today.waits).toBe(1);
    for (const type of ['where', 'progress', 'ping']) {
      expect(
        (m.today.byType[type] ?? 0) - (before.today.byType[type] ?? 0),
        `${type} counted`,
      ).toBeGreaterThan(0);
    }
    expect(m.today.perPlayerMinute).not.toBeNull();
    expect(m.today.relay.reports - before.today.relay.reports).toBeGreaterThan(0);
    expect(m.today.relay.kb - before.today.relay.kb).toBe(0);

    // The reopening: C's page closes, which frees a seat but not the budget.
    await ctxC.close();
    await expect.poll(async () => (await metrics()).live.seated, { timeout: 20_000 }).toBe(1);
    await waitsFor(pageD, 1, 'budget');
    expect((await state(pageD)).screen).toBe('title');
    // The budget refills and D is seated within the next queue tick. The toast shows for 6 s on a
    // page that a loaded runner draws slowly, so a recorder in the page keeps every text it shows
    // (a poll could look between two frames and miss it) and the wait is on D's state.
    await pageD.evaluate(() => {
      const w = window as unknown as { __toasts: string[] };
      w.__toasts = [];
      const element = document.querySelector('[data-testid="toast"]');
      if (!element) throw new Error('no toast element');
      new MutationObserver(() => {
        if (element.textContent) w.__toasts.push(element.textContent);
      }).observe(element, { childList: true, characterData: true, subtree: true });
    });
    await setRequests(0);
    await pageD
      .waitForFunction(
        () => {
          const s = window.__bs?.state();
          return s?.net.status === 'online' && s.queue === null;
        },
        undefined,
        { timeout: SEAT_MS },
      )
      .catch(async (error) => {
        throw new Error(
          `D was not seated after the budget reopened: ${JSON.stringify({
            d: await pageD.evaluate(() => {
              const s = window.__bs?.state();
              return { screen: s?.screen, net: s?.net.status, queue: s?.queue };
            }),
            metrics: await metrics(),
          })}`,
          { cause: error },
        );
      });
    const shown = await pageD.evaluate(
      () => (window as unknown as { __toasts: string[] }).__toasts,
    );
    expect(shown, 'D was told that its place is free').toContain(SEATED_TOAST);
    await hatchAndPlay(pageD);
    expect((await state(pageA)).net.status).toBe('online');

    // The end: every page closes, nothing was flagged and the meter counts both waits.
    await ctxA.close();
    await ctxD.close();
    const audit = await request.get(`${HUB}/v1/audit`);
    expect(audit.ok()).toBe(true);
    const flags = (await audit.json()) as { total: Record<string, number> };
    // `authority-only` marks a settlement no witness saw, which every settlement on this hub is.
    const raised = Object.entries(flags.total ?? {}).filter(
      ([kind, n]) => kind !== 'authority-only' && n > 0,
    );
    expect(raised, JSON.stringify(flags)).toEqual([]);
    expect((await metrics()).today.waits - before.today.waits).toBe(2);
  } finally {
    await Promise.all(contexts.map((c) => c.close().catch(() => {})));
  }
});

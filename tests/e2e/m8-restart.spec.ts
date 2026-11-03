import { expect, type Page, test } from '@playwright/test';
import { M8_RESTART_HUB, state } from './helpers';
import { open, seen, stage } from './m7-fight';
import { chase, engage, flee, sameEnd, waitOver } from './m8-fight';

// A restart loses no fight (M8 T10): mid-fight the test restarts the authority, which closes every
// socket and rebuilds the fight from its saved log. Both clients reconnect by themselves, get
// `enc-start` again and the history (a resync, counted in `rejoins`), and keep the same fight to
// its end on the referee's hash. A fight that ends before the clients are back is engaged again.

test.describe.configure({ mode: 'serial' });

/** Both pages back in the running fight `id` after the restart: true, or false once it is over. */
async function rejoined(pages: Page[], id: string): Promise<boolean> {
  await expect
    .poll(
      async () => {
        const encs = await Promise.all(pages.map(async (p) => (await state(p)).encounter));
        if (encs.some((e) => e?.id !== id || e.over)) return 'over';
        return encs.every((e) => (e?.rejoins ?? 0) >= 1) ? 'back' : 'waiting';
      },
      { message: 'both clients rejoin the fight after the restart', timeout: 30_000 },
    )
    .not.toBe('waiting');
  const encs = await Promise.all(pages.map(async (p) => (await state(p)).encounter));
  return encs.every((e) => e?.id === id && !e.over && e.rejoins >= 1);
}

test('the authority restarts mid-fight, both clients reconnect into it and end on the referee hash', async ({
  browser,
  request,
}) => {
  test.setTimeout(300_000);
  const [a, b] = await Promise.all([open(browser, M8_RESTART_HUB), open(browser, M8_RESTART_HUB)]);
  try {
    const ids = await stage(a, b, undefined, 1);
    let id: string | null = null;
    let previous: string | undefined;
    for (let attempt = 0; attempt < 3 && id === null; attempt++) {
      if (previous) {
        // A fight dropped by the restart is over on both pages (abandoned, or ended by the referee).
        await expect
          .poll(async () => (await state(a)).encounter?.over && (await state(b)).encounter?.over, {
            message: 'the last fight is over on both pages',
            timeout: 60_000,
          })
          .toBe(true);
      }
      const fight = await engage(a, ids, previous);
      previous = fight;
      await chase(a, ids.idB);
      await b.waitForFunction((enc) => window.__bs?.state().encounter?.id === enc, fight, {
        timeout: 5_000,
      });
      const restarted = await request.post(`${M8_RESTART_HUB}/v1/e2e/restart`);
      expect(restarted.status()).toBe(204);
      if (await rejoined([a, b], fight)) id = fight;
    }
    if (!id) throw new Error(`no fight survived the restart: ${JSON.stringify(await seen(a))}`);

    await flee(a, ids.idB);
    await waitOver(a, id, 'A');
    await waitOver(b, id, 'B');
    await sameEnd(a, b, id);
    for (const page of [a, b]) {
      expect((await state(page)).encounter?.rejoins).toBeGreaterThanOrEqual(1);
    }
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

import { mkdirSync, writeFileSync } from 'node:fs';
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Page,
  test,
} from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { openRecorded } from './helpers';

// What the M14 specs that crash a tab share (`m14-interrupt`, `m14-lifecycle`): a renderer killed
// outright, a new page of the same browser, the recorded rounds held, a hub that is consistent
// with no flag but `authority-only`, and a creature grown up by its own and the hub's clock.

/** Saves a screenshot as `<spec>-<step>` and attaches it to the report. */
export async function attach(page: Page, spec: string, step: string): Promise<void> {
  const name = `${spec}-${step}`;
  const png = await page.screenshot();
  mkdirSync('test-results', { recursive: true });
  writeFileSync(`test-results/${name}.png`, png);
  await test.info().attach(name, { body: png, contentType: 'image/png' });
}

/** Kills the page's renderer outright: nothing unloads, no handler runs. */
export async function crash(page: Page): Promise<void> {
  const crashed = new Promise<void>((resolve) => page.once('crash', () => resolve()));
  const cdp = await page.context().newCDPSession(page);
  void cdp.send('Page.crash').catch(() => {});
  // A ceiling, not a pace: on a loaded runner (E2E main: software GL beside other workers) the
  // renderer took longer than 10 s to go down.
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('the renderer did not crash within 90 s')), 90_000);
  });
  await Promise.race([crashed, late]).finally(() => clearTimeout(timer));
  await page.close().catch(() => {});
}

/** A new page of the same browser, online with the hub. */
export async function reopen(context: BrowserContext, hub: string): Promise<Page> {
  const page = await context.newPage();
  await openRecorded(page, '', hub);
  await page.waitForFunction(() => window.__bs?.state().net.status === 'online', undefined, {
    timeout: 20_000,
  });
  return page;
}

/** Holds the hub's recorded rounds where they stand (`on`), or lets them catch up with the clock. */
export const hold = (request: APIRequestContext, hub: string, on: boolean) =>
  request.post(`${hub}/v1/e2e/beacons`, { data: { hold: on } });

/** The hub after a part: consistent, and no flag but `authority-only`. */
export async function hubIsWhole(request: APIRequestContext, hub: string): Promise<void> {
  const consistency = await request.get(`${hub}/v1/e2e/consistency`);
  expect(consistency.ok(), 'GET /v1/e2e/consistency').toBe(true);
  expect(await consistency.json()).toEqual([]);
  const audit = (await (await request.get(`${hub}/v1/e2e/audit`)).json()) as {
    day: Record<string, number>;
  };
  const flags = Object.entries(audit.day)
    .filter(([kind, count]) => kind !== 'authority-only' && count > 0)
    .map(([kind]) => kind);
  expect(flags, JSON.stringify(audit.day)).toEqual([]);
}

/**
 * Plays at normal speed, belly full, until the creature is mature by its own clock and the hub's
 * word on when that is. The hub credits wall time, so no fast play (it would be `clock-too-fast`).
 */
export async function grownUp(page: Page): Promise<void> {
  await page
    .waitForFunction(
      () => {
        const b = window.__bs as BsHook;
        b.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        const { life } = b.state();
        if (life.matureAtMs === 0 || life.remainingMs === null) return false;
        return life.lifespanMs - life.remainingMs >= life.matureAtMs + 1000;
      },
      undefined,
      { timeout: 60_000, polling: 250 },
    )
    .catch(async (error) => {
      const life = await page.evaluate(() => (window.__bs as BsHook).state().life);
      throw new Error(`never mature: ${JSON.stringify(life)}`, { cause: error });
    });
}

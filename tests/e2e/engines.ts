import { expect, type Page, type TestInfo } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { decodePng, luminance } from './look-metrics';

// Shared by the engine specs (M14 T6): `m14-smoke` (the game in one engine) and `m14-mixed`
// (Chromium with Firefox, and WebKit, in one pond).

/** Page errors and uncaught rejections (Playwright reports both as `pageerror`), from the start. */
export function watchErrors(page: Page, who: string): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`${who}: ${String(e).slice(0, 400)}`));
  return errors;
}

/** A canvas drawn blank or flat reads under this spread of luminance (levels, 0-255). */
const FLAT_SPREAD = 2;

/**
 * A screenshot of the page, saved and attached as `m14-<spec>-<engine>-<step>`, that must show a
 * drawn frame: the luminance of its pixels spreads more than a flat or blank canvas's.
 */
export async function drawnShot(
  page: Page,
  info: TestInfo,
  name: string,
  engine: string,
): Promise<void> {
  const path = info.outputPath(`${name}-${engine}.png`);
  const png = await page.screenshot({ path });
  await info.attach(`${name}-${engine}`, { path, contentType: 'image/png' });
  const image = await decodePng(page, png);
  let sum = 0;
  let sq = 0;
  let n = 0;
  for (let i = 0; i < image.rgba.length; i += 4 * 7) {
    const l = luminance(image.rgba, i);
    sum += l;
    sq += l * l;
    n++;
  }
  const mean = sum / n;
  const spread = Math.sqrt(Math.max(0, sq / n - mean * mean));
  expect(spread, `${name} in ${engine} is a drawn frame, not a flat canvas`).toBeGreaterThan(
    FLAT_SPREAD,
  );
}

/** Waits until the canvas has drawn `more` frames past now: the loop runs in this engine. */
export async function framesRun(page: Page, more = 10): Promise<void> {
  const at = Number(await page.locator('#scene').getAttribute('data-frames'));
  await page.waitForFunction(
    (target) => Number(document.querySelector('#scene')?.getAttribute('data-frames')) >= target,
    at + more,
    { timeout: 30_000 },
  );
}

/** Where `page`'s own creature is now. */
export const own = (page: Page) =>
  page.evaluate(() => {
    const p = (window.__bs as BsHook).state().player;
    if (!p) throw new Error('no creature');
    return { x: p.x, y: p.y, radius: p.radius };
  });

/** Where `page` draws the remote `id`, or null while it draws none. */
export const seen = (page: Page, id: string) =>
  page.evaluate((who) => {
    const r = (window.__bs as BsHook).state().remotes.find((x) => x.id === who);
    return r ? { x: r.x, y: r.y } : null;
  }, id);

/**
 * `mover` swims `far` body radii east, and `watcher` sees its remote move by at least half that:
 * each page sees the other move. Bounded, with what each saw on failure.
 */
export async function seesMove(watcher: Page, mover: Page, moverId: string): Promise<void> {
  const before = await seen(watcher, moverId);
  if (!before) throw new Error(`the watcher draws no ${moverId}`);
  const from = await own(mover);
  const far = from.radius * 8;
  await mover.evaluate(([x, y]) => void (window.__bs as BsHook).debug?.steerTo({ x, y }), [
    from.x + far,
    from.y,
  ] as const);
  await expect
    .poll(
      async () => {
        const now = await seen(watcher, moverId);
        return now ? Math.hypot(now.x - before.x, now.y - before.y) : 0;
      },
      { message: 'the watcher sees the other creature move', timeout: 30_000 },
    )
    .toBeGreaterThan(far / 2);
}

/**
 * Waits until `page` draws the remote `id` over an open link, with what it saw on failure.
 */
export async function linked(page: Page, id: string, timeout = 60_000): Promise<void> {
  await page
    .waitForFunction(
      (who) => {
        const s = (window.__bs as BsHook).state();
        return s.remotes.some((r) => r.id === who) && s.net.open > 0;
      },
      id,
      { timeout },
    )
    .catch(async (error) => {
      const net = await page.evaluate(() => {
        const s = (window.__bs as BsHook).state();
        return { remotes: s.remotes.map((r) => r.id), net: s.net };
      });
      throw new Error(`no link to ${id}: ${JSON.stringify(net).slice(0, 1500)}`, { cause: error });
    });
}

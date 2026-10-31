import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { hatch, M6B_MINIMAP_HUB, openGame, playerOf, state } from './helpers';

// The minimap (M6b T10): round, north-up and centred on the player in the top-right corner. Another
// player shows at its bearing, a ping for its lifetime, and the rim carries the depth, the zone's
// name and the hazard that hurts. A click or M opens the full pond map; it draws at most 10 Hz.

test.describe.configure({ mode: 'serial' });

const DEG = 180 / Math.PI;
/** The gap between two bearings in degrees, 0..180. */
const turn = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

async function joinTwo(browser: Browser): Promise<[Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await openGame(page, `?debug=1&hub=${M6B_MINIMAP_HUB}`);
    await page.waitForFunction(() => window.__bs?.state().playerId);
    // One after the other: a hatch waits for its hub welcome, and both land in one pond.
    await hatch(page);
    pages.push(page);
  }
  for (const page of pages) {
    await page.waitForFunction(() => window.__bs?.state().remotes.length === 1, undefined, {
      timeout: 10_000,
    });
  }
  return pages as [Page, Page];
}

const teleport = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => (window.__bs as BsHook).debug?.teleport(x, y), [x, y] as const);

test('another player shows at its bearing, and a ping for its lifetime', async ({ browser }) => {
  test.setTimeout(60_000);
  const [a, b] = await joinTwo(browser);
  try {
    const idB = (await state(b)).playerId as string;
    const view = await a.evaluate(() => {
      const halfH = (window.__bs as BsHook).render.fx().halfHeight;
      return { halfH, radius: Math.hypot((halfH * innerWidth) / innerHeight, halfH) };
    });
    const mm = await state(a);
    expect(mm.minimap.shown).toBe(true);
    expect(mm.minimap.radiusWu).toBeCloseTo(6 * view.halfH, 3);

    // B two views (centre to corner) away, up and to the right of A: off screen, on the minimap.
    const pa = await playerOf(a);
    const bearing = 35;
    const far = {
      x: pa.x + 2 * view.radius * Math.cos(bearing / DEG),
      y: pa.y + 2 * view.radius * Math.sin(bearing / DEG),
    };
    await teleport(b, far.x, far.y);
    const side = await a.getByTestId('minimap').evaluate((el) => el.clientWidth);
    await expect
      .poll(
        async () => {
          const s = await state(a);
          const dot = s.minimap.players.find((p) => p.id === idB);
          if (!dot || !s.player) return 999;
          // Inside the minimap's own CSS pixels: y grows downwards, north is up.
          const drawn = Math.atan2(side / 2 - dot.y, dot.x - side / 2) * DEG;
          const placed = Math.atan2(far.y - s.player.y, far.x - s.player.x) * DEG;
          return turn(drawn, placed);
        },
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(5);
    const dot = (await state(a)).minimap.players.find((p) => p.id === idB);
    expect(dot).toMatchObject({ size: 'comparable', ready: false });
    // On the disc: two views of a six-half-height radius.
    if (dot) expect(Math.hypot(dot.x - side / 2, dot.y - side / 2)).toBeLessThan(side / 2);
    await a.getByTestId('minimap').screenshot({ path: 'test-results/m6b-minimap-player.png' });

    // B pings beside itself (the wheel at its cursor, on its cell, once its camera caught up).
    await expect
      .poll(
        () =>
          b.evaluate(() => {
            const hook = window.__bs as BsHook;
            const { camX, camY } = hook.render.fx();
            const p = hook.state().player;
            return p ? Math.hypot(camX - p.x, camY - p.y) : 999;
          }),
        { timeout: 5_000 },
      )
      .toBeLessThan(2);
    await b.keyboard.press('g');
    await b.keyboard.press('1');
    const pinged = async () => (await state(a)).minimap.pings.some((p) => p.id === idB);
    await expect.poll(pinged, { timeout: 5_000, intervals: [50] }).toBe(true);
    const shownAt = Date.now();
    const ping = (await state(a)).minimap.pings.find((p) => p.id === idB);
    if (ping) {
      expect(turn(Math.atan2(side / 2 - ping.y, ping.x - side / 2) * DEG, bearing)).toBeLessThan(
        10,
      );
    }
    await a.getByTestId('minimap').screenshot({ path: 'test-results/m6b-minimap-ping.png' });
    // It stays for the ping's 4 s, then goes.
    await expect.poll(pinged, { timeout: 8_000, intervals: [100] }).toBe(false);
    const lasted = Date.now() - shownAt;
    expect(lasted, `shown ${lasted} ms`).toBeGreaterThanOrEqual(3_000);
    expect(lasted, `shown ${lasted} ms`).toBeLessThanOrEqual(5_500);
  } finally {
    await a.context().close();
    await b.context().close();
  }
});

test('the rim names the zone, marks the depth and shows the hazard that hurts; a click opens the pond map; it draws at most 10 times a second', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=minimap-zones');
  await hatch(page);
  // At most 10 draws a second: count the zone picture's draws on the minimap's canvas for 2 s.
  const draws = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const canvas = document.querySelector('[data-testid="minimap-canvas"]');
        const proto = CanvasRenderingContext2D.prototype;
        const original = proto.drawImage;
        let n = 0;
        proto.drawImage = function (this: CanvasRenderingContext2D, ...args: unknown[]) {
          if (this.canvas === canvas) n++;
          return (original as (...a: unknown[]) => void).apply(this, args);
        } as typeof original;
        setTimeout(() => {
          proto.drawImage = original;
          resolve(n);
        }, 2000);
      }),
  );
  expect(draws).toBeGreaterThan(0);
  expect(draws).toBeLessThanOrEqual(21);

  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  const s0 = await state(page);
  expect(s0.player?.stats.uvTolerance).toBeLessThan(1);
  expect(s0.player?.stats.pressureTolerance).toBeLessThan(1);
  const hazard = page.getByTestId('minimap-hazard');
  for (const [zone, name, shown] of [
    ['twilight', 'Twilight', null],
    ['shallows', 'Shallows', 'uv'],
    ['abyss', 'Abyss', 'pressure'],
    // The deep's lower part presses too (M6 T15), so back to the twilight for a clear rim.
    ['twilight', 'Twilight', null],
  ] as const) {
    await page.evaluate((z) => (window.__bs as BsHook).debug?.setZone(z), zone);
    await expect(page.getByTestId('minimap-zone')).toHaveText(name);
    await expect.poll(async () => (await state(page)).minimap.zone).toBe(zone);
    const s = await state(page);
    expect(s.minimap.depth).toBeCloseTo(s.depth ?? -1, 2);
    expect(s.minimap.hazard).toBe(shown);
    if (shown) {
      await expect(hazard).toBeVisible();
      await expect(hazard).toHaveAttribute('data-hazard', shown);
      // A shape, not colour alone: each hazard has its own glyph.
      await expect(hazard.locator(`svg.${shown}`)).toBeVisible();
      await expect(hazard).toHaveAccessibleName(shown === 'uv' ? 'UV burns' : 'Pressure crushes');
    } else {
      await expect(hazard).toBeHidden();
    }
    await page.getByTestId('minimap').screenshot({ path: `test-results/m6b-minimap-${zone}.png` });
  }
  // A click on the minimap opens the full pond map, as M does; M closes it.
  await page.getByTestId('minimap').click();
  await expect(page.getByTestId('pond-map')).toBeVisible();
  expect(await page.evaluate(() => document.activeElement === document.body)).toBe(true);
  await page.keyboard.press('m');
  await expect(page.getByTestId('pond-map')).toBeHidden();
  await page.keyboard.press('m');
  await expect(page.getByTestId('pond-map')).toBeVisible();
  await page.keyboard.press('m');
  await expect(page.getByTestId('pond-map')).toBeHidden();
  // The depth gauge and the hazard overlays are gone.
  for (const id of ['hud-depth', 'uv-cue', 'pressure-cue', 'vignette'])
    await expect(page.getByTestId(id)).toHaveCount(0);
  await page.screenshot({ path: 'test-results/m6b-minimap-hud.png' });
});

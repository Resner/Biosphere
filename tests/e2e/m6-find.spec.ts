import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { RULES } from '../../src/sim/rules';
import { hatch, M6_FIND_HUB, openGame, playerOf, state } from './helpers';

// Finding other players (M6 T19): an edge indicator points at a pond player off screen, a ping
// near the player but off screen shows on the edge, and the pond map (M) places everyone.

test.describe.configure({ mode: 'serial' });

const DEG = 180 / Math.PI;
/** The gap between two bearings in degrees, 0..180. */
const turn = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180);

async function joinTwo(browser: Browser): Promise<[Page, Page]> {
  const pages: Page[] = [];
  for (let i = 0; i < 2; i++) {
    const page = await (await browser.newContext()).newPage();
    await openGame(page, `?debug=1&hub=${M6_FIND_HUB}`);
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

/** The view's half-size and its radius (centre to corner), in world units. */
async function viewOf(page: Page): Promise<{ halfW: number; halfH: number; radius: number }> {
  return page.evaluate(() => {
    const halfH = (window.__bs as BsHook).render.fx().halfHeight;
    const halfW = (halfH * window.innerWidth) / window.innerHeight;
    return { halfW, halfH, radius: Math.hypot(halfW, halfH) };
  });
}

const teleport = (page: Page, x: number, y: number) =>
  page.evaluate(([x, y]) => (window.__bs as BsHook).debug?.teleport(x, y), [x, y] as const);

test('an edge indicator points at a far player, a nearby ping shows on the edge, and M maps both', async ({
  browser,
}) => {
  test.setTimeout(60_000);
  const [a, b] = await joinTwo(browser);
  try {
    const idA = (await state(a)).playerId as string;
    const idB = (await state(b)).playerId as string;
    const view = await viewOf(a);
    const pa = await playerOf(a);

    // B three views away, up and to the right of A.
    const bearing = 25;
    const far = {
      x: pa.x + 3 * view.radius * Math.cos(bearing / DEG),
      y: pa.y + 3 * view.radius * Math.sin(bearing / DEG),
    };
    await teleport(b, far.x, far.y);
    await expect
      .poll(
        async () => {
          const s = await state(a);
          const ind = s.indicators.find((i) => i.kind === 'player' && i.id === idB);
          const remote = s.remotes.find((r) => r.id === idB);
          if (!ind || !remote || !s.player) return 999;
          const seen = Math.atan2(remote.y - s.player.y, remote.x - s.player.x) * DEG;
          const placed = Math.atan2(far.y - s.player.y, far.x - s.player.x) * DEG;
          return Math.max(turn(ind.angle, seen), turn(ind.angle, placed));
        },
        { timeout: 10_000 },
      )
      .toBeLessThanOrEqual(5);
    const edge = a.locator(`[data-testid="edge-indicator"][data-kind="player"][data-id="${idB}"]`);
    await expect(edge).toBeVisible();
    const box = await edge.boundingBox();
    const size = a.viewportSize() ?? { width: 960, height: 540 };
    expect(box).not.toBeNull();
    if (box) {
      const cx = box.x + box.width / 2;
      const cy = box.y + box.height / 2;
      // On the edge, not in the middle: within 80 px of the right or the top side.
      expect(Math.min(size.width - cx, cy)).toBeLessThan(80);
    }
    await expect(edge).toContainText(/\d+(\.\dk)? lengths/);
    await a.screenshot({ path: 'test-results/m6-find-edge.png' });

    // B pings beside itself, 1.5 half-widths to A's left: off A's screen but within 2 view radii.
    const near = { x: pa.x - 1.5 * view.halfW, y: pa.y };
    await teleport(b, near.x, near.y);
    const ping = async () => {
      await b.waitForTimeout(150);
      await b.keyboard.press('g');
    };
    await ping();
    await expect
      .poll(async () => (await state(b)).social.pings.some((p) => p.from === idB), {
        timeout: 5_000,
      })
      .toBe(true);
    const pingEdge = a.locator(
      `[data-testid="edge-indicator"][data-kind="ping"][data-id="${idB}"]`,
    );
    await expect(pingEdge).toBeVisible({ timeout: 5_000 });
    const pinged = (await state(a)).indicators.find((i) => i.kind === 'ping' && i.id === idB);
    expect(pinged).toBeDefined();
    expect(turn(pinged?.angle ?? 0, 180)).toBeLessThan(10);
    await a.screenshot({ path: 'test-results/m6-find-ping.png' });

    // The pond map lists both players where they are, and the ping.
    await b.waitForTimeout(1100);
    await ping();
    await a.keyboard.press('m');
    const map = a.getByTestId('pond-map');
    await expect(map).toBeVisible();
    await expect(a.locator('[data-testid="map-ping"]:visible')).not.toHaveCount(0);
    expect((await state(a)).map.open).toBe(true);
    const frame = await a.getByTestId('map-frame').boundingBox();
    expect(frame).not.toBeNull();
    for (const id of [idA, idB]) {
      const dot = await a.locator(`[data-testid="map-dot"][data-id="${id}"] svg`).boundingBox();
      expect(dot, id).not.toBeNull();
      if (!dot || !frame) continue;
      const s = await state(a);
      const at = id === idA ? s.player : s.remotes.find((r) => r.id === id);
      if (!at) throw new Error(`no position for ${id}`);
      const u = (dot.x + dot.width / 2 - frame.x) / frame.width;
      const v = (dot.y + dot.height / 2 - frame.y) / frame.height;
      expect(Math.abs(u - at.x / RULES.world.size), id).toBeLessThanOrEqual(0.02);
      expect(Math.abs(v - (1 - at.y / RULES.world.size)), id).toBeLessThanOrEqual(0.02);
    }
    await expect(a.locator(`[data-testid="map-dot"][data-id="${idA}"]`)).toHaveAttribute(
      'data-self',
      'true',
    );
    await a.screenshot({ path: 'test-results/m6-find-map.png' });

    // Steering carries on under the map.
    const before = await playerOf(a);
    await a.mouse.move(size.width - 20, size.height / 2);
    await expect
      .poll(async () => (await playerOf(a)).x - before.x, { timeout: 5_000 })
      .toBeGreaterThan(20);
    await a.mouse.move(size.width / 2, size.height / 2);

    // M closes it, and so does Esc (which then opens nothing else).
    await a.keyboard.press('m');
    await expect(map).toBeHidden();
    await a.keyboard.press('m');
    await expect(map).toBeVisible();
    await a.keyboard.press('Escape');
    await expect(map).toBeHidden();
    await expect(a.getByTestId('lineage')).toBeHidden();
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

test('a player who says it could mate shows a heart on its indicator and on the map', async ({
  page,
}) => {
  await openGame(page, '?debug=1');
  await hatch(page);
  const p = await playerOf(page);
  await page.evaluate(
    ([x, y]) =>
      (window.__bs as BsHook).debug?.setRemotes([
        { id: 'ready', name: 'Rea', x: x + 2000, y, ready: true },
        { id: 'busy', name: 'Bus', x: x - 2000, y, biomass: 4000 },
      ]),
    [p.x, p.y] as const,
  );
  const ready = page.locator('[data-testid="edge-indicator"][data-id="ready"]');
  const busy = page.locator('[data-testid="edge-indicator"][data-id="busy"]');
  await expect(ready).toHaveAttribute('data-ready', 'true');
  await expect(ready).toContainText('ready');
  await expect(busy).toHaveAttribute('data-ready', 'false');
  // A bigger creature has another shape, and says so in words.
  await expect(busy).toHaveAttribute('data-size', 'bigger');
  await expect(busy).toContainText('bigger');
  await expect(ready).toHaveAttribute('data-size', 'comparable');
  await page.keyboard.press('m');
  await expect(page.locator('[data-testid="map-dot"][data-id="ready"]')).toHaveAttribute(
    'data-ready',
    'true',
  );
  await expect(page.locator('[data-testid="map-dot"][data-id="ready"] .map-heart')).toHaveCount(1);
  await expect(page.locator('[data-testid="map-dot"][data-id="busy"] .map-heart')).toHaveCount(0);
  await page.screenshot({ path: 'test-results/m6-find-ready.png' });
});

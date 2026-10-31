import { expect, type Page } from '@playwright/test';
import type { BsHook, BsState } from '../../src/game/debug';

/**
 * Opens the game on the title screen and waits for the test hook. A test that does not pin a body
 * with `genome=` gets the starter cell, so the thresholds of the M1 and M2 specs stay meaningful.
 */
export async function openGame(page: Page, query: string): Promise<void> {
  const pinned = /[?&]genome=/.test(query)
    ? query
    : `${query}${query.includes('?') ? '&' : '?'}genome=starter`;
  await page.goto(`./${pinned}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
}

/**
 * Clicks Hatch and waits until play has started. The click leaves the cursor on the button, which
 * would steer the cell away, so the cursor is parked on the cell (inside its dead zone).
 */
export async function hatch(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing');
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

/**
 * Opens the play screen's menu (M6b T9) with Esc, which leaves the cursor (and so the steering)
 * where it is: the numbers in words, the roster, Lineage and Settings live there now. Call it with
 * nothing else open that Esc would close first (the wheel, the map, a card or an invitation).
 */
export async function openMenu(page: Page): Promise<void> {
  const menu = page.getByTestId('menu');
  if (!(await menu.isVisible())) await page.keyboard.press('Escape');
  await expect(menu).toBeVisible();
}

export const state = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

/** Types a chat line through the real UI (Enter, text, Enter). */
export async function say(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeVisible();
  await page.keyboard.type(text);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('chat-input')).toBeHidden();
}

export const chatTexts = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).state().social.chat.map((l) => l.text));

export async function playerOf(page: Page): Promise<NonNullable<BsState['player']>> {
  const { player } = await page.evaluate(() => (window.__bs as BsHook).state());
  if (!player) throw new Error('the player has not hatched');
  return player;
}

/** Bundles a source file into one browser script (an IIFE that sets `globalName`). */
export async function bundleForBrowser(entry: string, globalName: string): Promise<string> {
  const { build } = await import('vite');
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    build: {
      write: false,
      minify: false,
      lib: { entry, name: globalName, formats: ['iife'], fileName: 'bundle' },
    },
  });
  const outputs = Array.isArray(out) ? out : [out];
  const chunk = outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .find((o) => o.type === 'chunk');
  if (!chunk || chunk.type !== 'chunk') throw new Error(`no bundle for ${entry}`);
  return chunk.code;
}

/** Mean luminance (0..1) of the square patches of `2 * half + 1` pixels around each point of a PNG. */
export async function patchLuma(
  page: Page,
  png: Buffer,
  points: { x: number; y: number }[],
  half = 4,
): Promise<number[]> {
  return page.evaluate(
    async ({ base64, points, half }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const scratch = document.createElement('canvas');
      scratch.width = image.width;
      scratch.height = image.height;
      const context = scratch.getContext('2d');
      if (!context) throw new Error('2D canvas unavailable');
      context.drawImage(image, 0, 0);
      return points.map((p) => {
        const size = 2 * half + 1;
        const { data } = context.getImageData(
          Math.round(p.x) - half,
          Math.round(p.y) - half,
          size,
          size,
        );
        let sum = 0;
        for (let i = 0; i < data.length; i += 4) {
          sum +=
            (0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0)) /
            255;
        }
        return sum / (size * size);
      });
    },
    { base64: png.toString('base64'), points, half },
  );
}

/** The authority the M4 specs share: `wrangler dev --e2e`, serving recorded drand rounds. */
export const M4_HUB = 'http://localhost:8790';

/** The M4 authority with lifespans at 1% (about 45 s), for the old-age spec. */
export const M4_SHORT_LIFE_HUB = 'http://localhost:8791';

/** The M4 authority with two seats (`MAX_SESSIONS=2`), for the lifecycle spec's admission queue. */
export const M4_TWO_SEAT_HUB = 'http://localhost:8792';

/** The M5 authority: lives of about 4 min (`LIFESPAN_SCALE=0.05`) and maturity in seconds (`MATING_SCALE=0.01`). */
export const M5_HUB = 'http://localhost:8793';

/** A second M5 authority, alone in its pond, for the inspect spec. */
export const M5_INSPECT_HUB = 'http://localhost:8794';

/** A third, for the promote spec. */
export const M5_PROMOTE_HUB = 'http://localhost:8795';

/** A fourth, for the lifecycle spec. */
export const M5_LIFECYCLE_HUB = 'http://localhost:8796';

/** The M6 authority for the finding spec (edge indicators and the pond map), alone in its pond. */
export const M6_FIND_HUB = 'http://localhost:8797';

/** The M6 authority for the egg spec, with the M5 hooks (short lives, maturity in seconds), alone in its pond. */
export const M6_EGG_HUB = 'http://localhost:8798';

/** The M6 authority for the social wheel spec, alone in its pond. */
export const M6_WHEEL_HUB = 'http://localhost:8799';

/** The M6 authority for the lifecycle spec, with the M5 hooks, alone in its pond. */
export const M6_LIFECYCLE_HUB = 'http://localhost:8800';

/** The M6b authority for the egg spec, with the M5 hooks, alone in its pond. */
export const M6B_EGG_HUB = 'http://localhost:8801';

/** The M6b authority for the minimap spec, alone in its pond. */
export const M6B_MINIMAP_HUB = 'http://localhost:8802';

/** The M6b authority for the lifecycle spec, with the M5 hooks (short lives), two players in one pond. */
export const M6B_LIFECYCLE_HUB = 'http://localhost:8803';

/** Opens the game against an M4 hub with no pinned body, so a hatch goes through the ledger. */
export async function openRecorded(page: Page, extra = '', hub = M4_HUB): Promise<void> {
  await page.goto(`./?debug=1&hub=${hub}${extra}`);
  await page.waitForFunction(() => window.__bs?.ready === true);
  await page.waitForFunction(() => window.__bs?.state().playerId);
}

/** Clicks Hatch on the title screen without waiting for play to start. */
export const clickHatch = (page: Page) =>
  page.getByRole('button', { name: 'Hatch', exact: true }).click();

/** Waits for play to start after a recorded hatch, which takes a beacon round (3 to 6 s). */
export async function waitPlaying(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing', undefined, {
    timeout: 15_000,
  });
  const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
  await page.mouse.move(width / 2, height / 2);
}

/** Fills the creature's belly. */
export const topUp = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(Number.MAX_SAFE_INTEGER));

/**
 * Runs the sim fast until the hub has credited the creature's maturity (seconds, on the M5
 * authorities). The hub credits at most the wall time (plus 2 s) per report, so fast play sends
 * the reports sooner. The belly is filled all the while, since 30x time would starve it.
 */
export const ripe = (page: Page, timeout = 40_000) =>
  page.waitForFunction(
    () => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      bs.debug?.timeScale(30);
      const { activeMs, matureAtMs } = bs.state().life;
      if (matureAtMs === 0 || activeMs < matureAtMs) return false;
      bs.debug?.timeScale(1);
      return true;
    },
    undefined,
    { timeout },
  );

/** Parks the player beside a remote, as soon as the remote is drawn. */
export async function goTo(page: Page, id: string): Promise<void> {
  await page.waitForFunction((who) => window.__bs?.state().remotes.some((r) => r.id === who), id, {
    timeout: 20_000,
  });
  // Teleport until the HUD sees the creature in reach: on a loaded runner the remote is still fading
  // in or has drifted by the time the first jump lands, and the mate hint stays hidden.
  const hint = page.getByTestId('mate-hint');
  await expect(async () => {
    await page.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const r = bs.state().remotes.find((x) => x.id === who);
      if (r) bs.debug?.teleport(r.x + r.radius * 2.5, r.y);
    }, id);
    await expect(hint).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 20_000 });
}

/** What `document.elementFromPoint` finds at the egg's centre and at four points 0.8 of its radius out. */
export const atEgg = (page: Page) =>
  page.evaluate(() => {
    const at = (window.__bs as BsHook).state().egg.at;
    if (!at) return null;
    const d = 0.8 * at.r;
    const points = [
      [at.x, at.y],
      [at.x + d, at.y],
      [at.x - d, at.y],
      [at.x, at.y + d],
      [at.x, at.y - d],
    ] as const;
    return {
      at,
      hits: points.map(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        return el ? `${el.tagName.toLowerCase()}#${el.id}` : 'none';
      }),
    };
  });

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import type { GuideStep } from '../../src/game/guide';
import { GUIDE_WORDS } from '../../src/game/guide';
import {
  clickHatch,
  courtUntilInvited,
  goTo,
  hatch,
  hudCover,
  M14_GUIDE_HUB,
  openGame,
  openRecorded,
  ripe,
  state,
  topUp,
  waitPlaying,
} from './helpers';

// The first-life guide (M14 T7): a fresh browser is told each thing once, at the moment it matters,
// one line at the bottom centre. A practice cell learns to swim, eat, dash, keep clear of a plume
// and eat when hungry; two recorded players on their own hub (8843, `MATING_SCALE` 0.01) learn the
// amber rings, the wheel, maturity, the invitation and the egg.

test.describe.configure({ mode: 'serial' });

const guideOf = async (page: Page) => (await state(page)).guide;

/**
 * What the page holds each poll while it waits: a `full` belly (`debug.sated`) eats nothing, so no
 * meal ends a step before the test means it to; `share` holds the energy at that share of its cap; `nearFood` keeps
 * the creature within 3 body radii of the nearest food.
 */
interface Keep {
  full?: boolean;
  share?: number;
  nearFood?: boolean;
}
const FULL: Keep = { full: true };

type Kept = Window & { __guideKeep?: (keep: Keep) => void };

/** Installs, before the page's scripts on every load, the helper that applies a `Keep` each poll. */
const prepare = (page: Page) =>
  page.addInitScript(() => {
    (window as Kept).__guideKeep = (keep: Keep) => {
      const bs = window.__bs as BsHook | undefined;
      const debug = bs?.debug;
      const p = bs?.state().player;
      if (!bs || !debug || !p) return;
      if (keep.full) debug.sated(true);
      if (keep.share !== undefined) {
        debug.sated(false);
        debug.setEnergy(Number.MAX_SAFE_INTEGER);
        debug.setEnergy((bs.state().player?.energy ?? 0) * keep.share);
      }
      const food = keep.nearFood ? debug.nearestFood() : null;
      if (food && Math.hypot(food.x - p.x, food.y - p.y) > p.radius * 4) {
        debug.teleport(food.x - p.radius * 3, food.y);
      }
    };
  });

/**
 * Plays on until `step` shows. The sim runs fast meanwhile, since the guide starts at most one new
 * step every 20 s of the loop's clock, and `keep` holds the creature's state; the frame that sees
 * the step drops back to normal speed.
 */
async function until(
  page: Page,
  step: GuideStep,
  keep: Keep = {},
  timeout = 30_000,
): Promise<void> {
  await page
    .waitForFunction(
      ([step, keep]) => {
        const bs = window.__bs as BsHook;
        (window as Kept).__guideKeep?.(keep);
        if (bs.state().guide.current === step) {
          bs.debug?.timeScale(1);
          return true;
        }
        bs.debug?.timeScale(8);
        return false;
      },
      [step, keep] as const,
      { timeout, polling: 100 },
    )
    .catch(async (error) => {
      const guide = await guideOf(page).catch(() => null);
      throw new Error(`the guide never showed ${step}: ${JSON.stringify(guide)}`, {
        cause: error,
      });
    });
  await expect(page.getByTestId('hint')).toBeVisible();
}

/** Waits until the step is gone from the screen and remembered as seen. */
async function gone(page: Page, step: GuideStep, keep: Keep = {}): Promise<void> {
  await page
    .waitForFunction(
      ([step, keep]) => {
        (window as Kept).__guideKeep?.(keep);
        const { current, seen } = (window.__bs as BsHook).state().guide;
        return current !== step && seen.includes(step);
      },
      [step, keep] as const,
      { timeout: 15_000, polling: 100 },
    )
    .catch(async (error) => {
      throw new Error(`${step} never went: ${JSON.stringify(await guideOf(page))}`, {
        cause: error,
      });
    });
}

/** Screenshots at 960 × 540 and 390 × 844, with the line whole on one line and inside the screen. */
async function shoot(page: Page, name: string): Promise<void> {
  for (const [width, height] of [
    [960, 540],
    [390, 844],
  ] as const) {
    await page.setViewportSize({ width, height });
    const hint = page.getByTestId('hint');
    await expect(hint).toBeVisible();
    const look = await hint.evaluate((el) => {
      const r = el.getBoundingClientRect();
      // The text's line boxes: one top per line.
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops = new Set([...range.getClientRects()].map((b) => Math.round(b.top)));
      const covers = ['.hud .stat', '.minimap', '[data-testid="minimap-depth"]']
        .flatMap((s) => [...document.querySelectorAll(s)])
        .filter((o) => (o as HTMLElement).checkVisibility())
        .some((o) => {
          const b = o.getBoundingClientRect();
          return b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom;
        });
      return {
        left: r.left,
        right: r.right,
        lines: tops.size,
        covers,
        scroll: document.documentElement.scrollWidth > innerWidth,
      };
    });
    const at = `${name} at ${width}`;
    expect(look.left, at).toBeGreaterThanOrEqual(0);
    expect(look.right, at).toBeLessThanOrEqual(width);
    expect(look.lines, at).toBeLessThanOrEqual(1);
    expect(look.covers, at).toBe(false);
    expect(look.scroll, at).toBe(false);
    // The HUD's 6% is m6b-hud's at 960 × 540 (at 390 px its fixed-size bars and minimap alone are more).
    if (width === 960) expect((await hudCover(page)).share, at).toBeLessThanOrEqual(0.06);
    await page.screenshot({ path: `test-results/m14-guide-${name}-${width}.png` });
  }
  await page.setViewportSize({ width: 960, height: 540 });
}

test('a newcomer is told to swim, eat, dash, keep clear and eat when hungry, once per browser @slow', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const context = await browser.newContext({ viewport: { width: 960, height: 540 } });
  const page = await context.newPage();
  await prepare(page);
  try {
    await openGame(page, '?debug=1&seed=guide');
    await expect(page.getByTestId('title-help')).toHaveText('New here? How to play');
    await expect(page.getByTestId('title-help')).toBeVisible();
    await page.screenshot({ path: 'test-results/m14-guide-title.png' });
    await hatch(page);

    // Swim, in the life's first second; gone once it has swum 3 body lengths.
    await until(page, 'swim', FULL);
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.swim);
    expect((await state(page)).hud.hints).toBe(GUIDE_WORDS.swim);
    await shoot(page, 'swim');
    await page.evaluate(async () => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) await bs.debug?.steerTo({ x: p.x + p.radius * 10, y: p.y });
    });
    await gone(page, 'swim', FULL);
    expect(
      JSON.parse((await page.evaluate(() => localStorage.getItem('bs.guide'))) ?? '[]'),
    ).toContain('swim');

    // Eat, once it swam; gone with its first meal.
    await until(page, 'eat', FULL);
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.eat);
    await page.evaluate(async () => {
      const bs = window.__bs as BsHook;
      (window as Kept).__guideKeep?.({ share: 0.6 });
      const food = bs.debug?.nearestFood();
      if (food) await bs.debug?.steerTo(food);
    });
    await gone(page, 'eat', FULL);

    // Dash, after its first meal with food near; gone when it dashes.
    await until(page, 'dash', { full: true, nearFood: true });
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.dash);
    await page.keyboard.press('Space');
    await gone(page, 'dash', FULL);

    // A plume within 3 body radii: the hazard step shows at once, and goes 2 s out of it.
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) bs.debug?.spawnPlume(p.x + p.radius * 4, p.y, p.radius * 2);
    });
    await until(page, 'hazard', FULL, 10_000);
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.hazard[0]);
    await shoot(page, 'hazard');
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) bs.debug?.teleport(p.x - p.radius * 40, p.y);
    });
    await gone(page, 'hazard', FULL);

    // Hungry: under 30% of the cap; gone over 50%.
    await until(page, 'energy', { share: 0.2 }, 60_000);
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.energy);
    await shoot(page, 'energy');
    await page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(Number.MAX_SAFE_INTEGER));
    await gone(page, 'energy', FULL);

    // A reload is a later visit: the title has no "New here?", and a new life shows no seen step.
    await openGame(page, '?debug=1&seed=guide-2');
    await expect(page.getByTestId('title-help')).toBeHidden();
    await hatch(page);
    const start = (await state(page)).tick;
    await page.waitForFunction(
      (until) => {
        const bs = window.__bs as BsHook;
        bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        return bs.state().tick >= until && bs.state().guide.current === null;
      },
      start + 60,
      { timeout: 15_000 },
    );
    const later = await guideOf(page);
    expect(later.seen).toEqual(expect.arrayContaining(['swim', 'eat', 'dash', 'hazard', 'energy']));
    await expect(page.getByTestId('hint')).toBeHidden();

    // "Show the hints again" forgets them: the title offers help again and swim comes back.
    await openGame(page, '?debug=1&seed=guide-3');
    await page.getByTestId('settings-open').click();
    await expect(page.getByTestId('show-hints')).toBeChecked();
    await page.getByTestId('hints-replay').click();
    await expect(page.getByTestId('hints-replayed')).toBeVisible();
    await page.getByTestId('settings-close').click();
    await expect(page.getByTestId('title-help')).toBeVisible();
    await hatch(page);
    await until(page, 'swim', FULL);

    // "Show hints" off: the line goes at once.
    await page.keyboard.press('Escape');
    await page.getByTestId('menu-settings').click();
    await page.getByTestId('show-hints').uncheck();
    await expect(page.getByTestId('hint')).toBeHidden();
    expect((await guideOf(page)).on).toBe(false);
  } finally {
    await context.close();
  }
});

async function hatched(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await prepare(page);
  await openRecorded(page, '', M14_GUIDE_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

const idOf = async (page: Page): Promise<string> => (await state(page)).playerId as string;

test('two players learn the amber rings, the wheel, maturity, the invitation and the egg @slow', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  const [ctxA, ctxB] = contexts as [BrowserContext, BrowserContext];
  try {
    const [a, b] = await Promise.all([hatched(ctxA), hatched(ctxB)]);
    const [idA, idB] = [await idOf(a), await idOf(b)];
    // The early steps are another test's: here each page has seen them, so the later ones come at once.
    for (const page of [a, b]) {
      await page.evaluate(() => {
        const seen = ['swim', 'eat', 'dash', 'energy', 'hazard', 'attack', 'fight', 'menu'];
        localStorage.setItem('bs.guide', JSON.stringify(seen));
      });
    }
    // Reloaded, the guide reads them; each page plays its creature on.
    // (The hub resumes the same creature: no new hatch is spent.)
    for (const page of [a, b]) {
      await openRecorded(page, '', M14_GUIDE_HUB);
      await page.getByTestId('hatch').click();
      await waitPlaying(page);
    }

    // B grows a tier past A, side by side: A sees amber rings.
    await goTo(a, idB, b);
    await b.evaluate(() => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) bs.debug?.setBiomass(p.biomass * 6);
    });
    await until(a, 'bigger', FULL);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.bigger);
    await shoot(a, 'bigger');
    await b.evaluate(() => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) bs.debug?.setBiomass(p.biomass / 6);
    });

    // 30 s after the first link: the wheel; gone when it opens.
    await until(a, 'wheel', FULL, 60_000);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.wheel);
    await a.keyboard.down('g');
    await gone(a, 'wheel', FULL);
    await a.keyboard.up('g');

    // Mature: told to court; A courts, B is told how to accept; after the round, both are told of the egg.
    await Promise.all([ripe(a), ripe(b)]);
    await until(a, 'mature', FULL, 60_000);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.mature);
    await Promise.all([topUp(a), topUp(b)]);
    await courtUntilInvited(a, b, idB);
    await gone(a, 'mature', FULL);
    await until(b, 'invite', FULL, 10_000);
    await expect(b.getByTestId('hint')).toHaveText(GUIDE_WORDS.invite);
    await b.keyboard.press('e');
    await gone(b, 'invite', FULL);
    for (const page of [a, b]) await until(page, 'egg', FULL, 60_000);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.egg);
    await shoot(a, 'egg');
    expect((await guideOf(b)).seen).toContain('egg');
    expect(idA).not.toBe(idB);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

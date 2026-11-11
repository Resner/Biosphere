import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import type { GuideStep } from '../../src/game/guide';
import { GUIDE_STEPS, GUIDE_WORDS } from '../../src/game/guide';
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
const prepare = async (page: Page) => {
  await record(page);
  await page.addInitScript(() => {
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
};

type Logged = Window & { __guideLog?: { step: string; text: string | null }[] };

/** Records, every 100 ms from each load, the steps the page has shown and their words. */
const record = (page: Page) =>
  page.addInitScript(() => {
    const log: { step: string; text: string | null }[] = [];
    (window as Logged).__guideLog = log;
    setInterval(() => {
      const guide = (window.__bs as BsHook | undefined)?.ready
        ? (window.__bs as BsHook).state().guide
        : null;
      if (guide?.current && log.at(-1)?.step !== guide.current) {
        log.push({ step: guide.current, text: guide.text });
      }
    }, 100);
  });

/** Plays on (fast, held `full`) until the page has shown `step` with `words`, now or before. */
async function told(page: Page, step: GuideStep, words: string, timeout = 60_000): Promise<void> {
  await page
    .waitForFunction(
      (step) => {
        const bs = window.__bs as BsHook;
        (window as Kept).__guideKeep?.({ full: true });
        if ((window as Logged).__guideLog?.some((e) => e.step === step)) {
          bs.debug?.timeScale(1);
          return true;
        }
        bs.debug?.timeScale(8);
        return false;
      },
      step,
      { timeout, polling: 100 },
    )
    .catch(async (error) => {
      throw new Error(`the guide never showed ${step}: ${JSON.stringify(await guideOf(page))}`, {
        cause: error,
      });
    });
  const log = await page.evaluate(() => (window as Logged).__guideLog ?? []);
  expect(log.find((e) => e.step === step)?.text).toBe(words);
}

/**
 * Plays on until `step` shows. The sim runs fast meanwhile, since the guide starts at most one new
 * step every 20 s of the loop's clock, and `keep` holds the creature's state; the frame that sees
 * the step drops back to normal speed, or, with `freeze`, stops the clock in that same frame: a
 * step shows 6 to 8 s of the loop's clock, and the round trips before a screenshot can outlast that
 * on a loaded runner. `shoot` restores normal speed. `fast` is the speed while waiting: `timeScale`
 * adds the real time since the last frame at the old speed to the clock, so after a slow frame at 8
 * the step is already past its 8 s when the freeze lands. A step that shows at once (`swim`, an
 * urgent `hazard`) waits at 1.
 */
async function until(
  page: Page,
  step: GuideStep,
  keep: Keep = {},
  timeout = 30_000,
  freeze = false,
  fast = 8,
): Promise<void> {
  await page
    .waitForFunction(
      ([step, keep, freeze, fast]) => {
        const bs = window.__bs as BsHook;
        (window as Kept).__guideKeep?.(keep);
        if (bs.state().guide.current === step) {
          bs.debug?.timeScale(freeze ? 0 : 1);
          return true;
        }
        bs.debug?.timeScale(fast);
        return false;
      },
      [step, keep, freeze, fast] as const,
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
  // Two resizes and two software-rendered screenshots can outlast a step's 6 s show on a loaded
  // runner: the loop's clock (the guide's too) stands still while the line is judged.
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
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
      // The bars, the minimap and its gauge, the offspring card and the invitation; and the egg.
      const parts = [
        '.hud .stat',
        '.minimap',
        '[data-testid="minimap-depth"]',
        '.offspring',
        '.invite',
      ];
      const boxes = parts
        .flatMap((s) => [...document.querySelectorAll(s)])
        .filter((o) => (o as HTMLElement).checkVisibility())
        .map((o) => o.getBoundingClientRect());
      const egg = (window.__bs as BsHook).state().egg.at;
      if (egg) boxes.push(new DOMRect(egg.x - egg.r, egg.y - egg.r, 2 * egg.r, 2 * egg.r));
      const covers = boxes.some(
        (b) => b.left < r.right && r.left < b.right && b.top < r.bottom && r.top < b.bottom,
      );
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
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
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
    await until(page, 'swim', FULL, 30_000, true, 1);
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
    await until(page, 'hazard', FULL, 10_000, true, 1);
    await expect(page.getByTestId('hint')).toHaveText(GUIDE_WORDS.hazard[0]);
    await shoot(page, 'hazard');
    await page.evaluate(() => {
      const bs = window.__bs as BsHook;
      const p = bs.state().player;
      if (p) bs.debug?.teleport(p.x - p.radius * 40, p.y);
    });
    await gone(page, 'hazard', FULL);

    // Hungry: under 30% of the cap; gone over 50%.
    await until(page, 'energy', { share: 0.2 }, 60_000, true);
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
    // `swim` shows at once, so wait at 1: at 8 a poll can land after the creature swam it away.
    await until(page, 'swim', FULL, 30_000, false, 1);

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

/** Hatches a recorded creature on the guide's hub in a browser that has seen the steps `seen`. */
async function hatched(context: BrowserContext, seen: readonly GuideStep[]): Promise<Page> {
  const page = await context.newPage();
  await prepare(page);
  await page.addInitScript((seen) => {
    if (localStorage.getItem('bs.guide') === null) localStorage.setItem('bs.guide', seen);
  }, JSON.stringify(seen));
  await openRecorded(page, '', M14_GUIDE_HUB);
  await clickHatch(page);
  await waitPlaying(page);
  return page;
}

const idOf = async (page: Page): Promise<string> => (await state(page)).playerId as string;

/** Every step but these: the first test's steps are seen, so each page waits only for its own. */
const seenBut = (steps: GuideStep[]) => GUIDE_STEPS.filter((s) => !steps.includes(s));

test('two players learn the amber rings, the wheel, maturity, the invitation and the egg @slow', async ({
  browser,
}) => {
  test.setTimeout(240_000);
  const contexts = await Promise.all([0, 1].map(() => browser.newContext()));
  const [ctxA, ctxB] = contexts as [BrowserContext, BrowserContext];
  try {
    const [a, b] = await Promise.all([
      hatched(ctxA, seenBut(['bigger', 'wheel', 'mature', 'egg'])),
      hatched(ctxB, seenBut(['invite', 'egg'])),
    ]);
    const idB = await idOf(b);

    // B grows a tier past A, side by side: A sees amber rings and is told what they mean.
    await goTo(a, idB, b);
    const before = (await state(b)).player?.biomass ?? 0;
    await b.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(1200));
    await until(a, 'bigger', FULL, 60_000, true);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.bigger);
    await shoot(a, 'bigger');
    await b.evaluate((m) => (window.__bs as BsHook).debug?.setBiomass(m), before);

    // 30 s after the first link: the wheel. Grown up: told to court (in whichever order they came).
    await told(a, 'wheel', GUIDE_WORDS.wheel);
    await Promise.all([ripe(a), ripe(b)]);
    await told(a, 'mature', GUIDE_WORDS.mature);

    // A courts: B is told how to accept at once; after the round, both are told of the egg.
    await Promise.all([topUp(a), topUp(b)]);
    await courtUntilInvited(a, b, idB);
    await until(b, 'invite', FULL, 10_000);
    await expect(b.getByTestId('hint')).toHaveText(GUIDE_WORDS.invite);
    await b.screenshot({ path: 'test-results/m14-guide-invite-960.png' });
    await b.keyboard.press('e');
    await gone(b, 'invite', FULL);
    await until(a, 'egg', FULL, 60_000, true);
    await until(b, 'egg', FULL, 60_000);
    await expect(a.getByTestId('hint')).toHaveText(GUIDE_WORDS.egg);
    await shoot(a, 'egg');
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import { drawnShot, framesRun, linked, seesMove, watchErrors } from './engines';
import { clickHatch, openRecorded, state, waitPlaying, warmHub } from './helpers';

// The game in the engine under test (M14 T6): the chromium project runs it in Chromium, and the
// firefox and webkit projects (`E2E full` only, ADR 0077) in their own engines. A recorded hatch with
// its egg charged and cracked and its result card; swimming to food, eating and dashing with the
// bars moving; a second page of the same engine that links and moves; the menu, Settings and the
// help panel; the creature's card, verified back to genesis. Every step's screenshot is a drawn
// frame, and no page throws.

const HUB = 'http://localhost:8842';

test.describe.configure({ mode: 'serial' });

/** The egg is poked as it stirs (its paced crack), then Enter cracks it, as `m6c-egg` does. */
async function chargeAndCrack(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const bs = window.__bs as BsHook;
        const canvas = document.getElementById('scene') as HTMLCanvasElement;
        const where = {
          button: 0,
          clientX: innerWidth / 2,
          clientY: innerHeight / 2,
          bubbles: true,
        };
        const look = setInterval(() => {
          const { phase, paced, beaconAt } = bs.state().egg;
          if (phase !== 'stirring' || !paced) return;
          clearInterval(look);
          // Frozen, on the egg's own clock: a slow page neither cracks it by waiting nor squeezes pokes.
          bs.debug?.timeScale(0);
          for (let k = 0; k < 4; k++) {
            bs.debug?.setClock(((beaconAt ?? 0) + 100 + k * 260) / 1000);
            canvas.dispatchEvent(new PointerEvent('pointerdown', where));
            dispatchEvent(new PointerEvent('pointerup', where));
          }
          const { charge } = bs.state().egg;
          bs.debug?.timeScale(1);
          dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
          dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter' }));
          resolve(charge);
        }, 10);
      }),
  );
}

/** Whether the help panel (`state().help`, M14 T8) is open; null on a page without one yet. */
const helpOpen = (): boolean | null =>
  (window.__bs?.state() as { help?: { open: boolean } } | undefined)?.help?.open ?? null;

const cardState = (page: Page): Promise<CardState> =>
  page.evaluate(() => (window.__card as { state(): CardState }).state());

test('the game plays in this engine: hatch, feed, dash, link, menus and a verified card @slow', async ({
  browser,
  browserName,
}, info) => {
  test.setTimeout(300_000);
  await warmHub(HUB);
  const contexts: BrowserContext[] = [];
  // Each page's errors, gathered from its first load.
  const errors: string[][] = [];
  try {
    const open = async (who: string): Promise<Page> => {
      const context = await browser.newContext();
      contexts.push(context);
      const page = await context.newPage();
      errors.push(watchErrors(page, who));
      return page;
    };
    const a = await open('A');

    // A recorded hatch: the egg waits for its beacon, is charged as it stirs, and cracks to its card.
    await openRecorded(a, '', HUB);
    await drawnShot(a, info, 'm14-smoke-title', browserName);
    await clickHatch(a);
    await a.mouse.move(2, 2);
    await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting', undefined, {
      timeout: 15_000,
    });
    const charge = await chargeAndCrack(a);
    expect(charge, 'the pokes charged the egg').toBeGreaterThan(0);
    await waitPlaying(a, { paced: true });
    await a.waitForFunction(() => window.__bs?.state().egg.card.shown, undefined, {
      timeout: 15_000,
    });
    let s = await state(a);
    expect(s.life).toMatchObject({ status: 'playing', practice: false });
    expect(s.egg.phases).toEqual(expect.arrayContaining(['waiting', 'stirring']));
    expect(s.egg.crackedBy).toBe('player');
    expect(s.egg.card.tier).toBe(s.player?.rarity);
    const recorded = await a.evaluate(() => (window.__bs as BsHook).life.recompute());
    expect(recorded?.genomeHash, 'the DNA this engine recomputes').toBe(s.player?.genomeHash);
    await drawnShot(a, info, 'm14-smoke-hatched', browserName);

    // Swimming to food and eating it, then a dash: the bars move.
    const bars = s.hud.bars;
    const eaten = await a.evaluate(async () => {
      const bs = window.__bs as BsHook;
      bs.debug?.setEnergy((bs.state().player?.energy ?? 0) * 0.5);
      for (let k = 0; k < 6; k++) {
        const food = bs.debug?.nearestFood();
        if (food && (await bs.debug?.steerTo(food))) return true;
      }
      return false;
    });
    expect(eaten, 'it swam to food and ate it').toBe(true);
    expect((await a.evaluate(() => (window.__bs as BsHook).events())).eat ?? 0).toBeGreaterThan(0);
    await a.keyboard.press('Space');
    await a.waitForFunction(() => ((window.__bs as BsHook).events().dash ?? 0) > 0, undefined, {
      timeout: 10_000,
    });
    await framesRun(a);
    s = await state(a);
    expect(s.hud.bars, 'the HUD bars moved').not.toEqual(bars);
    await drawnShot(a, info, 'm14-smoke-play', browserName);
    // From here on its belly stays full: the rest of the scenario is no place to starve.
    await a.evaluate(() => (window.__bs as BsHook).debug?.sated(true));

    // A second page of the same engine joins: they link, and each sees the other move. Playwright's
    // Linux WebKit offers only mDNS host candidates, which nothing on a runner resolves, so its pages
    // never link, not even within one page (ADR 0077): Safari's links are an owner check.
    if (browserName === 'webkit') {
      info.annotations.push({
        type: 'skip',
        description: 'WebKit links: ADR 0077, an owner check',
      });
    } else {
      const b = await open('B');
      await openRecorded(b, '', HUB);
      await clickHatch(b);
      await waitPlaying(b);
      await b.evaluate(() => (window.__bs as BsHook).debug?.sated(true));
      const idA = (await state(a)).playerId as string;
      const idB = (await state(b)).playerId as string;
      await Promise.all([linked(a, idB), linked(b, idA)]);
      await seesMove(a, b, idB);
      await seesMove(b, a, idA);
      await drawnShot(a, info, 'm14-smoke-linked', browserName);
    }

    // The menu, and Settings: the quality preset changes and is kept.
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('menu')).toBeVisible();
    await a.getByTestId('menu-settings').click();
    await a.getByTestId('quality-medium').check();
    await expect
      .poll(() => a.evaluate(() => (window.__bs as BsHook).render.info().preset))
      .toBe('medium');
    const kept = await a.evaluate(() => JSON.parse(localStorage.getItem('bs.settings') ?? '{}'));
    expect(kept.quality, 'the choice is stored').toBe('medium');
    await framesRun(a);
    await drawnShot(a, info, 'm14-smoke-settings', browserName);
    await a.getByTestId('quality-low').check();
    await a.getByTestId('settings-close').click();
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('menu')).toBeHidden();

    // The help panel (M14 T8): `?` opens it and Esc closes it, once the page has one.
    if ((await a.evaluate(helpOpen)) !== null) {
      await a.keyboard.press('?');
      await expect.poll(() => a.evaluate(helpOpen), { timeout: 10_000 }).toBe(true);
      await drawnShot(a, info, 'm14-smoke-help', browserName);
      await a.keyboard.press('Escape');
      await expect.poll(() => a.evaluate(helpOpen), { timeout: 10_000 }).toBe(false);
    } else {
      info.annotations.push({ type: 'skip', description: 'the help panel waits for M14 T8' });
    }

    // The creature's card opens from Lineage and checks its history back to genesis.
    const creature = (await state(a)).life.creature as string;
    await a.keyboard.press('Escape');
    await a.getByTestId('menu-lineage').click();
    const link = a.getByTestId('lineage-card').first();
    await expect(link, 'Lineage lists the creature with its card').toBeVisible({ timeout: 20_000 });
    const [card] = await Promise.all([a.context().waitForEvent('page'), link.click()]);
    errors.push(watchErrors(card, 'card'));
    await card
      .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
        timeout: 90_000,
      })
      .catch(async (error) => {
        throw new Error(`the card never finished: ${JSON.stringify(await cardState(card))}`, {
          cause: error,
        });
      });
    expect(await cardState(card)).toMatchObject({
      phase: 'done',
      subject: creature,
      verdict: 'verified',
      drawn: true,
    });
    await expect(card.getByTestId('card-verdict')).toHaveText('Verified back to genesis');
    const cardShot = info.outputPath(`m14-smoke-card-${browserName}.png`);
    await card.screenshot({ path: cardShot });
    await info.attach(`m14-smoke-card-${browserName}`, {
      path: cardShot,
      contentType: 'image/png',
    });
    expect(errors.flat(), 'no page error and no uncaught rejection').toEqual([]);
  } finally {
    await Promise.all(contexts.map((c) => c.close()));
  }
});

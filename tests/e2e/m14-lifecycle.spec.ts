import { type BrowserContext, expect, type Page, test } from '@playwright/test';
import type { CardState } from '../../src/card/hook';
import type { BsHook } from '../../src/game/debug';
import type { GuideStep } from '../../src/game/guide';
import { GUIDE_WORDS } from '../../src/game/guide';
import {
  clickHatch,
  courtUntilInvited,
  M14_LIFECYCLE_HUB,
  openRecorded,
  state,
  topUp,
  waitPlaying,
} from './helpers';
import { crash, grownUp, hold, hubIsWhole, reopen, attach as shoot } from './interrupt-kit';
import { fightToEnd, squareUp } from './m7-fight';

// The v1.0 story in one scenario (M14 T18), on its own hub (8844, `MATING_SCALE` 0.01): a fresh
// browser reads the help and hatches, its tab crashes during the beacon wait and comes back to its
// egg, the guide's first steps go as it swims, eats and dashes; a second player hatches, the two
// court, A's tab crashes on `mating` and comes back to the egg beside it, A becomes its child, B
// fights that child to the referee's hash, the child's card says "Verified back to genesis", and the
// authority is consistent with no flag but `authority-only`.

const HUB = M14_LIFECYCLE_HUB;
const attach = (page: Page, step: string) => shoot(page, 'm14-lifecycle', step);

test.describe.configure({ mode: 'serial' });
test.skip(({ browserName }) => browserName !== 'chromium', '`Page.crash` is Chromium’s');

const bs = (page: Page) => page.evaluate(() => (window.__bs as BsHook).state());

type Logged = Window & { __guideLog?: string[]; __eatNow?: boolean };

/**
 * From each load, every 100 ms: records the guide steps the page has shown and keeps the belly full
 * (`debug.sated`) until the test lets the creature eat, so no meal ends the `eat` step before it shows.
 */
const watchGuide = (context: BrowserContext) =>
  context.addInitScript(() => {
    const log: string[] = [];
    (window as Logged).__guideLog = log;
    setInterval(() => {
      const bs = window.__bs as BsHook | undefined;
      if (!bs?.ready) return;
      if (!(window as Logged).__eatNow) bs.debug?.sated(true);
      const guide = bs.state().guide;
      if (guide?.current && log.at(-1) !== guide.current) log.push(guide.current);
    }, 100);
  });

/** Plays on at normal speed (the hub credits wall time), belly full and `nearFood` kept within 3 radii of food, until the page has shown `step`. */
async function shown(page: Page, step: GuideStep, nearFood = false): Promise<void> {
  await page
    .waitForFunction(
      ([step, nearFood]) => {
        const bs = window.__bs as BsHook;
        const debug = bs.debug;
        const p = bs.state().player;
        debug?.sated(true);
        const food = nearFood ? debug?.nearestFood() : null;
        if (food && p && Math.hypot(food.x - p.x, food.y - p.y) > p.radius * 4) {
          debug?.teleport(food.x - p.radius * 3, food.y);
        }
        return (window as Logged).__guideLog?.includes(step) ?? false;
      },
      [step, nearFood] as const,
      { timeout: 60_000, polling: 100 },
    )
    .catch(async (error) => {
      throw new Error(`the guide never showed ${step}: ${JSON.stringify((await bs(page)).guide)}`, {
        cause: error,
      });
    });
}

/** Waits until the step is gone from the screen and remembered as seen (the belly stays full). */
async function gone(page: Page, step: GuideStep): Promise<void> {
  await page
    .waitForFunction(
      (step) => {
        const bs = window.__bs as BsHook;
        bs.debug?.sated(true);
        const { current, seen } = bs.state().guide;
        return current !== step && seen.includes(step);
      },
      step,
      { timeout: 20_000, polling: 100 },
    )
    .catch(async (error) => {
      throw new Error(`${step} never went: ${JSON.stringify((await bs(page)).guide)}`, {
        cause: error,
      });
    });
}

test('the v1.0 story: help, a crashed hatch, the guide, a crashed mating, a promotion, a fight and a verified card @slow', async ({
  browser,
  request,
}) => {
  test.setTimeout(480_000);
  await hold(request, HUB, false);
  const contexts: BrowserContext[] = [];
  try {
    // A fresh browser: the title offers "How to play", and `?` opens the help and Esc closes it.
    const ctxA = await browser.newContext({ viewport: { width: 960, height: 540 } });
    contexts.push(ctxA);
    await watchGuide(ctxA);
    let a = await ctxA.newPage();
    await openRecorded(a, '', HUB);
    await expect(a.getByTestId('title-help')).toHaveText('New here? How to play');
    await a.keyboard.press('?');
    await expect(a.getByTestId('help')).toBeVisible();
    await a.keyboard.press('Escape');
    await expect(a.getByTestId('help')).toBeHidden();
    const idA = (await bs(a)).playerId as string;

    // A hatches and its renderer crashes while the egg waits for its round.
    await a.waitForFunction(() => window.__bs?.state().net.status === 'online');
    await hold(request, HUB, true);
    await clickHatch(a);
    await a.waitForFunction(() => window.__bs?.state().life.status === 'awaiting', undefined, {
      timeout: 20_000,
    });
    await crash(a);

    // Reopened: the egg waits, the round comes, the reveal plays, and the creature is the committed one.
    a = await reopen(ctxA, HUB);
    await a.waitForFunction(() => window.__bs?.state().egg.phase === 'waiting', undefined, {
      timeout: 20_000,
    });
    await expect(a.getByTestId('hatch')).toBeHidden();
    await attach(a, 'egg');
    await hold(request, HUB, false);
    await waitPlaying(a);
    const hatched = await bs(a);
    const recomputed = await a.evaluate(() => (window.__bs as BsHook).life.recompute());
    expect(recomputed?.genomeHash).toBe(hatched.player?.genomeHash);
    const a0 = hatched.life.creature as string;

    // The guide: swim, eat and dash each show, and each goes as A does what it says.
    await shown(a, 'swim');
    expect(await a.getByTestId('hint').textContent()).toBe(GUIDE_WORDS.swim);
    await a.evaluate(async () => {
      const b = window.__bs as BsHook;
      const p = b.state().player;
      if (p) await b.debug?.steerTo({ x: p.x + p.radius * 10, y: p.y });
    });
    await gone(a, 'swim');
    await shown(a, 'eat');
    await a.evaluate(async () => {
      const b = window.__bs as BsHook;
      (window as Logged).__eatNow = true;
      b.debug?.sated(false);
      b.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      b.debug?.setEnergy((b.state().player?.energy ?? 0) * 0.6);
      const food = b.debug?.nearestFood();
      if (food) await b.debug?.steerTo(food);
    });
    await gone(a, 'eat');
    await shown(a, 'dash', true);
    await a.keyboard.press('Space');
    await gone(a, 'dash');
    await a.evaluate(() => {
      (window as Logged).__eatNow = true;
      (window.__bs as BsHook).debug?.sated(false);
    });
    await attach(a, 'guide');

    // B hatches in a browser of its own; both grow up and A courts B, who accepts.
    const ctxB = await browser.newContext({ viewport: { width: 960, height: 540 } });
    contexts.push(ctxB);
    const b = await ctxB.newPage();
    await openRecorded(b, '', HUB);
    await clickHatch(b);
    await waitPlaying(b);
    const idB = (await bs(b)).playerId as string;
    await Promise.all([grownUp(a), grownUp(b)]);
    await Promise.all([topUp(a), topUp(b)]);
    await courtUntilInvited(a, b, idB);
    // A's world stands still and the hub has its last report; then the round is held.
    await a.evaluate(async () => {
      const hook = window.__bs as BsHook;
      hook.debug?.timeScale(0);
      await hook.debug?.progressNow();
    });
    await hold(request, HUB, true);
    await b.keyboard.press('e');
    await a.waitForFunction(() => window.__bs?.state().mate.state === 'awaiting', undefined, {
      timeout: 20_000,
    });
    // B waits through A's crashes and the beacon, minutes of play: in the shallows the sun would
    // burn it to the death screen before its fight, so it waits somewhere calm.
    await b.evaluate(() => (window.__bs as BsHook).debug?.setZone('twilight'));
    // A's renderer crashes on `mating`.
    await crash(a);
    a = await reopen(ctxA, HUB);
    await a.waitForFunction(() => window.__bs?.state().life.inFlight.mating !== null, undefined, {
      timeout: 20_000,
    });
    await clickHatch(a);
    await waitPlaying(a);
    await a.waitForFunction(() => window.__bs?.state().egg.shown === true);
    expect((await bs(a)).life.creature).toBe(a0);
    await attach(a, 'mating');
    // The round comes: `born` reveals the child to both.
    await hold(request, HUB, false);
    for (const page of [a, b]) {
      await page.waitForFunction(() => window.__bs?.state().offspring.kind === 'card', undefined, {
        timeout: 40_000,
      });
    }
    const child = (await bs(a)).offspring.creature as string;
    expect(child).toBeTruthy();

    // A becomes its child (H).
    await a.keyboard.press('h');
    await a.waitForFunction(
      (child) => {
        const s = window.__bs?.state();
        return s?.life.creature === child && s?.screen === 'playing';
      },
      child,
      { timeout: 30_000 },
    );
    await attach(a, 'child');

    // B engages A's child, and the fight ends on the referee's hash on both pages.
    await Promise.all(
      [a, b].map((page) =>
        page.evaluate(() => {
          const debug = (window.__bs as BsHook).debug;
          debug?.timeScale(1);
          debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        }),
      ),
    );
    await squareUp(b, a, idA);
    const fight = await fightToEnd(b, a, { idA: idB, idB: idA });
    const ends = await Promise.all([a, b].map(async (page) => (await state(page)).encounter));
    for (const end of ends) {
      expect(end?.id).toBe(fight);
      expect(end?.hash).toBe(end?.endHash);
      expect(end?.desyncs).toBe(0);
    }
    expect(ends[0]?.endHash).toBe(ends[1]?.endHash);

    // The child's card says "Verified back to genesis", and nothing about renewals.
    const reader = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    contexts.push(reader);
    const card = await reader.newPage();
    await card.goto(`./card.html?c=${child}&hub=${HUB}&quality=low`);
    await card
      .waitForFunction(() => ['done', 'error'].includes(window.__card?.state().phase ?? ''), null, {
        timeout: 60_000,
      })
      .catch(async (error) => {
        const now = await card.evaluate(() => JSON.stringify(window.__card?.state()));
        throw new Error(`the card never finished: ${now}`, { cause: error });
      });
    const verified = await card.evaluate(() => (window.__card as { state(): CardState }).state());
    expect(verified).toMatchObject({
      phase: 'done',
      subject: child,
      verdict: 'verified',
      toGenesis: true,
      problems: [],
      missing: 0,
    });
    expect(verified.verdictText).toMatch(/^Verified back to genesis/);
    expect(JSON.stringify(verified)).not.toMatch(/renew/i);
    expect(verified.fights.replayed).toBe(verified.fights.settled);
    await attach(card, 'card');

    // The authority: consistent, no flag but `authority-only`, and a meter that counted the day.
    await hubIsWhole(request, HUB);
    const metrics = (await (await request.get(`${HUB}/v1/e2e/metrics`)).json()) as {
      today: {
        messages: number;
        byType: Record<string, number>;
        perPlayerMinute: { messages: number } | null;
      };
      admission: { waits: unknown };
    };
    expect(metrics.today.messages).toBeGreaterThan(0);
    expect(Object.keys(metrics.today.byType).length).toBeGreaterThan(0);
    expect(metrics.today.perPlayerMinute).not.toBeNull();
    expect(metrics.admission).toHaveProperty('waits');
  } finally {
    await hold(request, HUB, false).catch(() => {});
    await Promise.all(contexts.map((c) => c.close()));
  }
});

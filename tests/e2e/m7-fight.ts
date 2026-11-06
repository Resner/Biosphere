import type { Browser, Page } from '@playwright/test';
import { expect } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { RULES } from '../../src/sim/rules';
import { clickHatch, goTo, openRecorded, state, topUp, waitPlaying } from './helpers';

// Shared by the M7 hub specs: two hatched players, one hurt, and a fight A starts with F.

/**
 * The longest a fight can run on the wall clock: the referee plays 10 frames a second whatever the
 * runner does, and the rules end a fight after `timeoutFrames`. A wait for the fight's end is
 * bounded by that, with a margin, never by a guess of how long a fight usually takes.
 */
export const FIGHT_WALL_MS = (RULES.encounter.timeoutFrames / 10 + 15) * 1000;

export async function open(browser: Browser, hub: string, extra = '&quality=low'): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, extra, hub);
  // No picture: software rendering is the cost of a frame on a runner, and a page that draws a
  // frame in over 100 ms misses the referee's input deadline, so the autopilot flies that frame (B
  // flees, or A loses its strikes). The scene still updates, so `state()` and `render.info()` hold.
  await page.evaluate(() => (window.__bs as BsHook).debug?.skipDraw(true));
  return page;
}

/** What the test reads of a page while it waits, for a failure's message. */
/** One fight as A saw it, for the failure messages: each fighter's tag, health, stance and outcome, and the frame. */
export async function fightLine(a: Page, ids: { idA: string; idB: string }): Promise<string> {
  const enc = (await state(a)).encounter;
  const who = enc?.fighters.map(
    (f) =>
      `${f.player === ids.idA ? 'A' : 'B'} ${Math.round(f.health)}hp ${f.stance} ${f.outcome} at ${Math.round(f.x)},${Math.round(f.y)}`,
  );
  return `frame ${enc?.frame}: ${who?.join(' | ')}`;
}

export const seen = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__bs as BsHook).state();
    return {
      screen: s.screen,
      player: s.player && { x: s.player.x, y: s.player.y, health: s.player.health },
      remotes: s.remotes.map(({ id, x, y, radius, alpha, protected: p, fighting }) => ({
        id,
        x,
        y,
        radius,
        alpha,
        p,
        fighting,
      })),
      attack: s.attack,
      net: s.net,
      carrion: s.carrion.length,
      encounter: s.encounter && {
        id: s.encounter.id,
        frame: s.encounter.frame,
        over: s.encounter.over,
        fighters: s.encounter.fighters.map((f) => ({
          x: Math.round(f.x),
          y: Math.round(f.y),
          health: f.health,
          outcome: f.outcome,
        })),
      },
    };
  });

/**
 * A and B hatch; B reloads and resumes (a genesis is spawn-protected for 15 s, a resume is not),
 * swims somewhere calm and drops to a third of its health; A waits until it sees B unprotected.
 */
export async function stage(
  a: Page,
  b: Page,
  between?: () => Promise<void>,
  /** B's health after the hurt, as a share of its maximum. */
  hurt = 0.3,
): Promise<{ idA: string; idB: string }> {
  await Promise.all(
    [a, b].map(async (page) => {
      await clickHatch(page);
      await waitPlaying(page);
    }),
  );
  // Whatever the players do before B resumes (the kill spec mates them here).
  await between?.();
  await b.reload();
  await b.waitForFunction(() => window.__bs?.state().playerId);
  await clickHatch(b);
  await waitPlaying(b);
  const idA = (await state(a)).playerId as string;
  const idB = (await state(b)).playerId as string;

  // B somewhere calm (no UV or pressure), hurt. Its autopilot plays whenever its tab is hidden, and flees below `caution × 0.6` of its health, so 0.6 or more never flees and a lower share leaves a cautious genome running.
  await b.evaluate((share) => {
    const debug = (window.__bs as BsHook).debug;
    const p = (window.__bs as BsHook).state().player;
    debug?.setZone('twilight');
    if (p) debug?.setHealth(p.health * share);
  }, hurt);
  await a
    .waitForFunction(
      (who) =>
        window.__bs?.state().remotes.some((r) => r.id === who && !r.protected && r.alpha > 0.5),
      idB,
      { timeout: 20_000 },
    )
    .catch(async (error) => {
      throw new Error(`A never saw B unprotected: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  return { idA, idB };
}

/** A parks beside B until the "F" glyph marks B (B drifts, and a loaded runner draws it late). */
export async function parkBeside(a: Page, idB: string): Promise<void> {
  await expect(async () => {
    await a.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const r = bs.state().remotes.find((x) => x.id === who);
      const p = bs.state().player;
      if (r && p) bs.debug?.teleport(r.x - r.radius - p.radius * 1.1, r.y);
    }, idB);
    await a.waitForFunction((who) => window.__bs?.state().attack.hint === who, idB, {
      timeout: 2_000,
    });
  }, 'A parks beside B and the glyph marks B')
    .toPass({ timeout: 30_000 })
    .catch(async (error) => {
      throw new Error(`no glyph on B: ${JSON.stringify(await seen(a))}`, { cause: error });
    });
}

/**
 * A presses F (parking beside B again whenever B has drifted off and the fight did not start),
 * sets its aggressive stance in the frame it first sees the fight, and swims onto B until the
 * referee ends the fight on both pages. Returns the encounter's id.
 */
export async function fightToEnd(
  a: Page,
  b: Page,
  ids: { idA: string; idB: string },
  previous?: string,
): Promise<string | undefined> {
  await expect(async () => {
    await parkBeside(a, ids.idB);
    // The engage carries A's signed snapshot: let a few snapshots leave from the new place first,
    // or the fight starts with A where it was and B escapes from it.
    const at = (await state(a)).tick;
    await a.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
      timeout: 8_000,
    });
    await a.keyboard.press('f');
    await a.waitForFunction(
      (old) => {
        const enc = window.__bs?.state().encounter;
        return enc !== null && enc?.id !== old;
      },
      previous,
      { timeout: 4_000 },
    );
  }, 'A engages B')
    .toPass({ timeout: 40_000 })
    .catch(async (error) => {
      throw new Error(`A's fight never started: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  // A braces by itself against B's windups: B hits as hard as A, and an A left at a few points
  // dies of the water before the next try.
  await a.evaluate(() => (window.__bs as BsHook).debug?.autoBrace(true));
  // A starts swimming onto B at once: the escape clock (3 s outside range) runs from the first
  // frame, and a chase that waits for B's page to show the fight loses a slow runner's fights. It
  // runs until the referee ends the fight.
  const chase = a
    .waitForFunction(
      (who) => {
        const bs = window.__bs as BsHook;
        const s = bs.state();
        if (s.encounter?.over) return true;
        // Once B is nearly dead, A's belly is filled: a full creature eats no carrion, so the
        // pieces its kill leaves are not nibbled away (filled earlier, the belly turns into growth,
        // and B's autopilot flees from a body over 1.5 times its size).
        const foe = s.encounter?.fighters.find((f) => f.player === who);
        if (foe && foe.health < foe.maxHealth * 0.3) bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
        const r = s.remotes.find((x) => x.id === who);
        if (r) void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
        return false;
      },
      ids.idB,
      { timeout: FIGHT_WALL_MS, polling: 250 },
    )
    .catch(async (error) => {
      throw new Error(`the fight never ended: ${JSON.stringify(await seen(a))}`, {
        cause: error,
      });
    });
  // Swallowed here, awaited below: a rejection while B's wait runs must not go unhandled.
  chase.catch(() => undefined);
  await a.evaluate(() => {
    dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
    dispatchEvent(new KeyboardEvent('keyup', { key: '1' }));
  });
  const encA = (await state(a)).encounter;
  await b.waitForFunction((id) => window.__bs?.state().encounter?.id === id, encA?.id, {
    timeout: 5_000,
  });
  await chase;
  await b.waitForFunction(() => window.__bs?.state().encounter?.over === true, undefined, {
    timeout: 10_000,
  });
  return encA?.id;
}

/**
 * Fights until B is killed: a fight can end with a fighter drifting out of range (B at a third of
 * its health still stands, or A loses it), and B is still there to engage again. Returns the id of
 * the fight that killed it.
 */
export async function killB(
  a: Page,
  b: Page,
  ids: { idA: string; idB: string },
  /** B's health at the start of each fight, as a share of its maximum (as in `stage`). */
  hurt = 0.6,
): Promise<string> {
  let previous: string | undefined;
  const fights: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    // A whole again for each try, and B fed: a hurt B that starves dies of the water (a `died`
    // outcome, not a kill) and cannot be engaged again. Never A: its full belly turns into growth,
    // and B's autopilot flees from a body over 1.5 times its size.
    await a.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));
    await topUp(b);
    // B back to its starting health: a B left at a few points by the last fight flees in the next
    // one, and A, hitting nothing from out of reach, is told it escaped.
    await b.evaluate((share) => {
      const debug = (window.__bs as BsHook).debug;
      debug?.setHealth(Number.MAX_SAFE_INTEGER);
      const p = (window.__bs as BsHook).state().player;
      if (p) debug?.setHealth(p.health * share);
    }, hurt);
    previous = await fightToEnd(a, b, ids, previous);
    const outcomes = (await state(a)).encounter?.fighters.map((f) => f.outcome);
    fights.push(await fightLine(a, ids));
    if (outcomes?.includes('killed') && previous) return previous;
  }
  throw new Error(
    `B survived four fights:\n${fights.join('\n')}\n${JSON.stringify(await seen(a))}`,
  );
}

/** `courter` courts `partner`, who accepts: both end up carrying an egg (a pending child). */
export async function mate(courter: Page, partner: Page): Promise<void> {
  const who = (await state(partner)).playerId as string;
  await Promise.all([topUp(courter), topUp(partner)]);
  // The partner drifts and the hub's answer takes a moment: stay beside them until the key is offered.
  await expect(async () => {
    await goTo(courter, who);
    await expect(courter.getByTestId('mate-hint')).toHaveText(/^E: court /, { timeout: 1500 });
  }).toPass({ timeout: 30_000 });
  await courter.keyboard.press('e');
  await courter.keyboard.press('e');
  await expect(partner.getByTestId('invite')).toBeVisible({ timeout: 15_000 });
  await partner.keyboard.press('e');
  for (const page of [courter, partner]) {
    await page.waitForFunction(() => window.__bs?.state().offspring.kind === 'card', undefined, {
      timeout: 60_000,
    });
  }
}

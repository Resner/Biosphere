import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M7_DUEL_HUB, openRecorded, state, waitPlaying } from './helpers';

// The first hub duel (M7 T11): A parks beside B, B (resumed, so not spawn-protected) lowers its
// health, and A presses F. Both clients get the same `enc-start`, A picks a stance that B's client
// shows, A swims onto B and kills it, both clients' final hash equals the referee's, and B's death
// screen names the cause.

test.describe.configure({ mode: 'serial' });

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M7_DUEL_HUB);
  return page;
}

/** What the test reads of a page while it waits, for a failure's message. */
const seen = (page: Page) =>
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
      encounter: s.encounter && {
        id: s.encounter.id,
        frame: s.encounter.frame,
        over: s.encounter.over,
        fighters: s.encounter.fighters.map((f) => ({ health: f.health, outcome: f.outcome })),
      },
    };
  });

test('A engages B with F, both play the same fight, and A kills B', async ({ browser }) => {
  test.setTimeout(90_000);
  const [a, b] = await Promise.all([open(browser), open(browser)]);
  try {
    await Promise.all(
      [a, b].map(async (page) => {
        await clickHatch(page);
        await waitPlaying(page);
      }),
    );
    // A genesis is spawn-protected for 15 s; a resume is not. B reloads and resumes its creature.
    await b.reload();
    await b.waitForFunction(() => window.__bs?.state().playerId);
    await clickHatch(b);
    await waitPlaying(b);
    const idA = (await state(a)).playerId as string;
    const idB = (await state(b)).playerId as string;

    // B somewhere calm (no UV or pressure), at 60% of its health: its autopilot plays whenever its
    // tab is hidden and flees below `caution × 0.6` of its health, so a lower share leaves a
    // cautious genome running (the fight then ends in an escape, not a kill).
    await b.evaluate(() => {
      const debug = (window.__bs as BsHook).debug;
      const p = (window.__bs as BsHook).state().player;
      debug?.setZone('twilight');
      if (p) debug?.setHealth(p.health * 0.6);
    });
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

    // A parks beside B until the "F" glyph marks B (B drifts, and a loaded runner draws it late),
    // lets a few snapshots leave from the new place (the engage carries A's signed snapshot, and
    // an engage from a stale place is refused), and presses F; if no fight starts, it parks and
    // presses again.
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
      const at = (await state(a)).tick;
      await a.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
        timeout: 8_000,
      });
      await expect(a.getByTestId('attack-hint')).toBeVisible();
      const before = (await a.evaluate(() => (window.__bs as BsHook).render.fx())).engage;
      await a.keyboard.press('f');
      // The engage ring was asked for in the key press itself.
      expect((await a.evaluate(() => (window.__bs as BsHook).render.fx())).engage).toBe(before + 1);
      await a.waitForFunction(
        () => {
          const enc = window.__bs?.state().encounter;
          return enc !== null && enc !== undefined;
        },
        undefined,
        { timeout: 4_000 },
      );
    }, 'A parks beside B, presses F and the fight starts')
      .toPass({ timeout: 40_000 })
      .catch(async (error) => {
        throw new Error(`A's fight never started: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });

    // Both get `enc-start`. A sets its stance (1: aggressive) from the frame it sees the fight and
    // presses again every frame until its own view shows it (a press that lands past the deadline
    // is dropped, and a loaded runner can miss the first frames).
    await a
      .waitForFunction(
        (me) => {
          const enc = window.__bs?.state().encounter;
          if (!enc || enc.over) return false;
          if (enc.fighters.find((f) => f.player === me)?.stance === 'aggressive') return true;
          dispatchEvent(new KeyboardEvent('keydown', { key: '1' }));
          dispatchEvent(new KeyboardEvent('keyup', { key: '1' }));
          return false;
        },
        idA,
        { timeout: 15_000, polling: 'raf' },
      )
      .catch(async (error) => {
        throw new Error(`A's stance never showed: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });
    const encA = (await state(a)).encounter;
    await b
      .waitForFunction(
        ([id, me]) => {
          const enc = window.__bs?.state().encounter;
          return (
            enc?.id === id && enc?.fighters.find((f) => f.player === me)?.stance === 'aggressive'
          );
        },
        [encA?.id, idA] as const,
        { timeout: 10_000 },
      )
      .catch(async (error) => {
        throw new Error(`B never saw A's stance: ${JSON.stringify(await seen(b))}`, {
          cause: error,
        });
      });

    // A swims onto B (debug steering works in a fight) until the referee ends it.
    await a
      .waitForFunction(
        (who) => {
          const bs = window.__bs as BsHook;
          const s = bs.state();
          if (s.encounter?.over) return true;
          const r = s.remotes.find((x) => x.id === who);
          if (r) void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
          return false;
        },
        idB,
        { timeout: 40_000, polling: 250 },
      )
      .catch(async (error) => {
        throw new Error(`the fight never ended: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });
    await b.waitForFunction(() => window.__bs?.state().encounter?.over === true, undefined, {
      timeout: 10_000,
    });

    const [endA, endB] = [(await state(a)).encounter, (await state(b)).encounter];
    for (const enc of [endA, endB]) {
      expect(enc?.id).toBe(encA?.id);
      expect(enc?.endHash).toMatch(/^[0-9a-f]+$/);
      expect(enc?.hash).toBe(enc?.endHash);
    }
    expect(endA?.endHash).toBe(endB?.endHash);
    const fighterOf = (enc: typeof endA, who: string) =>
      enc?.fighters.find((f) => f.player === who);
    // The stance A picked shows on B's client.
    expect(fighterOf(endB, idA)?.stance).toBe('aggressive');
    expect(fighterOf(endA, idB)?.outcome).toBe('killed');
    expect(fighterOf(endB, idB)?.outcome).toBe('killed');

    // B's death screen names the cause.
    await b.waitForFunction(() => window.__bs?.state().screen === 'dead', undefined, {
      timeout: 10_000,
    });
    expect((await state(b)).death?.cause).toBe('killed');
    await expect(b.getByTestId('death-cause')).toContainText('Killed');
    expect((await state(a)).player?.alive).toBe(true);
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

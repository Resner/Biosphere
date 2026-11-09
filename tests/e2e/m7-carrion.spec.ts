import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M7_CARRION_HUB, state, waitPlaying } from './helpers';
import { killB, open, seen, stage } from './m7-fight';

// Carrion in play (M7 T14): A kills B; C, a third player who only watches, sees the pieces appear,
// eats one, and the piece is gone on A's client too (the claim settled it).

test.describe.configure({ mode: 'serial' });

test('a kill drops carrion that a spectator eats, and the piece is gone for the killer', async ({
  browser,
}) => {
  test.setTimeout(300_000);
  const pages: Page[] = [];
  const openPair = async (): Promise<[Page, Page]> => {
    await Promise.all(pages.splice(0).map((page) => page.context().close()));
    const pair = await Promise.all([open(browser, M7_CARRION_HUB), open(browser, M7_CARRION_HUB)]);
    pages.push(...pair);
    return pair;
  };
  const c = await open(browser, M7_CARRION_HUB);
  try {
    await clickHatch(c);
    await waitPlaying(c);
    // C only watches, through up to three staged pairs of fights (minutes on a loaded runner): left
    // alone it starves and the carrion has no one to reach. A keep-alive in its page holds its health
    // and belly full until the test sets C's own energy for the eating check.
    await c.evaluate(() => {
      const bs = window.__bs as BsHook;
      const w = window as unknown as { __keep?: number };
      w.__keep = window.setInterval(() => {
        bs.debug?.setHealth(Number.MAX_SAFE_INTEGER);
        bs.debug?.setEnergy(Number.MAX_SAFE_INTEGER);
      }, 500);
    });

    // B's genome decides whether its autopilot can be caught: below `caution x 0.6` of its health
    // it flees, and a swift one outruns A in every fight (each ends as A's escape), so a retry on
    // the same pair repeats. The pair is staged again on fresh pages (a new genome), up to 3 times.
    let [a, b] = await openPair();
    let ids = await stage(a, b, undefined, 0.6);
    let enc: string | undefined;
    for (let round = 0; ; round++) {
      if (round > 0) {
        [a, b] = await openPair();
        ids = await stage(a, b, undefined, 0.6);
      }
      expect((await state(a)).carrion).toEqual([]);
      // A's kill reward opens as much room in its belly as the pieces hold, so it would eat them
      // before C saw one. A holds its belly full once pieces lie on the water.
      await a.evaluate(() => (window.__bs as BsHook).debug?.holdBelly(true));
      try {
        enc = await killB(a, b, ids);
        break;
      } catch (error) {
        const message = String((error as Error).message);
        if (round >= 2 || !/^(B survived four fights|A was killed)/.test(message)) {
          throw error;
        }
      }
    }

    // Everyone in the pond drops the pieces from the one `carrion` message, named for the fight. A
    // round that ended with A killed too left its own pieces on C's water, so only this fight's
    // pieces are judged (and waited for).
    const prefix = `x${enc?.slice(0, 8)}`;
    await c
      .waitForFunction(
        (own) =>
          (window.__bs?.state().carrion.filter((p) => p.id.startsWith(own)).length ?? 0) >= 1,
        prefix,
        { timeout: 15_000 },
      )
      .catch(async (error) => {
        throw new Error(`no carrion reached C: ${JSON.stringify(await seen(c))}`, { cause: error });
      });
    const onC = (await state(c)).carrion.filter((p) => p.id.startsWith(prefix));
    expect(onC.length).toBeLessThanOrEqual(12);
    for (const p of onC) {
      expect(p.value).toBeGreaterThan(0);
      expect(p.radius).toBeGreaterThan(1.5);
    }

    // C goes to the piece farthest from A, which sits at the body and eats what it reaches.
    const me = (await state(a)).player;
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - (me?.x ?? 0), p.y - (me?.y ?? 0));
    const piece = [...onC].sort((p, q) => far(q) - far(p))[0];
    if (!piece) throw new Error('no piece');
    await c.evaluate((id) => {
      const bs = window.__bs as BsHook;
      // The keep-alive stops here: a full belly could not take the piece's value.
      window.clearInterval((window as unknown as { __keep?: number }).__keep);
      bs.debug?.setHealth(Number.MAX_SAFE_INTEGER);
      bs.debug?.setEnergy(20);
      // The belly drains while C swims over (on a slow runner for a long while), so its level
      // proves nothing. Watch the frame in which the piece leaves C's world: eating adds its
      // value in that same tick, which beats a frame's drain.
      const w = window as unknown as { __ate?: { gain: number | null } };
      const ate = { gain: null as number | null };
      w.__ate = ate;
      let last = bs.state();
      const watch = () => {
        const now = bs.state();
        const was = last.carrion.some((p) => p.id === id);
        const is = now.carrion.some((p) => p.id === id);
        if (was && !is && ate.gain === null) {
          ate.gain = (now.player?.energy ?? 0) - (last.player?.energy ?? 0);
        }
        last = now;
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }, piece.id);
    // Beside it first: only the pieces in view are drawn.
    await c.evaluate((at) => (window.__bs as BsHook).debug?.teleport(at.x + 60, at.y), piece);
    await c.waitForFunction(
      () => (window.__bs as BsHook).render.info().carrionInstances > 0,
      undefined,
      {
        timeout: 10_000,
      },
    );
    await expect(async () => {
      // A mouth sits ahead of the body centre by a DNA-dependent offset, so a cell placed on the
      // piece may not reach it: C starts a little way off and swims onto it.
      await c.evaluate((at) => {
        const debug = (window.__bs as BsHook).debug;
        debug?.teleport(at.x + 50, at.y);
        void debug?.steerTo({ x: at.x, y: at.y });
      }, piece);
      await c.waitForFunction(
        (id) => !window.__bs?.state().carrion.some((p) => p.id === id),
        piece.id,
        { timeout: 5_000 },
      );
    }, 'C reaches the piece and eats it')
      .toPass({ timeout: 30_000 })
      .catch(async (error) => {
        throw new Error(`C never ate it: ${JSON.stringify(await seen(c))}`, { cause: error });
      });
    // The piece left C's world by C's own claim: its energy rose in that frame.
    await c.waitForFunction(
      () => (window as unknown as { __ate?: { gain: number | null } }).__ate?.gain != null,
      undefined,
      { timeout: 5_000 },
    );
    const gain = await c.evaluate(
      () => (window as unknown as { __ate: { gain: number } }).__ate.gain,
    );
    expect(gain).toBeGreaterThan(0);

    // The claim reaches A: the piece is gone there as well, and the others are still there.
    await a
      .waitForFunction((id) => !window.__bs?.state().carrion.some((p) => p.id === id), piece.id, {
        timeout: 15_000,
      })
      .catch(async (error) => {
        throw new Error(`the piece stayed on A: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });
  } finally {
    await Promise.all([...pages, c].map((page) => page.context().close()));
  }
});

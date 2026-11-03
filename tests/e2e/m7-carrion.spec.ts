import { expect, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M7_CARRION_HUB, state, waitPlaying } from './helpers';
import { killB, open, seen, stage } from './m7-fight';

// Carrion in play (M7 T14): A kills B; C, a third player who only watches, sees the pieces appear,
// eats one, and the piece is gone on A's client too (the claim settled it).

test.describe.configure({ mode: 'serial' });

test('a kill drops carrion that a spectator eats, and the piece is gone for the killer', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const [a, b, c] = await Promise.all([
    open(browser, M7_CARRION_HUB),
    open(browser, M7_CARRION_HUB),
    open(browser, M7_CARRION_HUB),
  ]);
  try {
    await clickHatch(c);
    await waitPlaying(c);
    const { idB } = await stage(a, b);
    expect((await state(a)).carrion).toEqual([]);

    const enc = await killB(a, b, idB);

    // Everyone in the pond drops the pieces from the one `carrion` message, named for the fight.
    // A, still beside the body, may already have eaten some, so only C's view is the whole drop.
    await c
      .waitForFunction(() => (window.__bs?.state().carrion.length ?? 0) >= 3, undefined, {
        timeout: 15_000,
      })
      .catch(async (error) => {
        throw new Error(`no carrion reached C: ${JSON.stringify(await seen(c))}`, { cause: error });
      });
    const onC = (await state(c)).carrion;
    expect(onC.length).toBeLessThanOrEqual(12);
    for (const p of onC) {
      expect(p.id.startsWith(`x${enc?.slice(0, 8)}_`)).toBe(true);
      expect(p.value).toBeGreaterThan(0);
      expect(p.radius).toBeGreaterThan(1.5);
    }

    // C goes to the piece farthest from A, which sits at the body and eats what it reaches.
    const me = (await state(a)).player;
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - (me?.x ?? 0), p.y - (me?.y ?? 0));
    const piece = [...onC].sort((p, q) => far(q) - far(p))[0];
    if (!piece) throw new Error('no piece');
    await c.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(20));
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
      await c.evaluate((at) => (window.__bs as BsHook).debug?.teleport(at.x, at.y), piece);
      await c.waitForFunction(
        (id) => !window.__bs?.state().carrion.some((p) => p.id === id),
        piece.id,
        { timeout: 2_000 },
      );
    }, 'C reaches the piece and eats it')
      .toPass({ timeout: 30_000 })
      .catch(async (error) => {
        throw new Error(`C never ate it: ${JSON.stringify(await seen(c))}`, { cause: error });
      });
    expect((await state(c)).player?.energy ?? 0).toBeGreaterThan(20);

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
    await Promise.all([a, b, c].map((page) => page.context().close()));
  }
});

import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M7_MELEE_HUB, state, waitPlaying } from './helpers';
import { open, parkBeside, seen, stage } from './m7-fight';

// A three-way fight (M7 T15): A engages B with F, and C, parked on B's other side, presses F the
// moment B is fighting: C joins A and B's fight as the third fighter. All three clients step the
// same three-fighter encounter; C's Tab picks a target and its ring shows. A and C then swim off
// in opposite directions until the fight ends, and every client's hash equals the referee's.

test.describe.configure({ mode: 'serial' });

/** C parks on B's far side (from A) until its "F" glyph marks B. */
async function parkOpposite(c: Page, idB: string): Promise<void> {
  await expect(async () => {
    await c.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const r = bs.state().remotes.find((x) => x.id === who);
      const p = bs.state().player;
      if (r && p) bs.debug?.teleport(r.x + r.radius + p.radius * 1.1, r.y);
    }, idB);
    await c.waitForFunction((who) => window.__bs?.state().attack.hint === who, idB, {
      timeout: 2_000,
    });
  }, 'C parks beside B and the glyph marks B').toPass({ timeout: 30_000 });
}

/** Waits until `page`'s own snapshots have left from where it now is (the engage carries one). */
async function settled(page: Page): Promise<void> {
  const at = (await state(page)).tick;
  await page.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
    timeout: 8_000,
  });
}

test('C joins A and B’s fight, and all three clients’ hashes equal the referee’s', async ({
  browser,
}) => {
  test.setTimeout(180_000);
  const [a, b, c] = await Promise.all([
    open(browser, M7_MELEE_HUB),
    open(browser, M7_MELEE_HUB),
    open(browser, M7_MELEE_HUB),
  ]);
  try {
    await clickHatch(c);
    await waitPlaying(c);
    // B whole, so A's strikes take a while: the fight is still on when C joins.
    const ids = await stage(a, b, undefined, 1);
    const idC = (await state(c)).playerId as string;

    // C waits in its own page, frame by frame, until B is fighting, and presses F at once: a hatched
    // body can finish B within seconds, so the join must not wait on a round trip from the test.
    await parkBeside(a, ids.idB);
    await parkOpposite(c, ids.idB);
    await settled(c);
    const pressed = c.waitForFunction(
      (who) => {
        const s = window.__bs?.state();
        const busy = s?.remotes.some((r) => r.id === who.b && r.fighting);
        if (!s || !busy || (s.attack.hint !== who.a && s.attack.hint !== who.b)) return false;
        dispatchEvent(new KeyboardEvent('keydown', { key: 'f' }));
        dispatchEvent(new KeyboardEvent('keyup', { key: 'f' }));
        return true;
      },
      { a: ids.idA, b: ids.idB },
      { timeout: 90_000, polling: 'raf' },
    );

    // A engages B with F (again if B drifted off and nothing started).
    await expect(async () => {
      await parkBeside(a, ids.idB);
      await settled(a);
      await a.keyboard.press('f');
      await a.waitForFunction(() => window.__bs?.state().encounter?.over === false, undefined, {
        timeout: 4_000,
      });
    }, 'A engages B')
      .toPass({ timeout: 60_000 })
      .catch(async (error) => {
        throw new Error(`A's fight never started: ${JSON.stringify(await seen(a))}`, {
          cause: error,
        });
      });
    const enc = (await state(a)).encounter?.id;

    // C's F joins it: every client seats C as the third fighter.
    await pressed.catch(async (error) => {
      throw new Error(`C never saw B fighting: ${JSON.stringify(await seen(c))}`, { cause: error });
    });
    await c
      .waitForFunction((id) => window.__bs?.state().encounter?.id === id, enc, { timeout: 10_000 })
      .catch(async (error) => {
        throw new Error(`C never joined: ${JSON.stringify(await seen(c))}`, { cause: error });
      });
    for (const page of [a, b, c]) {
      await page
        .waitForFunction(
          (id) => {
            const e = window.__bs?.state().encounter;
            return e?.id === id && e?.fighters.length === 3;
          },
          enc,
          { timeout: 10_000 },
        )
        .catch(async (error) => {
          throw new Error(`no third fighter: ${JSON.stringify(await seen(page))}`, {
            cause: error,
          });
        });
    }
    const onC = (await state(c)).encounter;
    expect(onC?.fighters[2]?.player).toBe(idC);
    expect(onC?.slot).toBe(2);

    // Three fighters offer a choice: the ring marks the nearest, and Tab picks one.
    expect(onC?.aim).not.toBeNull();
    await c.keyboard.press('Tab');
    await c.waitForFunction(() => window.__bs?.state().encounter?.aim?.chosen === true, undefined, {
      timeout: 5_000,
    });
    await c.waitForFunction(
      () => ((window.__bs as BsHook).render.info().telegraphs.targets ?? 0) > 0,
      undefined,
      { timeout: 5_000, polling: 'raf' },
    );

    // A swims off west and C east: each escapes in turn, and the fight ends.
    for (const [page, dx] of [
      [a, -3000],
      [c, 3000],
    ] as const) {
      await page.evaluate((d) => {
        const bs = window.__bs as BsHook;
        const p = bs.state().player;
        if (p) void bs.debug?.steerTo({ x: p.x + d, y: p.y });
      }, dx);
    }
    for (const page of [a, b, c]) {
      await page
        .waitForFunction(() => window.__bs?.state().encounter?.over === true, undefined, {
          timeout: 40_000,
        })
        .catch(async (error) => {
          throw new Error(`the fight never ended: ${JSON.stringify(await seen(page))}`, {
            cause: error,
          });
        });
    }
    const ends = await Promise.all([a, b, c].map(async (page) => (await state(page)).encounter));
    for (const end of ends) {
      expect(end?.id).toBe(enc);
      expect(end?.fighters).toHaveLength(3);
      expect(end?.endHash).toMatch(/^[0-9a-f]+$/);
      expect(end?.hash).toBe(end?.endHash);
      expect(end?.desyncs).toBe(0);
    }
    expect(new Set(ends.map((e) => e?.endHash)).size).toBe(1);
  } finally {
    await Promise.all([a, b, c].map((page) => page.context().close()));
  }
});

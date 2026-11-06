import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, M7_MELEE_HUB, state, waitPlaying } from './helpers';
import { EQUAL_BIOMASS, open, parkBeside, seen, stage } from './m7-fight';

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

test('C joins A and B’s fight, and all three clients’ hashes equal the referee’s @slow', async ({
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
    // C the size of A and B too, or a cautious B flees a bigger C and the fight ends early.
    await c.evaluate((m) => (window.__bs as BsHook).debug?.setBiomass(m), EQUAL_BIOMASS);
    // A and C are hatched bodies against a whole B: B can kill C in the seconds the test spends on
    // the ring (the E2E main run that died with C at 0 hp). Bracing on each windup keeps both alive.
    await Promise.all(
      [a, c].map((page) => page.evaluate(() => (window.__bs as BsHook).debug?.autoBrace(true))),
    );

    // C's page watches itself: the first frame with an aim ring presses Tab, and the frames after
    // note the chosen mark and the target marks drawn.
    await c.evaluate(() => {
      const bs = window.__bs as BsHook;
      const melee = { ring: false, chosen: false, marks: 0, tabbed: false };
      (window as unknown as { melee: typeof melee }).melee = melee;
      const watch = () => {
        const enc = bs.state().encounter;
        if (enc && !enc.over && enc.fighters.length === 3 && enc.aim) {
          melee.ring = true;
          if (!melee.tabbed) {
            melee.tabbed = true;
            dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
            dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab' }));
          }
          if (enc.aim.chosen) melee.chosen = true;
          if ((bs.render.info().telegraphs.targets ?? 0) > 0) melee.marks = 1;
        }
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    });

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
    // The first press can miss (B drifted off C's reach as the engage travelled): press again while
    // B is still fighting, until the hub seats C.
    await expect(async () => {
      const joined = await c.evaluate((id) => window.__bs?.state().encounter?.id === id, enc);
      if (joined) return;
      await parkOpposite(c, ids.idB);
      await settled(c);
      await c.keyboard.press('f');
      await c.waitForFunction((id) => window.__bs?.state().encounter?.id === id, enc, {
        timeout: 4_000,
      });
    }, 'C joins the fight')
      .toPass({ timeout: 40_000 })
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
          { timeout: 40_000 },
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

    // C stays on the fight while the test looks at its ring: an idle body that drifts out of reach
    // on a slow runner escapes before the ring is read. The chase ends when C swims off below.
    await c.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const chase = () => {
        const r = bs.state().remotes.find((x) => x.id === who);
        if (r) void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
      };
      (window as unknown as { chase: number }).chase = window.setInterval(chase, 250);
    }, ids.idB);

    // Three fighters offer a choice: the ring marks the nearest, and Tab picks one. The observer
    // installed before the join reads all of it frame by frame in the page: a fight is short, and a
    // round trip from the test can arrive after the ring is gone.
    const reached = await c
      .waitForFunction(
        () => {
          const w = window as unknown as {
            melee?: { ring: boolean; chosen: boolean; marks: number };
          };
          return w.melee?.ring && w.melee.chosen && w.melee.marks > 0 ? w.melee : false;
        },
        undefined,
        { timeout: 10_000, polling: 'raf' },
      )
      .then((h) => h.jsonValue())
      .catch(async (error) => {
        const so = await c.evaluate(() => (window as unknown as { melee?: unknown }).melee);
        throw new Error(
          `no aim ring on C: ${JSON.stringify(so)} ${JSON.stringify(await seen(c))}`,
          {
            cause: error,
          },
        );
      });
    expect(reached).toBeTruthy();

    // A swims off west and C east: each escapes in turn, and the fight ends.
    for (const [page, dx] of [
      [a, -3000],
      [c, 3000],
    ] as const) {
      await page.evaluate((d) => {
        const bs = window.__bs as BsHook;
        window.clearInterval((window as unknown as { chase?: number }).chase);
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

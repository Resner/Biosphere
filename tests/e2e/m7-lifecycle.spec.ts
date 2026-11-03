import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { PRESETS } from '../../src/render/presets';
import {
  clickHatch,
  goTo,
  M7_LIFECYCLE_HUB as HUB,
  openRecorded,
  ripe,
  state,
  waitPlaying,
} from './helpers';
import { mate, seen } from './m7-fight';

// The M7 line in one scenario (@slow, release gate) at `?quality=medium`, with three players A, B
// and C on one authority: the spawn shield, a mating (both carry an egg), an engage with the HUD and
// a telegraph, a blocked strike, an eaten egg (told to its carrier), an escape, a three-way join,
// B's kill named on its death screen with no child to fall back on, and carrion that C eats before
// it escapes. Every step checks the medium preset's budgets, and every participant's hash equals
// the referee's at each fight's end.

test.describe.configure({ mode: 'serial' });
test.use({ storageState: { cookies: [], origins: [] } });

const EGG_EATEN = 'Your egg was eaten';
const EGG_CODE = 4;

/** The frame is drawn with the medium chain and stays within the medium budget. */
async function withinBudget(page: Page, step: string): Promise<void> {
  const frame = await page.evaluate(() => (window.__bs as BsHook).render.info());
  const { budget } = PRESETS.medium;
  expect(frame.preset, step).toBe('medium');
  expect(frame.calls, `${step}: draw calls`).toBeLessThanOrEqual(budget.calls);
  expect(frame.triangles, `${step}: triangles`).toBeLessThanOrEqual(budget.triangles);
  expect(frame.targetBytes, `${step}: target bytes`).toBeLessThanOrEqual(budget.targetBytes);
}

async function opened(browser: import('@playwright/test').Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '&quality=medium', HUB);
  // The toasts that show, in order: a short-lived element is gone before a test could read it.
  await page.evaluate(() => {
    const w = window as unknown as { __toasts: string[] };
    w.__toasts = [];
    new MutationObserver(() => {
      for (const el of document.querySelectorAll('[data-testid="toast"]')) {
        const text = el.textContent ?? '';
        if (text && w.__toasts[w.__toasts.length - 1] !== text) w.__toasts.push(text);
      }
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  });
  return page;
}

const toasts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __toasts?: string[] }).__toasts ?? []);

/** Waits for a `state()` condition on `page`, naming what it waited for in the failure. */
async function until(
  page: Page,
  what: string,
  fn: (arg: never) => boolean,
  arg?: unknown,
  ms = 30_000,
): Promise<void> {
  await page
    .waitForFunction(fn as (a: unknown) => boolean, arg, { timeout: ms, polling: 100 })
    .catch(async (error) => {
      throw new Error(
        `${what}: ${JSON.stringify(await seen(page))} ${JSON.stringify((await state(page)).death)}`,
        { cause: error },
      );
    });
}

/** `page` parks beside `id` (on its `side`) until the "F" glyph marks it. */
async function park(page: Page, id: string, side: -1 | 1): Promise<void> {
  await expect(async () => {
    await page.evaluate(
      ([who, s]) => {
        const bs = window.__bs as BsHook;
        const r = bs.state().remotes.find((x) => x.id === who);
        const p = bs.state().player;
        if (r && p) bs.debug?.teleport(r.x + s * (r.radius + p.radius * 1.1), r.y);
      },
      [id, side] as const,
    );
    await page.waitForFunction((who) => window.__bs?.state().attack.hint === who, id, {
      timeout: 2_000,
    });
  }, `parks beside ${id}`).toPass({ timeout: 30_000 });
}

/** Waits until the page's own snapshots have left from where it now is (an engage carries one). */
async function settled(page: Page): Promise<void> {
  const at = (await state(page)).tick;
  await page.waitForFunction((t) => (window.__bs?.state().tick ?? 0) >= t + 15, at, {
    timeout: 8_000,
  });
}

/** `from` swims away from `id` for good, and anything it was chasing stops. */
const swimAway = (page: Page, from: string) =>
  page.evaluate((from) => {
    const bs = window.__bs as BsHook;
    const w = window as unknown as { chase?: number };
    window.clearInterval(w.chase);
    const s = bs.state();
    const me = s.player;
    const them = s.remotes.find((r) => r.id === from);
    if (!me || !them) return;
    const d = Math.hypot(me.x - them.x, me.y - them.y) || 1;
    void bs.debug?.steerTo({
      x: me.x + ((me.x - them.x) / d) * 800,
      y: me.y + ((me.y - them.y) / d) * 800,
    });
  }, from);

/** Full health. */
const setWhole = (page: Page) =>
  page.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));

/** `page` stops chasing and holds where it is. */
const halt = (page: Page) =>
  page.evaluate(() => {
    const bs = window.__bs as BsHook;
    window.clearInterval((window as unknown as { chase?: number }).chase);
    const me = bs.state().player;
    if (me) void bs.debug?.steerTo({ x: me.x, y: me.y });
  });

/** `page` keeps swimming onto `id` (and its eaten egg's place) every 250 ms until `swimAway`. */
const chase = (page: Page, id: string, untilEgg = false) =>
  page.evaluate(
    ([who, stop]) => {
      const bs = window.__bs as BsHook;
      const w = window as unknown as { chase?: number };
      window.clearInterval(w.chase);
      w.chase = window.setInterval(() => {
        const s = bs.state();
        const foe = s.encounter?.fighters.find((f) => f.player === who);
        const r = s.remotes.find((x) => x.id === who);
        // Once the egg is gone, hold: the body is not the target of this fight.
        if (stop && foe?.egg?.eaten) {
          window.clearInterval(w.chase);
          const me = s.player;
          if (me) void bs.debug?.steerTo({ x: me.x, y: me.y });
          return;
        }
        const egg =
          foe?.egg && !foe.egg.eaten && (s.encounter?.aim?.code ?? 0) >= 4 ? foe.egg : null;
        const at = egg ?? foe ?? r;
        if (at) void bs.debug?.steerTo({ x: at.x, y: at.y });
      }, 100);
    },
    [id, untilEgg] as const,
  );

/** Every participant's hash equals the referee's at the fight's end, with no desync. */
async function sameEnd(pages: Page[], id: string, fighters: number): Promise<void> {
  for (const page of pages) {
    await until(
      page,
      'the fight ends',
      () => window.__bs?.state().encounter?.over === true,
      undefined,
      60_000,
    );
  }
  const ends = await Promise.all(pages.map(async (page) => (await state(page)).encounter));
  for (const end of ends) {
    expect(end?.id).toBe(id);
    expect(end?.fighters).toHaveLength(fighters);
    expect(end?.endHash).toMatch(/^[0-9a-f]+$/);
    expect(end?.hash).toBe(end?.endHash);
    expect(end?.desyncs).toBe(0);
  }
  expect(new Set(ends.map((e) => e?.endHash)).size).toBe(1);
}

/**
 * `page` presses F beside `id` (parking again when the engage did not start) until a fight is on
 * that lasts at least 45 frames: a target that drifted off before the engage landed escapes at
 * once, and is engaged again.
 */
async function engage(
  page: Page,
  id: string,
  side: -1 | 1,
  previous?: string,
  /** Presses Tab in the frames of the fight's start until the ring marks `id`'s egg. */
  egg = false,
  /** Returns as the fight starts, without waiting to see that it holds. */
  quick = false,
  /** The target's page: it is brought to the engager before each try, so that it is never far. */
  bring?: Page,
): Promise<string> {
  let last = previous;
  for (let attempt = 0; attempt < 5; attempt++) {
    await expect(async () => {
      if (bring) {
        const at = await page.evaluate(() => {
          const p = (window.__bs as BsHook).state().player;
          return p && { x: p.x, y: p.y };
        });
        if (at)
          await bring.evaluate(
            (to) => (window.__bs as BsHook).debug?.teleport(to.x + 80, to.y),
            at,
          );
        await page.waitForFunction(
          (who) => !!window.__bs?.state().remotes.some((r) => r.id === who),
          id,
          {
            timeout: 10_000,
          },
        );
      }
      await park(page, id, side);
      await settled(page);
      if (egg) {
        await page.evaluate(
          ([who, old, code]) => {
            const w = window as unknown as { __tab?: number };
            w.__tab = (w.__tab ?? 0) + 1;
            const gen = w.__tab;
            const tab = () => {
              if (w.__tab !== gen) return;
              const e = window.__bs?.state().encounter;
              if (e && !e.over && e.id !== old) {
                const slot = e.fighters.findIndex((f) => f.player === who);
                if (e.aim?.code === code + slot || e.over) return;
                if (slot >= 0) {
                  dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }));
                  dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab' }));
                }
              }
              requestAnimationFrame(tab);
            };
            requestAnimationFrame(tab);
          },
          [id, last ?? '', EGG_CODE] as const,
        );
      }
      await page.keyboard.press('f');
      await page.waitForFunction(
        (old) => {
          const e = window.__bs?.state().encounter;
          return e?.over === false && e.id !== old;
        },
        last,
        { timeout: 4_000 },
      );
    }, 'engages')
      .toPass({ timeout: 60_000 })
      .catch(async (error) => {
        throw new Error(
          `no engage (previous ${last}): hidden ${await page.evaluate(() => document.hidden)} ${JSON.stringify(await seen(page))} toasts ${JSON.stringify(await toasts(page))}`,
          { cause: error },
        );
      });
    const fight = (await state(page)).encounter;
    last = fight?.id;
    if (quick) return last as string;
    // Closing in at once: a target left alone drifts out of reach, and escapes.
    if (egg) await chase(page, id, true);
    await page.waitForFunction(
      () => {
        const e = window.__bs?.state().encounter;
        return !!e && (e.over || e.frame >= 45);
      },
      undefined,
      { timeout: 20_000 },
    );
    if (!(await state(page)).encounter?.over) return last as string;
  }
  throw new Error(`no fight held: ${JSON.stringify(await seen(page))}`);
}

test('hatch, mate, fight, an eaten egg, an escape, a three-way kill and carrion @slow', async ({
  browser,
}) => {
  test.setTimeout(900_000);
  const [a, b, c] = await Promise.all([opened(browser), opened(browser), opened(browser)]);
  try {
    // 1. Everyone hatches; a genesis is protected, so A sees B's shimmer.
    await Promise.all(
      [a, b, c].map(async (page) => {
        await clickHatch(page);
        await waitPlaying(page);
      }),
    );
    const idA = (await state(a)).playerId as string;
    const idB = (await state(b)).playerId as string;
    const idC = (await state(c)).playerId as string;
    await until(
      a,
      'B is drawn protected',
      (who) => !!window.__bs?.state().remotes.some((r) => r.id === who && r.protected),
      idB,
      20_000,
    );
    await goTo(a, idB);
    await expect(a.locator('[data-testid="shield-shimmer"]:not([hidden])').first()).toBeAttached({
      timeout: 10_000,
    });
    await withinBudget(a, 'the shield shows');

    // 2. A and B mature and mate: both carry an egg. C waits out of the way.
    await Promise.all([ripe(a), ripe(b)]);
    await mate(a, b);
    for (const page of [a, b]) expect((await state(page)).life.pending).toBe(true);
    await withinBudget(a, 'after the mating');

    // B reloads and resumes with its egg: a resume carries no shield, so the shimmer goes.
    await b.reload();
    await b.waitForFunction(() => window.__bs?.state().playerId);
    await clickHatch(b);
    await waitPlaying(b);
    await b.evaluate(() => {
      const w = window as unknown as { __toasts: string[] };
      w.__toasts = [];
      new MutationObserver(() => {
        for (const el of document.querySelectorAll('[data-testid="toast"]')) {
          const text = el.textContent ?? '';
          if (text && w.__toasts[w.__toasts.length - 1] !== text) w.__toasts.push(text);
        }
      }).observe(document.body, { childList: true, subtree: true, characterData: true });
      (window.__bs as BsHook).debug?.setZone('twilight');
      (window.__bs as BsHook).debug?.autoBrace(true);
    });
    expect((await state(b)).life.pending, 'B kept its egg').toBe(true);
    await until(
      a,
      'B is drawn unprotected',
      (who) =>
        !!window.__bs?.state().remotes.some((r) => r.id === who && !r.protected && r.alpha > 0.5),
      idB,
      20_000,
    );
    // One shimmer per protected remote: C, hatched a moment ago, may still have its own.
    await expect
      .poll(async () => {
        const protectedNow = (await state(a)).remotes.filter((r) => r.protected).length;
        return (
          (await a.locator('[data-testid="shield-shimmer"]:not([hidden])').count()) - protectedNow
        );
      })
      .toBe(0);

    // Equal bodies, fed but never to the brim (a full belly turns into growth, and a body over 1.5
    // times its size makes a smaller autopilot flee): the same size and a belly that lasts.
    await Promise.all(
      [a, b, c].map((page) =>
        page.evaluate(() => {
          const bs = window.__bs as BsHook;
          bs.debug?.setBiomass(100);
          const feed = () => bs.debug?.setEnergy(60);
          feed();
          window.setInterval(feed, 1000);
        }),
      ),
    );

    // 3. A engages B and Tab marks B's egg in the fight's first frames (the default target is B's
    // body); the HUD shows on both, B braces for the strikes it sees coming and a block counts, and
    // A eats the egg. A fight can end before that (B drifted off, or the engage landed late): both
    // are made whole and A engages again, until the egg is eaten.
    let first = '';
    let hudSeen = false;
    for (let attempt = 0; ; attempt++) {
      if (attempt >= 4)
        throw new Error(`B’s egg was never eaten: ${JSON.stringify(await seen(a))}`);
      // Fed and whole, so that nothing but the fight can take their health; B holds still.
      await Promise.all([setWhole(a), setWhole(b)]);
      await halt(b);
      first = await engage(a, idB, -1, first || undefined, true, false, b);
      await until(
        b,
        'B is in the same fight',
        (id) => window.__bs?.state().encounter?.id === id,
        first,
        10_000,
      );
      if (!hudSeen) {
        for (const page of [a, b]) {
          // Checked in the page's frame: a short fight may be over before a second round trip.
          await until(page, 'the combat HUD shows', () => {
            const el = document.querySelector<HTMLElement>('[data-testid="combat-hud"]');
            return (
              window.__bs?.state().encounter?.hud.shown === true &&
              !!el &&
              !el.hidden &&
              getComputedStyle(el).display !== 'none'
            );
          });
          await withinBudget(page, 'in the fight');
        }
        hudSeen = true;
      }
      const ended = await a
        .waitForFunction(
          (who) => {
            const e = window.__bs?.state().encounter;
            const egg = e?.fighters.find((f) => f.player === who)?.egg;
            return egg?.eaten === true || e?.over === true;
          },
          idB,
          { timeout: 60_000, polling: 100 },
        )
        .then(() => true)
        .catch(() => false);
      if (!ended)
        throw new Error(
          `the fight went nowhere: hidden a ${await a.evaluate(() => document.hidden)} b ${await b.evaluate(() => document.hidden)} ${JSON.stringify((await state(a)).encounter)}`,
        );
      const eaten = await a.evaluate(
        (who) => window.__bs?.state().encounter?.fighters.find((f) => f.player === who)?.egg?.eaten,
        idB,
      );
      if (eaten) break;
      await a.waitForFunction(() => window.__bs?.state().encounter?.over === true);
    }
    await halt(a);
    await until(
      b,
      'B heard a windup and blocked a strike',
      () => {
        const s = window.__bs?.state();
        return (s?.audio.cues.windup ?? 0) > 0 && (s?.encounter?.hud.blocks ?? 0) > 0;
      },
      undefined,
      15_000,
    );
    expect(
      (await b.evaluate(() => (window.__bs as BsHook).render.info().telegraphs)).sparked,
    ).toBeGreaterThan(0);
    await withinBudget(b, 'a block sparks');

    await until(
      b,
      'B is told its egg was eaten',
      () =>
        (window as unknown as { __toasts?: string[] }).__toasts?.includes('Your egg was eaten') ??
        false,
    );
    expect(await toasts(b)).toContain(EGG_EATEN);
    await until(b, 'B no longer carries an egg', () => window.__bs?.state().life.pending === false);
    expect((await state(a)).life.pending, 'A keeps its own egg').toBe(true);

    // 5. B escapes: it steers away while A stays; the fight ends, B escaped and A stood.
    await halt(a);
    await swimAway(b, idA);
    await sameEnd([a, b], first, 2);
    const outcomes = (await state(a)).encounter?.fighters.map((f) => [f.player, f.outcome]);
    expect(outcomes).toContainEqual([idB, 'escaped']);
    expect(outcomes).toContainEqual([idA, 'stood']);
    await withinBudget(a, 'after the escape');

    // 6. A engages B again, and C, parked on B's far side, presses F the moment B is fighting: C
    // joins as the third fighter. A holds still until C is seated. B is whole: at one hit point a
    // strike ends the fight within 5 frames, before any join could land.
    await b.evaluate(() => {
      const bs = window.__bs as BsHook;
      bs.debug?.setZone('twilight');
      bs.debug?.setHealth(Number.MAX_SAFE_INTEGER);
    });
    await a.evaluate(() => (window.__bs as BsHook).debug?.setHealth(Number.MAX_SAFE_INTEGER));
    await halt(b);
    await until(
      a,
      'B is drawn unprotected and calm',
      (who) =>
        !!window.__bs?.state().remotes.some((r) => r.id === who && !r.protected && !r.fighting),
      idB,
      30_000,
    );
    await park(c, idB, 1);
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
      { a: idA, b: idB },
      { timeout: 90_000, polling: 'raf' },
    );
    const second = await engage(a, idB, -1, first, false, true, b);
    await halt(a);
    await pressed.catch(async (error) => {
      throw new Error(`C never saw B fighting: ${JSON.stringify(await seen(c))}`, { cause: error });
    });
    // The first press can miss (B drifted off C's reach as the engage travelled): press again while
    // B is still fighting, until the hub seats C.
    const joined = await (async () => {
      await expect(async () => {
        if ((await state(c)).encounter?.id === second) return;
        await park(c, idB, 1);
        await settled(c);
        await c.keyboard.press('f');
        await c.waitForFunction((id) => window.__bs?.state().encounter?.id === id, second, {
          timeout: 4_000,
        });
      }, 'C joins').toPass({ timeout: 40_000 });
      return (await state(c)).encounter;
    })();
    expect(joined?.fighters.map((f) => f.player)).toContain(idC);
    for (const page of [a, b, c]) {
      await until(
        page,
        'three fighters seated',
        (id) => {
          const e = window.__bs?.state().encounter;
          return e?.id === id && e.fighters.length === 3;
        },
        second,
        15_000,
      );
    }
    await withinBudget(c, 'three fighters');

    // 7. B dies to whoever lands first; its death screen names the killer, and it has no child.
    await Promise.all([chase(a, idB), chase(c, idB)]);
    await until(b, 'B is dead', () => window.__bs?.state().screen === 'dead', undefined, 90_000);
    expect((await state(b)).death?.cause).toBe('killed');
    await expect(b.getByTestId('death-cause')).toHaveText(/^Killed by \S/);
    expect((await state(b)).life.pending).toBe(false);
    expect((await state(b)).life.fallback?.pending ?? false).toBe(false);
    await withinBudget(b, 'B’s death screen');

    // 8. The carrion drops; C goes to a piece and eats it, then escapes. A swims off first, so the
    // fight winds down while C eats.
    await until(
      c,
      'carrion on the water',
      () => (window.__bs?.state().carrion.length ?? 0) >= 1,
      undefined,
      20_000,
    );
    const pieces = (await state(c)).carrion;
    const piece = pieces[0];
    if (!piece) throw new Error('no piece');
    await halt(a);
    await c.evaluate((at) => {
      const bs = window.__bs as BsHook;
      window.clearInterval((window as unknown as { chase?: number }).chase);
      bs.debug?.setEnergy(20);
      const w = window as unknown as { __ate?: { gain: number | null } };
      const ate = { gain: null as number | null };
      w.__ate = ate;
      let last = bs.state();
      const watch = () => {
        const now = bs.state();
        const was = last.carrion.some((p) => p.id === at.id);
        const is = now.carrion.some((p) => p.id === at.id);
        if (was && !is && ate.gain === null) {
          ate.gain = (now.player?.energy ?? 0) - (last.player?.energy ?? 0);
        }
        last = now;
        requestAnimationFrame(watch);
      };
      requestAnimationFrame(watch);
    }, piece);
    await expect(async () => {
      await c.evaluate((at) => (window.__bs as BsHook).debug?.teleport(at.x, at.y), piece);
      await c.waitForFunction(
        (id) => !window.__bs?.state().carrion.some((p) => p.id === id),
        piece.id,
        { timeout: 2_000 },
      );
    }, 'C reaches the piece and eats it').toPass({ timeout: 40_000 });
    await until(
      c,
      'C’s gain is read',
      () => (window as unknown as { __ate?: { gain: number | null } }).__ate?.gain != null,
      undefined,
      5_000,
    );
    expect(
      await c.evaluate(() => (window as unknown as { __ate: { gain: number } }).__ate.gain),
    ).toBeGreaterThan(0);
    await withinBudget(c, 'C ate a piece');

    // C escapes (steers away from A) and the fight ends with the same hash everywhere.
    await swimAway(c, idA);
    await sameEnd([a, b, c], second, 3);
    const end = (await state(c)).encounter?.fighters;
    const own = end?.find((f) => f.player === idC);
    expect(['escaped', 'stood'], 'C survived').toContain(own?.outcome);
    expect(end?.find((f) => f.player === idB)?.outcome).toBe('killed');
    await withinBudget(c, 'after the fight');
  } finally {
    await Promise.all([a, b, c].map((page) => page.context().close()));
  }
});

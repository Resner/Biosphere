import { type Browser, expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { clickHatch, hudCover, M7_HUD_HUB, openRecorded, state, waitPlaying } from './helpers';
import { decodePng, luminance } from './look-metrics';

// The combat HUD, the telegraphs and the fight's cues (M7 T12), in a duel with no egg. B (resumed,
// so not spawn-protected) turns on `debug.autoBrace`; A engages it with F and swims onto it, then
// away until it escapes. The HUD shows only in the fight and keeps within the 6% budget; on B's
// screen A's front is brighter during a windup than just before one; B hears the windup's tick and
// blocks a strike.

test.describe.configure({ mode: 'serial' });

/** The combat HUD's buttons, which count in the HUD budget. */
const COMBAT_HUD = ['.combat-hud .combat-button'];

async function open(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await openRecorded(page, '', M7_HUD_HUB);
  return page;
}

/** What the test reads of a page while it waits, for a failure's message. */
const seen = (page: Page) =>
  page.evaluate(() => {
    const s = (window.__bs as BsHook).state();
    return {
      screen: s.screen,
      toast: document.querySelector('[data-testid="toast"]')?.textContent ?? null,
      player: s.player && { x: s.player.x, y: s.player.y, health: s.player.health },
      attack: s.attack,
      cues: s.audio.cues,
      encounter: s.encounter && {
        frame: s.encounter.frame,
        over: s.encounter.over,
        hud: s.encounter.hud,
        fighters: s.encounter.fighters.map((f) => ({
          x: Math.round(f.x),
          y: Math.round(f.y),
          health: f.health,
          windup: f.windup,
          target: f.target,
          outcome: f.outcome,
        })),
      },
    };
  });

const shown = (page: Page) => page.evaluate(() => window.__bs?.state().encounter?.hud.shown);

/**
 * Freezes `page`'s world (`timeScale(0)`) in the frame its fight first matches `when`: `calm` (no
 * windup running, the fighters close) or `windup` (`who`'s windup aimed at this player, 6 ticks or
 * fewer left). Returns the CSS-pixel point at `who`'s front and the body's radius in pixels, as
 * drawn while frozen.
 */
async function freezeAt(page: Page, when: 'calm' | 'windup', who: string) {
  await page.waitForFunction(
    ({ when, who }) => {
      const bs = window.__bs as BsHook;
      const enc = bs.state().encounter;
      if (!enc || enc.over) return false;
      const them = enc.fighters.find((f) => f.player === who);
      const me = enc.fighters[enc.slot];
      if (!them || !me) return false;
      // The last frame drew no glow (calm), or drew this windup's.
      const glows = bs.render.info().telegraphs.glows;
      const ok =
        when === 'calm'
          ? glows === 0 &&
            enc.fighters.every((f) => f.windup === null) &&
            Math.hypot(them.x - me.x, them.y - me.y) <= 3 * (them.radius + me.radius)
          : glows > 0 && them.windup !== null && them.windup <= 6 && them.target === enc.slot;
      if (ok) bs.debug?.timeScale(0);
      return ok;
    },
    { when, who },
    { polling: 'raf', timeout: 30_000 },
  );
  // Two frames so the frozen state is the one drawn (and a hit's camera kick has settled).
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0)))),
  );
  await page.waitForTimeout(400);
  return page.evaluate((who) => {
    const bs = window.__bs as BsHook;
    const f = bs.state().encounter?.fighters.find((x) => x.player === who);
    const fx = bs.render.fx();
    const px = bs.render.info().pxPerWu;
    if (!f) throw new Error('no fighter');
    const front = 0.85 * f.radius;
    const wx = f.x + Math.cos(f.heading) * front;
    const wy = f.y + Math.sin(f.heading) * front;
    return {
      x: innerWidth / 2 + (wx - fx.camX) * px,
      y: innerHeight / 2 - (wy - fx.camY) * px,
      r: f.radius * px,
    };
  }, who);
}

/** The mean luminance of a disc of radius `r` CSS px round (x, y) in a fresh screenshot. */
async function brightness(page: Page, at: { x: number; y: number; r: number }): Promise<number> {
  const r = Math.max(4, Math.round(at.r * 0.45));
  const clip = { x: Math.round(at.x - r), y: Math.round(at.y - r), width: 2 * r, height: 2 * r };
  const image = await decodePng(page, await page.screenshot({ clip }));
  let sum = 0;
  let n = 0;
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      if (Math.hypot(x + 0.5 - r, y + 0.5 - r) > r) continue;
      sum += luminance(image.rgba, (y * image.width + x) * 4);
      n++;
    }
  }
  return sum / Math.max(1, n);
}

test('the combat HUD shows only in the fight, a windup glows and ticks, and a brace blocks', async ({
  browser,
}) => {
  test.setTimeout(120_000);
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

    // No fight, no combat HUD.
    for (const page of [a, b]) {
      await expect(page.getByTestId('combat-hud')).toBeHidden();
      expect(await shown(page)).toBeFalsy();
    }

    // B somewhere calm, bracing for every strike it sees coming. At full health its autopilot (which
    // flies its frames while its world is frozen for a shot) stands and fights rather than flees.
    await b.evaluate(() => {
      const debug = (window.__bs as BsHook).debug;
      debug?.setZone('twilight');
      debug?.autoBrace(true);
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
    // A parks beside B until the "F" glyph marks B, and presses F. A loaded runner can send B's
    // signed snapshot late, and the hub refuses a stale one ("Can't fight now"): A presses again.
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
      await a.keyboard.press('f');
      await a.waitForFunction(() => window.__bs?.state().encounter?.over === false, undefined, {
        timeout: 4_000,
      });
    }, 'A parks beside B and engages it with F').toPass({ timeout: 45_000 });

    // Both see the fight, and its HUD.
    for (const page of [a, b]) {
      await page
        .waitForFunction(() => window.__bs?.state().encounter?.hud.shown === true, undefined, {
          timeout: 10_000,
        })
        .catch(async (error) => {
          throw new Error(`no combat HUD: ${JSON.stringify(await seen(page))}`, { cause: error });
        });
      await expect(page.getByTestId('combat-hud')).toBeVisible();
    }
    const hud = (await state(b)).encounter?.hud;
    expect(hud?.stance).toBe('balanced');
    expect(hud?.opponents.map((o) => o.player)).toEqual([idA]);
    await expect(b.getByTestId('stance-balanced')).toHaveAttribute('aria-pressed', 'true');
    // Within the HUD budget at 960 × 540, the combat buttons included: the size and life bars step
    // aside for them while the fight lasts.
    const cover = await hudCover(b, COMBAT_HUD);
    expect(cover.parts).toBe(9);
    await expect(b.getByTestId('hud-bar-size')).toBeHidden();
    expect(cover.share, `HUD covers ${(cover.share * 100).toFixed(2)}%`).toBeLessThanOrEqual(0.06);

    // A keeps swimming onto B (debug steering works in a fight) until the test calls it off.
    await a.evaluate((who) => {
      const bs = window.__bs as BsHook;
      const chase = () => {
        const r = bs.state().remotes.find((x) => x.id === who);
        if (r) void bs.debug?.steerTo({ id: who, x: r.x, y: r.y });
      };
      (window as unknown as { chase: number }).chase = window.setInterval(chase, 250);
    }, idB);

    // On B's screen, A's front just before a windup, then during one (each frame frozen to shoot it).
    const calm = await freezeAt(b, 'calm', idA).catch(async (error) => {
      throw new Error(`no calm moment: ${JSON.stringify(await seen(b))}`, { cause: error });
    });
    const before = await brightness(b, calm);
    await b.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    const winding = await freezeAt(b, 'windup', idA).catch(async (error) => {
      throw new Error(`no windup on B: ${JSON.stringify(await seen(b))}`, { cause: error });
    });
    const during = await brightness(b, winding);
    await b.screenshot({ path: 'test-results/m7-hud-windup.png' });
    const glows = (await b.evaluate(() => (window.__bs as BsHook).render.info().telegraphs)).glows;
    await b.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    expect(glows).toBeGreaterThan(0);
    expect(
      during,
      `A's front: ${before.toFixed(1)} before, ${during.toFixed(1)} during`,
    ).toBeGreaterThan(before + 6);

    // B heard the windup's tick, and blocked a strike with its brace.
    await b
      .waitForFunction(
        () => {
          const s = window.__bs?.state();
          return (
            (s?.audio.cues.windup ?? 0) > 0 &&
            (s?.audio.cues.block ?? 0) > 0 &&
            (s?.encounter?.hud.blocks ?? 0) > 0
          );
        },
        undefined,
        { timeout: 30_000 },
      )
      .catch(async (error) => {
        throw new Error(`no windup tick or block on B: ${JSON.stringify(await seen(b))}`, {
          cause: error,
        });
      });
    expect(
      (await b.evaluate(() => (window.__bs as BsHook).render.info().telegraphs)).sparked,
    ).toBeGreaterThan(0);

    // A and B swim apart until one escapes (unless the fight has ended already), and the HUD goes.
    const apart = (page: Page, from: string) =>
      page.evaluate((from) => {
        const bs = window.__bs as BsHook;
        window.clearInterval((window as unknown as { chase?: number }).chase);
        const s = bs.state();
        const me = s.player;
        const them = s.remotes.find((r) => r.id === from);
        if (!me || !them) return;
        const d = Math.hypot(me.x - them.x, me.y - them.y) || 1;
        const away = {
          x: me.x + ((me.x - them.x) / d) * 500,
          y: me.y + ((me.y - them.y) / d) * 500,
        };
        void bs.debug?.steerTo(away);
      }, from);
    await Promise.all([apart(a, idB), apart(b, idA)]);
    for (const page of [a, b]) {
      await page
        .waitForFunction(() => window.__bs?.state().encounter?.over === true, undefined, {
          timeout: 30_000,
        })
        .catch(async (error) => {
          throw new Error(`the fight never ended: ${JSON.stringify(await seen(page))}`, {
            cause: error,
          });
        });
      await expect(page.getByTestId('combat-hud')).toBeHidden();
      expect(await shown(page)).toBe(false);
      await expect(page.getByTestId('hud-bar-size')).toBeVisible();
    }
  } finally {
    await Promise.all([a.context().close(), b.context().close()]);
  }
});

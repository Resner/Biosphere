import type { Page } from '@playwright/test';
import type { BsDebug, BsHook } from '../../src/game/debug';
import { budgetCast, CROWD, frames } from '../../tools/budget-scene.mjs';

// A crowd on the play screen for the M6c T8 specs (Firefox, the LOD flash): the game at 960×540 on
// a preset, the world frozen in the shallows without caustics, god rays or depth of field, and the 24
// budget bodies on a 6 × 4 grid round the player at a chosen size on screen. The cast and the frame
// counter are the budget scenes' (`tools/budget-scene.mjs`).

export const CROWD_VIEWPORT = { width: 960, height: 540 };
/** The player's biomass: the low end of size tier 1 (1,024 to 16,383; `sizeTier`). */
export const PLAYER_BIOMASS = 1_100;
/** Software GL builds 25 bodies and draws the medium preset slowly. */
const TIMEOUT = 120_000;

/** Opens the game on `preset` with the budget cast's player, hatches it, freezes the world and sets its biomass. */
export async function openCrowdGame(
  page: Page,
  preset: 'medium' | 'high',
  biomass = PLAYER_BIOMASS,
): Promise<void> {
  const { player } = budgetCast();
  await page.goto(`./?debug=1&seed=flash&quality=${preset}&light=0&dof=0&genome=${player}`);
  await page.waitForFunction(() => window.__bs?.ready === true, null, { timeout: TIMEOUT });
  await page.getByRole('button', { name: 'Hatch', exact: true }).click();
  await page.waitForFunction(() => window.__bs?.state().screen === 'playing', null, {
    timeout: TIMEOUT,
  });
  // The hatch draws the egg and its rings until they are gone.
  await page.waitForFunction(
    () => {
      const { render } = window.__bs as BsHook;
      const info = render.info();
      return info.playerBody && info.eggs === 0 && render.fx().rings === 0;
    },
    null,
    { timeout: TIMEOUT },
  );
  await page.evaluate((biomass) => {
    const debug = (window.__bs as BsHook).debug as BsDebug;
    debug.timeScale(0);
    debug.setBiomass(biomass);
    // Snaps the camera to the player's size too.
    debug.setZone('shallows');
  }, biomass);
}

/**
 * Places the 24 bodies on a grid over the view, each `px[i % px.length]` CSS pixels of core radius
 * on screen at the zoom now, and waits until all are drawn with their bodies.
 */
export async function stageCrowd(page: Page, px: readonly number[]): Promise<void> {
  const { crowd } = budgetCast();
  await page.evaluate(
    ({ crowd, px, viewport }) => {
      const { render, state } = window.__bs as BsHook;
      const debug = (window.__bs as BsHook).debug as BsDebug;
      const { pxPerWu } = render.info();
      const at = state().player as { x: number; y: number };
      debug.setRemotes(
        crowd.map((genome, i) => {
          const r = (px[i % px.length] as number) / pxPerWu;
          return {
            id: `crowd${i}`,
            name: `C${i}`,
            genome,
            // A remote's core radius is the square root of its biomass.
            biomass: Math.round(r * r),
            x: at.x + (((i % 6) - 2.5) * 0.16 * viewport.width) / pxPerWu,
            y: at.y + ((Math.floor(i / 6) - 1.5) * 0.23 * viewport.height) / pxPerWu,
          };
        }),
      );
    },
    { crowd, px, viewport: CROWD_VIEWPORT },
  );
  await page.waitForFunction(
    (n) => {
      const { state, render } = window.__bs as BsHook;
      return (
        render.info().remoteBodies === n && state().remotes.every((remote) => remote.alpha === 1)
      );
    },
    CROWD,
    { timeout: TIMEOUT },
  );
  await frames(page);
}

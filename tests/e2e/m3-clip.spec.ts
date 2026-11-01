import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import { cellRect } from '../../src/lab/grid';
import { worstBody } from '../worst-body';
import { hatch, openGame, patchLuma } from './helpers';
import { openLab, QUERY, range, stage, WATER } from './lab-helpers';

// The camera never cuts into a body (M3 T19): a body is scaled by its radius in every axis, so a
// camera whose depth range is fixed clips the tall middle of a big body and leaves a hole.

const waterLuma = (0.2126 * WATER[0] + 0.7152 * WATER[1] + 0.0722 * WATER[2]) / 255;
const LIT = waterLuma + 0.12;
// A dark body (deep purple, olive) is still a body: a hole shows the bare water, a hair above 0.
const NOT_WATER = waterLuma + 0.04;

/**
 * The worst body's centre is lit glass at every size. The starter is a clear cell (M6b T3, ADR 0034):
 * its centre shows the water through the glass by design, so a hole is told apart by comparison
 * instead: at every size its centre stays within `KEEP` of the small body's, which the camera never
 * clips, and above the bare water. The worst body is the costliest ring (a bell): round and deep,
 * with its organs in the middle, where a fixed depth range would cut first. Since M6c T3 the
 * costliest body of all is a slim worm whose clear head shows the water through it, as the starter's
 * centre does.
 */
const bodies = { starter: 'starter', worst: genomeToBase64url(worstBody().ring) };
const KEEP = 0.02;

/**
 * Waits until the camera's zoom has held still for 5 frames. A fixed pause is not enough on a slow
 * software-rendered runner, where the zoom is still easing when the frame is read.
 */
const camSettled = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        let last = Number.NaN;
        let still = 0;
        const tick = () => {
          const h = (window.__bs as BsHook).render.fx().halfHeight;
          still = Math.abs(h - last) <= h * 1e-4 ? still + 1 : 0;
          last = h;
          if (still >= 5) resolve();
          else requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      }),
  );

for (const [name, genome] of Object.entries(bodies)) {
  test(`the centre of the player's ${name} body stays lit at any size`, async ({ page }) => {
    // `light=0`: no caustics or god rays, which the shaders' clock re-bases to at the camera's pace
    // (a slow runner caught them mid-way and moved the centre luma by more than KEEP).
    await openGame(page, `?debug=1&seed=clip&light=0&genome=${genome}`);
    await hatch(page);
    const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
    let small: number | null = null;
    // The same spot at every size: the water behind the body varies with where it drifted to, which
    // moved the centre pixel by more than KEEP between runs.
    const spot = await page.evaluate(() => {
      const { x = 0, y = 0 } = (window.__bs as BsHook).state().player ?? {};
      return { x, y };
    });
    for (const biomass of [100, 1600, 100_000]) {
      await page.evaluate((p) => (window.__bs as BsHook).debug?.teleport(p.x, p.y), spot);
      await page.evaluate((b) => (window.__bs as BsHook).debug?.setBiomass(b), biomass);
      await page.waitForFunction(
        (b) => ((window.__bs as BsHook).state().player?.biomass ?? 0) >= b,
        biomass,
      );
      await camSettled(page);
      // Freeze the world at one shader clock, so the gait and the glow are in the same phase at
      // every size and the frames compare (the camera has settled by now). The marine snow's flow is
      // zeroed too: a speck drifting over the centre pixel in one frame and not in another moved
      // the luma by more than KEEP on a slow runner.
      await page.evaluate(() => {
        const { debug } = window.__bs as BsHook;
        debug?.timeScale(0);
        debug?.resetWater();
        debug?.setClock(100);
      });
      await camSettled(page);
      const [luma = 0] = await patchLuma(page, await page.screenshot(), [
        { x: width / 2, y: height / 2 },
      ]);
      small ??= luma;
      if (name === 'worst') expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(LIT);
      expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(NOT_WATER);
      expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(small - KEEP);
      await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(1));
    }
  });
}

test('every Lab cell is lit at its centre on a large stage', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await openLab(page, QUERY);
  const box = await stage(page).boundingBox();
  if (!box) throw new Error('no stage');
  const centres = range(24).map((i) => {
    const r = cellRect(i, box.width, box.height);
    return { x: box.x + r.x + r.w / 2, y: box.y + r.y + r.h / 2 };
  });
  const lumas = await patchLuma(page, await page.screenshot(), centres);
  for (const [i, luma] of lumas.entries()) {
    expect(luma, `creature ${i}`).toBeGreaterThanOrEqual(NOT_WATER);
  }
});

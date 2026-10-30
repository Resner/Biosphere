import { expect, test } from '@playwright/test';
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
 * clips, and above the bare water.
 */
const bodies = { starter: 'starter', worst: genomeToBase64url(worstBody().genome) };
const KEEP = 0.02;

for (const [name, genome] of Object.entries(bodies)) {
  test(`the centre of the player's ${name} body stays lit at any size`, async ({ page }) => {
    await openGame(page, `?debug=1&seed=clip&genome=${genome}`);
    await hatch(page);
    const { width, height } = page.viewportSize() ?? { width: 960, height: 540 };
    let small: number | null = null;
    for (const biomass of [100, 1600, 100_000]) {
      await page.evaluate((b) => (window.__bs as BsHook).debug?.setBiomass(b), biomass);
      await page.waitForFunction(
        (b) => ((window.__bs as BsHook).state().player?.biomass ?? 0) >= b,
        biomass,
      );
      await page.waitForTimeout(600);
      const [luma = 0] = await patchLuma(page, await page.screenshot(), [
        { x: width / 2, y: height / 2 },
      ]);
      small ??= luma;
      if (name === 'worst') expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(LIT);
      expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(NOT_WATER);
      expect(luma, `biomass ${biomass}`).toBeGreaterThanOrEqual(small - KEEP);
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

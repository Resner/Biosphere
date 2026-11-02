import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { decodeGenome, encodeGenome, genomeToBase64url } from '../../src/genome/codec';
import { HAPLOTYPE_BYTES, LOCI } from '../../src/genome/karyotype';
import { starterGenome } from '../../src/genome/starter';
import { hatch, openGame, state } from './helpers';

// Damage lands as hits, in intervals (M6c T9): in the shallows with no UV tolerance the sim deals
// UV every tick, and the shake turns it into one hit every 15 ticks, each kicking the camera 2–3.5 px.
// Counted per tick of sim time, so a slow runner plays the same hits per sim second (ADR 0042).

/** The starter cell with no UV tolerance. */
function noUvTolerance(): string {
  const raw = encodeGenome(starterGenome());
  const locus = LOCI.find((l) => 'id' in l && l.id === 'uvTolerance') as { offset: number };
  for (let hap = 0; hap < 2; hap++) raw[hap * HAPLOTYPE_BYTES + locus.offset] = 0;
  return genomeToBase64url(decodeGenome(raw));
}

const fx = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.fx());

test('UV in the shallows lands as hits, about two a second of sim time, each a 2 px kick or more', async ({
  page,
}) => {
  await openGame(page, `?debug=1&seed=m6c-hits&genome=${noUvTolerance()}`);
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.timeScale(0));
  expect((await state(page)).player?.stats.uvTolerance).toBe(0);
  expect((await fx(page)).shake).toEqual({ body: 0, camera: 0, kind: null, hits: 0 });

  await page.evaluate(() => (window.__bs as BsHook).debug?.setZone('shallows'));
  await expect.poll(async () => (await state(page)).minimap.hazard).toBe('uv');
  const start = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.timeScale(1);
    return { tick: bs.state().tick, hits: bs.render.fx().shake.hits };
  });

  // The camera's kick, read on the frame that shows it.
  await page
    .waitForFunction(() => (window.__bs as BsHook).render.fx().shake.camera >= 2, null, {
      polling: 'raf',
      timeout: 15_000,
    })
    .catch(() => {
      throw new Error('waited for a hit to kick the camera 2 px or more');
    });

  // Two seconds of sim time, then the hits over the ticks actually played, read in one frame.
  await page
    .waitForFunction((t) => (window.__bs as BsHook).state().tick >= t + 60, start.tick, {
      timeout: 30_000,
    })
    .catch(() => {
      throw new Error('waited for 60 ticks of UV');
    });
  const end = await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    bs.debug?.timeScale(0);
    return { tick: bs.state().tick, hits: bs.render.fx().shake.hits, death: bs.state().death };
  });
  expect(end.death, 'the cell survives the burn').toBeNull();
  const perSecond = (end.hits - start.hits) / ((end.tick - start.tick) / 30);
  expect(
    perSecond,
    `${end.hits - start.hits} hits over ${end.tick - start.tick} ticks`,
  ).toBeGreaterThanOrEqual(1);
  expect(perSecond).toBeLessThanOrEqual(3);
});

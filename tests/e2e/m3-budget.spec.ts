import { expect, type Page, test } from '@playwright/test';
import type { BsHook } from '../../src/game/debug';
import { genomeHash, genomeToBase64url } from '../../src/genome/codec';
import { genesisGenome } from '../../src/genome/genesis';
import { seedFromString } from '../../src/sim/prng';
import { tinted, worstBody } from '../worst-body';
import { hatch, openGame, playerOf } from './helpers';

// The render budget with many bodies (M3 T18), read from `renderer.info`. CI renders in software,
// so only draw calls, triangles and GPU resources are asserted, never frame times.

const render = (page: Page) => page.evaluate(() => (window.__bs as BsHook).render.info());

async function setRemotes(
  page: Page,
  genomes: string[],
  biomass: number,
  prefix = 'r',
): Promise<void> {
  const { x, y } = await playerOf(page);
  await page.evaluate(
    ({ genomes, biomass, prefix, x, y }) => {
      (window.__bs as BsHook).debug?.setRemotes(
        genomes.map((genome, i) => ({
          id: `${prefix}${i}`,
          name: `R${i}`,
          genome,
          biomass,
          x: x + 60 + (i % 6) * 40,
          y: y + 30 + Math.floor(i / 6) * 40,
        })),
      );
    },
    { genomes, biomass, prefix, x, y },
  );
}

const bodies = (page: Page, n: number) =>
  page.waitForFunction((n) => (window.__bs as BsHook).render.info().remoteBodies === n, n, {
    timeout: 20_000,
  });

test('24 maximal bodies with different tints stay within the medium budget', async ({ page }) => {
  const { genome } = worstBody();
  const copies = tinted(genome, 24);
  expect(new Set(copies.map(genomeHash)).size).toBe(24);
  const texts = copies.map(genomeToBase64url);
  await openGame(page, `?debug=1&seed=budget&genome=${texts[0]}`);
  await hatch(page);
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
  const alone = await render(page);

  await setRemotes(page, texts.slice(1), 400);
  await bodies(page, 23);
  const full = await render(page);
  // Each creature costs one draw call (other draws move a little between frames).
  expect(full.calls - alone.calls).toBeGreaterThanOrEqual(23);
  expect(full.calls).toBeLessThanOrEqual(150);
  expect(full.triangles).toBeLessThanOrEqual(300_000);
  expect(full.creatureAssets).toBeLessThanOrEqual(24);
  console.log(`24 maximal bodies: ${full.calls} calls, ${full.triangles} triangles`);
});

test('200 bodies over 50 genomes added and removed leave no GPU resource behind', async ({
  page,
}) => {
  await openGame(page, '?debug=1&seed=budget-dispose');
  await hatch(page);
  await page.waitForFunction(() => (window.__bs as BsHook).render.info().playerBody);
  const genomes = Array.from({ length: 50 }, (_, i) =>
    genomeToBase64url(genesisGenome(seedFromString(`dispose-${i}`))),
  );
  const baseline = await render(page);

  let added = 0;
  let peak = 0;
  for (let round = 0; added < 200; round++) {
    const batch = Array.from(
      { length: Math.min(24, 200 - added) },
      (_, i) => genomes[(added + i) % genomes.length] as string,
    );
    await setRemotes(page, batch, 150, `round${round}-`);
    await bodies(page, batch.length);
    added += batch.length;
    peak = Math.max(peak, (await render(page)).creatureAssets);
  }
  // A full round of 24 distinct bodies held 24 geometries beside the player's own.
  expect(peak).toBeGreaterThanOrEqual(baseline.creatureAssets + 20);

  await setRemotes(page, [], 150);
  await bodies(page, 0);
  await page.waitForFunction(
    (base) => {
      const info = (window.__bs as BsHook).render.info();
      return (
        info.memory.geometries === base.geometries &&
        info.memory.textures === base.textures &&
        info.creatureAssets === base.assets
      );
    },
    {
      geometries: baseline.memory.geometries,
      textures: baseline.memory.textures,
      assets: baseline.creatureAssets,
    },
    { timeout: 20_000 },
  );
});

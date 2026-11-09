import { expect, type Page, type TestInfo, test } from '@playwright/test';
import { DEFICIENCIES, pixelSimulator } from '../../src/game/colour-vision';
import type { BsHook } from '../../src/game/debug';
import { genomeToBase64url } from '../../src/genome/codec';
import { genesisGenome } from '../../src/genome/genesis';
import { rarityOf } from '../../src/genome/rarity';
import { seedFromString } from '../../src/sim/prng';
import { hatch, hudCover, openGame, state } from './helpers';
import { decodePng, encodePng } from './png';

// Colour never alone (M14 T9): the cues that carry meaning, each shot as drawn and as someone with
// protanopia, deuteranopia or tritanopia sees it (Machado et al. 2009, simulated in Node), attached
// side by side (`m14-colour-*`). The bars wear their glyphs, low energy hollows the bolt, a damage
// hit cracks the health cross, and the HUD keeps within 6% of the screen. Practice cells, no hub.

test.use({ viewport: { width: 960, height: 540 } });

/** Attaches the shot and its three simulations. */
async function attachSeen(info: TestInfo, name: string, png: Buffer): Promise<void> {
  await info.attach(`m14-colour-${name}`, { body: png, contentType: 'image/png' });
  for (const d of DEFICIENCIES) {
    const image = decodePng(png);
    pixelSimulator(d)(image.data);
    await info.attach(`m14-colour-${name}-${d}`, {
      body: encodePng(image),
      contentType: 'image/png',
    });
  }
}

/** Each bar's glyph and whether its parts show, read in one frame. */
const glyphs = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.hud .stat')].map((stat) => {
      const svg = stat.querySelector('svg');
      const crack = stat.querySelector('.crack');
      const shape = svg?.querySelector('path, circle');
      return {
        stat: stat.dataset.testid,
        glyph: svg?.dataset.glyph ?? null,
        shown: stat.checkVisibility() && (svg?.getBoundingClientRect().width ?? 0) > 0,
        fill: shape ? getComputedStyle(shape).fill : null,
        crack: crack ? getComputedStyle(crack).display !== 'none' : null,
        hurt: stat.hasAttribute('data-hurt'),
        low: stat.hasAttribute('data-low'),
      };
    }),
  );

test('the bars wear their glyphs; low energy hollows the bolt and a hit cracks the cross', async ({
  page,
}, info) => {
  // Under Reduce motion the hurt bar doesn't flash, so its look holds while a hit's flash lasts.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openGame(page, '?debug=1&seed=m14-colour-hud');
  await hatch(page);
  const bars = await glyphs(page);
  expect(bars.map((b) => [b.stat, b.glyph])).toEqual([
    ['hud-bar-health', 'cross'],
    ['hud-bar-energy', 'bolt'],
    ['hud-bar-size', 'grow'],
    ['hud-bar-life', 'hourglass'],
  ]);
  // A practice cell has no lifespan: the life bar is hidden, the other three show their glyph.
  expect(bars.map((b) => b.shown)).toEqual([true, true, true, false]);
  const energy = () => glyphs(page).then((b) => b[1]);
  const solid = (await energy())?.fill;
  expect(solid).not.toBe('none');

  // Low energy: the bolt goes hollow (a shape, beside the pulse and the sound).
  await page.evaluate(() => (window.__bs as BsHook).debug?.setEnergy(1));
  await expect.poll(async () => (await energy())?.low).toBe(true);
  expect((await energy())?.fill).toBe('none');

  // A plume's hits: while one's flash lasts the health cross is cracked, else whole.
  const health = () => glyphs(page).then((b) => b[0]);
  expect((await health())?.crack).toBe(false);
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    const { x, y } = bs.state().player ?? { x: 0, y: 0 };
    bs.debug?.spawnPlume(x, y, 200);
    bs.debug?.setEnergy(1);
  });
  // Hits land every 0.5 s and flash for 0.3: a shot taken with the hit showing before and after it.
  let shot: Buffer | null = null;
  for (let i = 0; i < 20 && !shot; i++) {
    const before = await health();
    const png = await page.screenshot();
    const after = await health();
    if (before?.hurt && after?.hurt) {
      expect(before.crack && after.crack).toBe(true);
      shot = png;
    }
  }
  if (!shot) throw new Error('no shot while a hit showed');
  expect((await energy())?.low, 'energy still low in the shot').toBe(true);
  await attachSeen(info, 'hud', shot);
  expect((await hudCover(page)).share).toBeLessThanOrEqual(0.06);
});

test('outlines for a bigger and a smaller creature, and every ping kind on the minimap', async ({
  page,
}, info) => {
  await openGame(page, '?debug=1&seed=m14-colour-world');
  await hatch(page);
  // The player grows to tier 1 (1,024 biomass and up), so one remote (200) can be a tier smaller
  // and another (20,000, tier 2) a tier bigger.
  await page.evaluate(() => (window.__bs as BsHook).debug?.setBiomass(1100));
  await page.evaluate(() => {
    const hook = window.__bs as BsHook;
    const player = hook.state().player;
    if (!player) throw new Error('not playing');
    const { pxPerWu } = hook.render.info();
    hook.debug?.setRemotes(
      [
        { id: 'peer-0', name: 'Small', biomass: 200, dx: 220, dy: 60 },
        { id: 'peer-1', name: 'Big', biomass: 20_000, dx: -280, dy: 40 },
        { id: 'peer-2', name: 'Three', biomass: 1100, dx: 0, dy: -170 },
        { id: 'peer-3', name: 'Four', biomass: 1100, dx: 0, dy: 170 },
      ].map((r) => ({
        id: r.id,
        name: r.name,
        biomass: r.biomass,
        x: player.x + r.dx / pxPerWu,
        y: player.y + r.dy / pxPerWu,
      })),
    );
  });
  const outlines = () =>
    page.evaluate(() =>
      (window.__bs as BsHook).render
        .outlines()
        .map((o) => [o.id, o.kind])
        .sort(),
    );
  await expect.poll(outlines, { timeout: 10_000 }).toEqual([
    ['peer-0', 'smaller'],
    ['peer-1', 'bigger'],
  ]);
  // Each ping kind from its own peer, around the player.
  await page.evaluate(() => {
    const bs = window.__bs as BsHook;
    const { x, y } = bs.state().player ?? { x: 0, y: 0 };
    for (let kind = 0; kind < 4; kind++) {
      const a = (kind * Math.PI) / 2 + 0.4;
      bs.debug?.deliver(`peer-${kind}`, {
        t: 'ping',
        kind,
        x: x + 300 * Math.cos(a),
        y: y + 300 * Math.sin(a),
      });
    }
  });
  await expect
    .poll(async () => (await state(page)).minimap.pings.length, { timeout: 5_000 })
    .toBe(4);
  await attachSeen(info, 'world', await page.screenshot());
  await attachSeen(info, 'minimap', await page.locator('.minimap').screenshot());
  expect((await hudCover(page)).share).toBeLessThanOrEqual(0.06);
});

test('a rare result card names its tier in words and stars', async ({ page }, info) => {
  // The first genesis body of these seeds that comes out rare.
  let genome = '';
  for (let i = 0; i < 2000 && !genome; i++) {
    const g = genesisGenome(seedFromString(`m14-colour-rare-${i}`));
    if (rarityOf(g).tier === 'rare') genome = genomeToBase64url(g);
  }
  expect(genome, 'a rare genesis body').not.toBe('');
  await openGame(page, `?debug=1&seed=m14-colour-card&genome=${genome}`);
  await hatch(page);
  await page.evaluate(() => (window.__bs as BsHook).debug?.showCard());
  await expect
    .poll(async () => (await state(page)).egg.card, { timeout: 5_000 })
    .toEqual({ shown: true, tier: 'rare' });
  const card = page.getByTestId('reveal-card');
  await expect(page.getByTestId('reveal-rarity')).toHaveText(/rare/i);
  await expect(page.getByTestId('reveal-stars')).toHaveAttribute('aria-label', /3/);
  await attachSeen(info, 'card', await card.screenshot());
});
